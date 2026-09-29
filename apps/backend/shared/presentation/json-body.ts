import { z } from "zod";
import type { ErrorKey } from "../domain/error-key";
import {
  type ErrorIssue,
  type InvalidRequestArgs,
  InvalidRequestError,
} from "./http-error";

// リクエスト本文のスキーマの土台。各 API は項目ごとの型だけを渡す（error は書かない）。
//   例: requestBodySchema({ title: z.string() })
// WHY 未知のキーを拒否する（z.strictObject）: 部分更新（PUT /api/todos/:id）で項目名を打ち間違えた本文
//   （{ complete: true }）を z.object のように黙って捨てると、「何も変えない」200 になり誤りに気づけない。
//   画面と API は同じリポジトリで同時に変えるので、古いクライアントが知らない項目を送ってくる互換性の心配も無い。
// WHY error（文言）をどこにも書かない（Issue #116）: 誤りは ErrorKey と params で返し、文言は画面が翻訳する。
//   キーは zod の issue の種類（code・expected）と path から toErrorIssue が 1 か所で決める。各 api ファイルや
//   ここで zod の error にキーを書くと、同じ対応（文字列の項目 → request.field.notString）を項目ごとに書くことになる。
//   オブジェクトの判定（配列・null・文字列を弾く）も zod に任せる（以前の手書きの typeof の判定は Issue #88 で消した）。
// WHY 関数にする（スキーマを最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に作れば、条件の変異を
//   テストで検出できる（Issue #55）。各 api ファイルのスキーマも同じ理由で関数にしている。
export function requestBodySchema<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject(shape);
}

// リクエスト本文を JSON として読み、schema（リクエストの「形」）で parse した値を返す。
// WHY 以前の readJsonObject（オブジェクトかだけを確かめて Record<string, unknown> を返す）を zod に統合した:
//   形の検査を 1 回の safeParse にまとめ、結果の型をスキーマから導出する（as や項目ごとの typeof を書かない）。
//   JSON として読めるかだけは zod の前の段階（request.json()）なので、ここで InvalidRequestError にする。
// WHY 形だけを見る: 値の中身の規則（title の長さなど）は domain の不変条件（.claude/rules/backend.md の「presentation」）。
export async function parseJsonBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<z.output<Schema>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // request.json() は JSON として読めないと SyntaxError を投げる。クライアントの誤りなので 400 にする。
    throw new InvalidRequestError("request.body.notJson");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map(toErrorIssue);
    // WHY key と params は最初の issue: ErrorResponse の key 1 つだけを翻訳する画面でも、何を直せばよいかが分かる。
    //   失敗した safeParse の issues は必ず 1 件以上ある。
    // WHY as: ErrorIssue の型は key と params の対応を持たない（画面との契約の型で、key ごとの形までは縛らない）。
    //   組は toErrorIssue が key ごとに正しく作っているので、コンストラクタの「key ごとの params」の型に合わせて渡し直す。
    const [first] = issues;
    throw new InvalidRequestError(
      first.key,
      ...([first.params, issues] as InvalidRequestArgs<ErrorKey>),
    );
  }
  return result.data;
}

// zod の issue 1 件を、クライアントに返す { path, key, params } にする。zod の issue から ErrorKey を決める対応はここだけに書く。
//   - unrecognized_keys（z.strictObject の未知の項目）→ request.body.unknownKeys（params.keys は項目名を ", " で連結）
//   - invalid_type で path が空（本文全体がオブジェクトでない。配列・null・文字列・数値）→ request.body.notObject
//   - invalid_type で文字列を期待した項目（無い・null・数値など）→ request.field.notString（params.path）
//   - invalid_type で真偽値を期待した項目 → request.field.notBoolean（params.path）
// WHY 対応の無い issue は例外（InvalidRequestError ではない Error = 500）にする: キーの集合（error-key.ts）は画面の辞書と
//   共有する閉じた集合で、無理に近いキーに寄せると画面が誤った文言を出す。数値の項目などを足したときに、キーと対応を
//   足し忘れたことをテスト（API は 500）で気づかせる。今の API のスキーマ（文字列・真偽値・strictObject）では起きない。
// WHY path を join(".") で文字列にする: JSON の本文から来る path はオブジェクトのキー（文字列）と配列の添字（数値）だけで、
//   zod の path に入りうる symbol は現れない。
function toErrorIssue(issue: z.core.$ZodIssue): ErrorIssue {
  const path = issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    return {
      path,
      key: "request.body.unknownKeys",
      params: { keys: issue.keys.join(", ") },
    };
  }
  if (issue.code === "invalid_type") {
    if (issue.path.length === 0) {
      return { path, key: "request.body.notObject" };
    }
    if (issue.expected === "string") {
      return { path, key: "request.field.notString", params: { path } };
    }
    if (issue.expected === "boolean") {
      return { path, key: "request.field.notBoolean", params: { path } };
    }
  }
  throw new Error(
    `no ErrorKey for zod issue: ${JSON.stringify({ code: issue.code, path })}`,
  );
}

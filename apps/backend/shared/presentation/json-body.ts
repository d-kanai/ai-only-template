import { z } from "zod";
import { type ErrorIssue, InvalidRequestError } from "./http-error";

// リクエスト本文のスキーマの土台。各 API は項目ごとの型（と message）だけを渡す。
//   例: requestBodySchema({ title: z.string({ error: "title は文字列で指定してください" }) })
// WHY 未知のキーを拒否する（z.strictObject）: 部分更新（PUT /api/todos/:id）で項目名を打ち間違えた本文
//   （{ complete: true }）を z.object のように黙って捨てると、「何も変えない」200 になり誤りに気づけない。
//   画面と API は同じリポジトリで同時に変えるので、古いクライアントが知らない項目を送ってくる互換性の心配も無い。
// WHY 本文全体の誤り（オブジェクトでない・未知の項目）の message をここで決める: 全 API で同じ文言にそろえ、
//   各 api ファイルには項目ごとの message だけを書く。zod の既定の message は英語で、画面にそのまま出せない。
//   オブジェクトの判定（配列・null・文字列を弾く）も zod に任せる（以前の手書きの typeof の判定は Issue #88 で消した）。
// WHY 関数にする（スキーマを最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に作れば、message や条件の変異を
//   テストで検出できる（Issue #55）。各 api ファイルのスキーマも同じ理由で関数にしている。
export function requestBodySchema<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.strictObject(shape, {
    // z.strictObject 自身が出す issue は「オブジェクトでない」（invalid_type）と「未知の項目」（unrecognized_keys）の 2 種類。
    //   項目の誤りは各項目のスキーマの error が決める（ここは呼ばれない）。
    error: (issue) =>
      issue.code === "unrecognized_keys"
        ? `定義されていない項目は指定できません（${issue.keys.join(", ")}）`
        : "リクエスト本文は JSON のオブジェクトで指定してください",
  });
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
    throw new InvalidRequestError("リクエスト本文が JSON ではありません");
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = toErrorIssues(result.error.issues);
    // WHY message は最初の issue: ErrorResponse の message 1 つだけを表示する画面でも、何を直せばよいかが分かる。
    //   失敗した safeParse の issues は必ず 1 件以上ある。
    throw new InvalidRequestError(issues[0].message, issues);
  }
  return result.data;
}

// WHY path を join(".") で文字列にする: JSON の本文から来る path はオブジェクトのキー（文字列）と配列の添字（数値）だけで、
//   zod の path に入りうる symbol は現れない。
function toErrorIssues(issues: z.core.$ZodIssue[]): ErrorIssue[] {
  return issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

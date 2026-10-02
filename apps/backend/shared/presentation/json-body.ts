import { z } from "zod";
import { type ErrorKey, ErrorKeys } from "../domain/error-key";
import {
  type InvalidRequestArgs,
  InvalidRequestError,
  type ProblemErrorInput,
} from "./problem";

// リクエスト本文のスキーマの土台（schema）と、本文の読み取り・検査（parse）。
// WHY クラスの static メソッドにする: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。状態を持たない変換なので static にする。
export class RequestBody {
  // リクエスト本文のスキーマの土台。各 API は項目ごとの型を渡し（型の検査の error は書かない）、必要なら domain と同じ規則
  //   （必須・長さ）を domain と同じキーで重ねる（KeyedIssue.of / KeyedIssue.refine。Issue #144）。
  //   例: RequestBody.schema({ title: z.string() })
  // WHY 未知のキーを拒否する（z.strictObject）: 項目名を打ち間違えた本文（{ complete: true }）や、別の API の項目
  //   （PUT /api/todos/:id/title に completed）を z.object のように黙って捨てると、送った変更が反映されないまま成功し、誤りに気づけない。
  //   画面と API は同じリポジトリで同時に変えるので、古いクライアントが知らない項目を送ってくる互換性の心配も無い。
  // WHY error（文言）をどこにも書かない（Issue #116）: 誤りは ErrorKey と params で返し、文言は画面が翻訳する。
  //   形の誤りのキーは zod の issue の種類（code・expected）と path から toProblemError が 1 か所で決める。各 api ファイルや
  //   ここで zod の型の検査の error にキーを書くと、同じ対応（文字列の項目 → request.field.notString）を項目ごとに書くことになる。
  //   domain と同じ規則を重ねる検査（refine）だけは、KeyedIssue.of / KeyedIssue.refine で domain と同じキーを付ける（toProblemError が
  //   そのキーを使う）。
  //   オブジェクトの判定（配列・null・文字列を弾く）も zod に任せる（以前の手書きの typeof の判定は Issue #88 で消した）。
  // WHY メソッドにする（スキーマを最上位の定数・static フィールドにしない）: 最上位の式と static フィールドの初期化は読み込み時に
  //   だけ評価される static な変異になり、mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に
  //   作れば、条件の変異をテストで検出できる（Issue #55）。各 api ファイルのスキーマも同じ理由でメソッドにしている。
  static schema<Shape extends z.ZodRawShape>(shape: Shape) {
    return z.strictObject(shape);
  }

  // リクエスト本文を JSON として読み、schema（リクエストの「形」）で parse した値を返す。
  // WHY 以前の readJsonObject（オブジェクトかだけを確かめて Record<string, unknown> を返す）を zod に統合した:
  //   形の検査を 1 回の safeParse にまとめ、結果の型をスキーマから導出する（as や項目ごとの typeof を書かない）。
  //   JSON として読めるかだけは zod の前の段階（request.json()）なので、ここで InvalidRequestError にする。
  // WHY 値の中身の規則を持つかはスキーマ次第: 形（JSON・オブジェクト・未知の項目・型）は必ずここで見る。必須・長さは各 api の
  //   スキーマが domain と同じキー・同じ定数で重ねてよい（domain より厳しくしない。domain は常に完全に検証する。Issue #144。
  //   .claude/rules/backend.md の「presentation」）。重ねると、項目ごとの誤りを 1 回の応答（errors）でまとめて返せる。
  static async parse<Schema extends z.ZodType>(
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
      const errors = result.error.issues.map(RequestBody.toProblemError);
      // WHY key と params は最初の誤り: Problem の key 1 つだけを翻訳する画面でも、何を直せばよいかが分かる。
      //   失敗した safeParse の issues（zod の誤りの一覧）は必ず 1 件以上ある。
      // WHY as: ProblemErrorInput の型は key と params の対応を持たない（画面との契約の型で、key ごとの形までは縛らない）。
      //   組は toProblemError が key ごとに正しく作っているので、コンストラクタの「key ごとの params」の型に合わせて渡し直す。
      const [first] = errors;
      throw new InvalidRequestError(
        first.key,
        ...([first.params, errors] as InvalidRequestArgs<ErrorKey>),
      );
    }
    return result.data;
  }

  // zod の issue 1 件を、クライアントに返す { pointer, key, params }（Problem の errors の要素。detail は problem.ts が足す）にする。
  //   zod の issue から ErrorKey を決める対応はここだけに書く。
  //   - message が ErrorKey（KeyedIssue.of / KeyedIssue.refine で付けた。Issue #144）→ そのキー（params は refine の params）
  //   - unrecognized_keys（z.strictObject の未知の項目）→ request.body.unknownKeys（params.keys は項目名を ", " で連結）
  //   - invalid_type で path が空（本文全体がオブジェクトでない。配列・null・文字列・数値）→ request.body.notObject
  //   - invalid_type で文字列を期待した項目（無い・null・数値など）→ request.field.notString（params.path）
  //   - invalid_type で真偽値を期待した項目 → request.field.notBoolean（params.path）
  // WHY キーの付いた issue を最初に見る: スキーマの宣言でキーを付けた検査は、その宣言がキーを決める（domain の DomainValidation.validated と同じ
  //   取り出し方）。型の検査の issue の message は zod の既定の英語で、ErrorKey にはならない（error を書かないので）。
  // WHY 対応の無い issue は例外（InvalidRequestError ではない Error = 500）にする: キーの集合（error-key.ts）は画面の辞書と
  //   共有する閉じた集合で、無理に近いキーに寄せると画面が誤った文言を出す。数値の項目などを足したときに、キーと対応を
  //   足し忘れたことをテスト（API は 500）で気づかせる。今の API のスキーマ（文字列・真偽値・strictObject）では起きない。
  // WHY params.path は join(".") の文字列のまま（pointer と別に持つ）: params は画面の辞書の文言に埋め込む値
  //   （"{path} は文字列で指定してください"）で、人が読む形（tags.1）がよい。機械が項目を指すのは pointer。
  //   JSON の本文から来る path はオブジェクトのキー（文字列）と配列の添字（数値）だけで、zod の path に入りうる symbol は現れない。
  private static toProblemError(issue: z.core.$ZodIssue): ProblemErrorInput {
    const pointer = RequestBody.toPointer(issue.path);
    const path = issue.path.join(".");
    if (ErrorKeys.includes(issue.message)) {
      // WHY as: zod の issue の params は refine の custom の issue だけが持ち（Record<string, any>）、キーとの対応を型で持たない。
      //   キーと params の組は KeyedIssue.of / KeyedIssue.refine が型で縛って作ったので、ここではそのまま返す（shared/domain/validate.ts の DomainValidation.validated と同じ）。
      const { params } = issue as { params?: ProblemErrorInput["params"] };
      return { pointer, key: issue.message, params };
    }
    if (issue.code === "unrecognized_keys") {
      return {
        pointer,
        key: "request.body.unknownKeys",
        params: { keys: issue.keys.join(", ") },
      };
    }
    if (issue.code === "invalid_type") {
      if (issue.path.length === 0) {
        return { pointer, key: "request.body.notObject" };
      }
      if (issue.expected === "string") {
        return { pointer, key: "request.field.notString", params: { path } };
      }
      if (issue.expected === "boolean") {
        return { pointer, key: "request.field.notBoolean", params: { path } };
      }
    }
    throw new Error(
      `no ErrorKey for zod issue: ${JSON.stringify({ code: issue.code, path })}`,
    );
  }

  // zod の path（項目名と配列の添字の並び）を、JSON Pointer（RFC 6901）の URI の fragment の形にする。
  //   例: [] → "#"（本文全体）、["title"] → "#/title"、["tags", 1] → "#/tags/1"
  // WHY JSON Pointer: RFC 9457 の 3 節の例（errors の pointer）と同じ形にし、本文の中の位置を標準の書き方で指す。
  // WHY 各項目名の ~ を ~0 に、/ を ~1 にする（この順序で）: RFC 6901 の 3 節。/ は区切りなので、そのままだと項目名 "a/b" と
  //   a の中の b を区別できない。/ を先に ~1 にすると、その ~ が次の置き換えで ~01 になる。
  // WHY パーセントエンコードはしない: fragment に使えない文字（空白など）は RFC 6901 の 6 節ではエンコードが要るが、項目名は
  //   スキーマで決めた英字の識別子（title・completed）で現れない。項目名に記号を使う API を足すときに見直す。
  private static toPointer(path: readonly PropertyKey[]): string {
    return ["#", ...path.map(RequestBody.escapePointerSegment)].join("/");
  }

  private static escapePointerSegment(segment: PropertyKey): string {
    return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  }
}

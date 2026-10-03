// 値の印（sensitive / freeText）と、印の無い文字列・例外の項目の形（Issue #216）。
// WHY log-event.ts から分けた（Issue #384）: 本番のコードは 1 ファイル 1 クラス（Biome の style/noExcessiveClassesPerFile）・
//   1 ファイル 300 行以内（style/noExcessiveLinesPerFile）にする。log-event.ts（種類の一覧とスキーマ）と同じく exports に
//   置かない内部のファイルで、apps/shared の中から相対パスで読む（.claude/rules/code/shared.md）。

import { z } from "zod";
import { FreeTextMask, MASK } from "./free-text-mask";

// log-event.ts の LOG_EVENT_SCHEMAS の組み立てに使う。
// WHY クラスの static メソッドにする（Issue #262）: apps/shared も最上位に関数を置かない（規則 class-based。ADR
//   docs/adr/architecture/20261002-class-based-shared-and-test-support.md）。状態を持たないので static。
// WHY LOG_EVENT_SCHEMAS より先に評価されるようにする: LOG_EVENT_SCHEMAS はモジュールの読み込み時にここのメソッドを呼ぶ。クラスの宣言は
//   function 宣言と違って巻き上げられず、後から評価されると初期化前の参照（ReferenceError）になる。Issue #384 で別のファイルに
//   分けた後は、log-event.ts がこのファイルを import する（import 先のモジュールは import した側より先に評価される）ことで保つ。
export class LogFieldMarks {
  // マスクの印 1: 値を常に *** にする（利用者の入力・利用者に由来するヘッダの値など、値そのものが個人情報になりうる項目）。
  //   null を残すときは外側に .nullable() を付ける（LogFieldMarks.sensitive(z.string()).nullable()。値が無いことは個人情報では
  //   ない。Issue #216 の既定の判断）。
  // WHY transform で置き換える（zod の .meta() で印を付けて logger が見る形にしない）: .meta() の印は .optional() などで包むと
  //   外側のスキーマに引き継がれず、logger から見えなくなる（Issue #216 の調査）。transform なら、どう包んでも parse の結果が必ず
  //   *** になり、印の読み落としが起きない。
  // WHY 包んだスキーマの検査を残す（z.any() にしない）: 形の違う値（文字列のはずの項目に数値など）は parse の失敗にし、呼び出し側の
  //   取り違えを logger_error の行で気づけるようにする。
  static sensitive<T extends z.ZodType>(schema: T) {
    return schema.transform((): typeof MASK => MASK);
  }

  // マスクの印 2: 自由文（例外の message など、決まった形の無い文）。値は出すが、FreeTextMask.mask の正規表現で既知の形の
  //   個人情報・秘密を *** にする（最後の網）。
  // WHY 自由文にだけ使う（全項目に正規表現をかけない）: 正規表現は見逃し・誤検知があり、値を出すかどうかの主な判断はスキーマの
  //   一覧（allowlist）と sensitive の印で行う。形の決まった項目（id・表名など）に正規表現をかけても得るものが無い。
  static freeText() {
    return z.string().transform((text) => FreeTextMask.mask(text));
  }

  // 長さの上限を付けた文字列（印の無い項目）。
  static bounded() {
    return z.string().transform((value) => LogFieldMarks.bound(value));
  }

  // 自由文の網を通し、さらに長さの上限を付けた文字列（パス・クエリのキー）。
  // WHY 網の後に切る: 先に切ると、途中で切れたメールアドレスなどが網に一致せず断片が出る。
  static boundedFreeText() {
    return LogFieldMarks.freeText().transform((value) =>
      LogFieldMarks.bound(value),
    );
  }

  // 例外の項目（error）の形: { type, message }。message は自由文。
  // WHY Error を { type, message } にする: Error の name / message は列挙できないプロパティで、そのまま parse・JSON にすると
  //   空になる。名前は OTel semconv の exception.type / exception.message、ECS の error.type / error.message と同じにする。
  // WHY stack は出さない（スキーマに無い）: 1 行が長くなり、サーバのファイルのパスなど内部の情報も含むため。
  // WHY Error でない値は { type: typeof } にする（値を出さない）: throw は文字列・オブジェクトなど何でも投げられ、中身が何か
  //   分からない（利用者の入力を含みうる）。type（文字列）を持つオブジェクトだけはそのまま渡す（Writer が DB のエラーを
  //   { type: <pg のエラーの name>, message: <引用符の部分を *** にした pg の message> } で渡す。apps/backend/shared/drizzle/writer.ts）。
  // WHY 入力の型を unknown にする（z.preprocess）: 呼び出し側は catch で受けた unknown をそのまま渡す。変換は logger の中で行う。
  // WHY type も freeText: Error の name と { type } のオブジェクトの type は、投げた側が自由に決められる文字列（reviewer の指摘）。
  static error() {
    return z.preprocess(
      (value) => LogFieldMarks.toErrorShape(value),
      z.object({
        type: LogFieldMarks.freeText(),
        message: LogFieldMarks.freeText().optional(),
      }),
    );
  }

  private static toErrorShape(value: unknown): unknown {
    if (value instanceof Error) {
      return {
        type: value.name,
        message: LogFieldMarks.holdsQueryParameters(value)
          ? MASK
          : value.message,
      };
    }
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as { type?: unknown }).type === "string"
    ) {
      return value;
    }
    return { type: typeof value };
  }

  // 例外が SQL とパラメータ（query / params のプロパティ）を抱えているか。
  // WHY 抱えている例外の message を出さない（*** にする。Issue #216 の reviewer の指摘）: drizzle-orm 0.45.3 の DrizzleQueryError の
  //   message は「Failed query: <SQL>\nparams: <生の値>」（errors.js）で、利用者の値（todos.title など）を含む。Writer は db_write の
  //   行で params をマスクした後に同じ例外を投げ直すので、ProblemResponse.from の server_error にそのまま届く。呼び出し側に頼らず、
  //   どのライブラリの例外でも、クエリのパラメータを持つ例外の message は出さないほうに倒す（fail closed）。cause はスキーマに無く、
  //   今までどおり落ちる。
  // WHY クラス（instanceof DrizzleQueryError）でなくプロパティで見る: apps/shared は drizzle-orm を参照しない（規則
  //   shared-self-contained）。別のライブラリの同じ形の例外も同じに扱える。
  private static holdsQueryParameters(error: Error): boolean {
    return "query" in error || "params" in error;
  }

  // 印の無い文字列の項目の長さの上限（文字数）と、切ったときの印。
  // WHY 上限を付ける（reviewer の指摘）: x-request-id・host・accept・content-type・user-agent・パス・クエリのキーはクライアントが
  //   自由に決められ、長さの制限が無い。1 行の大きさ（費用・読みやすさ）を抑える。parse は失敗させない（行を失わない）。
  // WHY 2000 文字（自由文の上限）より短い 256: これらは自由文ではなく、正常な値は短い（UUID・ホスト名・MIME 型・UA の文字列）。
  private static bound(value: string): string {
    const maxLength = 256;
    return value.length > maxLength
      ? `${value.slice(0, maxLength)}${FreeTextMask.limit().marker}`
      : value;
  }
}

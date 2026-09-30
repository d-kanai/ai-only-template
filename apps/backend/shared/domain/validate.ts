import type { z } from "zod";
import { DomainError } from "./domain-error";
import {
  type ErrorKey,
  type ErrorKeyParams,
  type ErrorParamsArgs,
  isErrorKey,
} from "./error-key";

// zod のスキーマで検証し、違反なら DomainError(validation_error) を投げる。Entity の完全コンストラクタ（Todo など、
//   すべての Entity）が不変条件のスキーマと一緒に使う。
// WHY shared/domain に置く: Entity ごとに同じ「zod の issue → DomainError」の変換を持つと、キーの無い issue の扱い
//   （下の 500）が Entity ごとにずれる。変換は 1 か所にし、各 Entity はスキーマ（規則）だけを持つ。
// WHY ZodError をそのまま投げない: domain の外（presentation の toProblemResponse）は DomainError だけを見て 400 に変換する。
//   zod を使っていることを domain の外に漏らさない。
// WHY key と params は最初の issue: 失敗した safeParse の issues は必ず 1 件以上ある。Entity の規則は、同じ値で 1 つしか
//   失敗しないように書く（Todo の title の「空」と「長すぎ」は両立しない）ので、最初の 1 件がそのまま理由になる。
//   複数の項目が同時に違反するとき（id とタイトルなど）はスキーマの項目の順で最初のものになる。利用者の入力で
//   違反しうるのは 1 項目（タイトル）だけなので、1 件で足りる。
export function validate<Schema extends z.ZodType>(
  schema: Schema,
  value: z.input<Schema>,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    // WHY as: zod の issue の params は Record<string, any>（refine の custom の issue だけが持ち、型の検査の issue には
    //   無い）で、キーとの対応を型で持たない。キーと params の組はスキーマの宣言（keyedIssue / keyedRefine）が型で縛って
    //   作ったので、ここではそれを DomainError に戻すだけにする。
    const { message, params } = result.error.issues[0] as {
      message: string;
      params?: ErrorKeyParams[ErrorKey];
    };
    // WHY キーでない message を DomainError にしない: keyedIssue / keyedRefine を渡し忘れた検査では、message が zod の既定の
    //   英語の文言になる。それを key として返すと、画面の辞書に無いキーで API の契約（Problem Details の key）を破る。
    //   利用者の入力の誤り（400）ではなく実装の誤りなので、DomainError ではない Error にして presentation に 500 を返させ、
    //   ログ（message と cause の ZodError）で開発中に足し忘れに気づけるようにする。
    if (!isErrorKey(message)) {
      throw new Error(
        `zod issue has no ErrorKey (pass keyedIssue / keyedRefine to the schema): ${message}`,
        { cause: result.error },
      );
    }
    throw new DomainError(
      "validation_error",
      message,
      ...([params] as ErrorParamsArgs<ErrorKey>),
    );
  }
  return result.data;
}

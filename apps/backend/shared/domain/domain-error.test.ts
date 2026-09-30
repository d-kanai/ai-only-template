// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DomainError } from "./domain-error";

describe("DomainError", () => {
  // name はログやスタックトレースの先頭に出る。Error のままだと想定外の例外と見分けられない（domain-error.ts の WHY）。
  // message は開発者向け（キーと params の JSON）。自然言語は持たない（画面が key と params を翻訳する。Issue #116）。
  test("code・key・params を持ち、message はキーと params の JSON、name は DomainError になる", () => {
    const error = new DomainError("not_found", "todo.notFound", { id: "abc" });

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("not_found");
    expect(error.key).toBe("todo.notFound");
    expect(error.params).toEqual({ id: "abc" });
    expect(error.message).toBe('todo.notFound {"id":"abc"}');
    expect(error.name).toBe("DomainError");
  });

  test("params の無いキーは params を省略でき、params は undefined、message はキーだけになる", () => {
    const error = new DomainError("validation_error", "todo.title.empty");

    expect(error.key).toBe("todo.title.empty");
    expect(error.params).toBeUndefined();
    expect(error.message).toBe("todo.title.empty");
  });

  // 型の検査（pnpm typecheck の tsc -p apps/backend が見る）。@ts-expect-error の行がコンパイルエラーにならなければ、
  //   「unused @ts-expect-error」で typecheck が失敗する。実行時に投げないことも確かめる（関数は呼ばずに型だけを見る）。
  // WHY 型で縛る: キーごとの params の形（ErrorKeyParams）は画面の辞書が使う契約。params の渡し忘れ・余分な params を
  //   実行時ではなくコンパイル時に止める。
  test("params の要るキーに渡し忘れる・形を間違える、params の無いキーに渡すと、コンパイルエラーになる", () => {
    const typeOnly = () => [
      // @ts-expect-error todo.title.tooLong は { max: number } が必須
      new DomainError("validation_error", "todo.title.tooLong"),
      // @ts-expect-error todo.notFound の id は string（number は不可）
      new DomainError("not_found", "todo.notFound", { id: 1 }),
      // @ts-expect-error todo.notFound に無い項目は渡せない
      new DomainError("not_found", "todo.notFound", { id: "a", extra: "b" }),
      // @ts-expect-error todo.title.empty は params を持たない
      new DomainError("validation_error", "todo.title.empty", { max: 100 }),
      // @ts-expect-error ErrorKeyParams に無いキーは使えない
      new DomainError("validation_error", "todo.title.unknown"),
    ];

    expect(typeof typeOnly).toBe("function");
  });
});

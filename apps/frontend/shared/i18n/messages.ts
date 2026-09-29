import type { Locale } from "./locale";
import { en } from "./messages/en";
import { ja } from "./messages/ja";

// 辞書の型と、キー・params から文言を組み立てる関数（Issue #116。ライブラリを使わない i18n）。
// 画面からは use-t.ts の useT() が返す t を使う。ここの formatMessage を直接使うのは、キーが実行時の値のとき
// （サーバの ErrorResponse から来たキー。features/todo/api/api-error.ts）だけ。

// キーの一覧と placeholder の正は ja（messages/ja.ts の as const）。
export type Messages = typeof ja;
export type MessageKey = keyof Messages;

// 1 ロケールの辞書の形。en.ts が satisfies で使い、キーの過不足をコンパイルエラーにする。
export type Dictionary = Readonly<Record<MessageKey, string>>;

// 文言の "{name}" から placeholder の名前を取り出す型（"{max} 文字以内" → "max"、placeholder が無ければ never）。
// ${string} は最短で一致するので、先頭から順に 1 つずつ取り出し、残り（Rest）に再帰する。
type PlaceholderNames<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? Name | PlaceholderNames<Rest>
    : never;

// キー K の params の型。placeholder の名前ごとに文字列か数（置換では String() で文字列にする）。
export type MessageParams<K extends MessageKey> = {
  readonly [Name in PlaceholderNames<Messages[K]>]: string | number;
};

// t の key の後ろの引数。placeholder が無ければ引数なし、あれば params が必須。
// WHY [X] extends [never]: never の判定で条件型が分配されないよう、タプルで包む。
export type TranslateArgs<K extends MessageKey> = [
  PlaceholderNames<Messages[K]>,
] extends [never]
  ? []
  : [params: MessageParams<K>];

// 型付きの t。存在しないキー、params の渡し忘れ・余分・名前の違いをコンパイルエラーにする（messages.test.ts の型の検査）。
export type Translate = <K extends MessageKey>(
  key: K,
  ...args: TranslateArgs<K>
) => string;

// 実行時の params（サーバの ErrorResponse の params など、型で名前を決められないもの）。
export type RuntimeParams = Readonly<Record<string, string | number>>;

// WHY 関数の中で辞書を選ぶ（最上位の定数にしない）: 最上位の式は mutation testing で static な変異になり検査から外れる
//   （stryker.config.mjs の ignoreStatic。.claude/rules/testing.md）。
// WHY Record<Locale, Dictionary>: SUPPORTED_LOCALES にロケールを足したら、辞書を足すまでコンパイルエラーにする。
function dictionaryOf(locale: Locale): Dictionary {
  const dictionaries: Record<Locale, Dictionary> = { ja, en };
  return dictionaries[locale];
}

// キーの文言の {name} を params の値で置き換える。
// params に無い名前は {name} のまま残す（"undefined" や空文字に化けると、params の欠けに気づけないため）。
// WHY Object.hasOwn: params の継承したプロパティ（toString など）を値と取り違えない。
// WHY 置換をライブラリ（ICU MessageFormat など）にしない: 今の文言は単純な差し込みだけで、複数形や選択の構文が要らない。
export function formatMessage(
  locale: Locale,
  key: MessageKey,
  params: RuntimeParams = {},
): string {
  return dictionaryOf(locale)[key].replace(
    /\{(\w+)\}/g,
    (placeholder, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

// ロケールを固定した型付きの t を作る。画面では use-t.ts の useT() から使う。
export function createTranslator(locale: Locale): Translate {
  return (key, ...args) => formatMessage(locale, key, args[0]);
}

// サーバから届いた文字列が辞書のキーかを確かめる（features/todo/api/ が ErrorResponse を読むときに使う）。
// WHY Object.hasOwn: "toString" や "__proto__" のような Object.prototype の名前を、辞書のキーと取り違えない。
export function isMessageKey(value: string): value is MessageKey {
  return Object.hasOwn(ja, value);
}

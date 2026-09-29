"use client";

import { createContext, type ReactNode, use, useMemo } from "react";
import { DEFAULT_LOCALE, type Locale } from "./locale";

// 画面の i18n の仕組み（Issue #116 で作り、Issue #125 で 1 ファイルにまとめた）。ライブラリは使わない
//   （ADR docs/adr/architecture/20260929-i18n-without-library.md と 20260929-messages-colocated-per-screen.md）。
// 辞書は 1 つにまとめず、画面・部品ごとに隣の <name>.messages.ts に defineMessages({ ja, en }) で置く（colocation）。
//   共通（API のエラー ErrorKey と error.*）だけが shared/i18n/common.messages.ts にある。
// 使い方: 画面・部品は const t = useT(todoScreenMessages)（その辞書のキーだけを受け付ける型付きの t）。
//   キーが実行時の値（サーバの ErrorResponse から来たキー）のときだけ formatMessage を使う（features/todo/api/api-error.ts）。
//
// "use client": LocaleProvider（context）と useLocale / useT は Client Component でしか動かない。
//   app/layout.tsx（Server Component）がこのファイルから使うのは LocaleProvider だけ（ロケールの文字列だけを渡す）。
//   ほかの関数（defineMessages・formatMessage など）は Client Component の画面・hook・api/ からだけ呼ぶ。
//   Server Component から呼ぶと、"use client" のファイルの export はクライアントの参照になって呼べない。
// WHY 型・関数・Provider を 1 ファイルにする（Issue #125 のユーザー判断）: 以前は messages.ts（型と置換）・use-t.ts（hook）・
//   locale-provider.tsx（context）に分けていたが、どれも「辞書を引いて文言にする」1 つの仕組みで、ファイルを行き来しないと
//   読めなかった。ロケールの判定（locale.ts）と日時の表示（format.ts）は、Proxy（Edge）やテストから React なしで使うので分ける。

// --- 型 ---

// 1 ロケールの辞書（キー → 文言）。キーは dot 区切りの 1 つの文字列で、平坦なオブジェクト（入れ子にしない）。
// WHY 平坦: サーバの ErrorKey（"todo.title.tooLong"）をそのまま 1 つの文字列で引け、型の導出も単純になる。
export type Dictionary = Readonly<Record<string, string>>;

// defineMessages が返す辞書の形。ja がキーの一覧と placeholder の正で、en は同じキーを持つ。
// WHY Record<Locale, ...> ではなく ja / en を書く: ja だけを「正」（文字列リテラルの型）として扱い、en はそれに合わせる側にするため。
//   SUPPORTED_LOCALES にロケールを足したら、ここと defineMessages に足す（formatMessage の messages[locale] が型エラーになる）。
export type Messages<J extends Dictionary = Dictionary> = {
  readonly ja: J;
  readonly en: Readonly<Record<keyof J, string>>;
};

// 辞書のキー。
// WHY & string: keyof は number / symbol も含みうる型なので、t の key に渡せる文字列に絞る。
export type MessageKey<M extends Messages> = keyof M["ja"] & string;

// 文言の "{name}" から placeholder の名前を取り出す型（"{max} 文字以内" → "max"、placeholder が無ければ never）。
// ${string} は最短で一致するので、先頭から順に 1 つずつ取り出し、残り（Rest）に再帰する。
type PlaceholderNames<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? Name | PlaceholderNames<Rest>
    : never;

type JaTextOf<M extends Messages, K extends MessageKey<M>> = M["ja"][K];

// キー K の params の型。placeholder の名前ごとに文字列か数（置換では String() で文字列にする）。
export type MessageParams<M extends Messages, K extends MessageKey<M>> = {
  readonly [Name in PlaceholderNames<JaTextOf<M, K>>]: string | number;
};

// t の key の後ろの引数。placeholder が無ければ引数なし、あれば params が必須。
// WHY [X] extends [never]: never の判定で条件型が分配されないよう、タプルで包む。
export type TranslateArgs<M extends Messages, K extends MessageKey<M>> = [
  PlaceholderNames<JaTextOf<M, K>>,
] extends [never]
  ? []
  : [params: MessageParams<M, K>];

// 辞書 M の型付きの t。M に無いキー（別の画面の辞書のキーを含む）、params の渡し忘れ・余分・名前の違いをコンパイルエラーにする
//   （i18n.test.tsx の型の検査）。
export type Translate<M extends Messages> = <K extends MessageKey<M>>(
  key: K,
  ...args: TranslateArgs<M, K>
) => string;

// 実行時の params（サーバの ErrorResponse の params など、型で名前を決められないもの）。
export type RuntimeParams = Readonly<Record<string, string | number>>;

// --- defineMessages（辞書の定義） ---

// 空白だけ（空文字を含む）の文言か。空白を 1 文字ずつ取り除いて "" になれば true。
// WHY: 文言を書き忘れた辞書（"" や " "）は、画面に何も出ないのに型もテストも通ってしまうため、型で止める。
// WHY 全角の空白（U+3000）と \r も空白に数える（Issue #125 の reviewer 指摘）: 日本語の入力では全角の空白だけの文言を書きうる。
//   \r は Windows の改行（\r\n）を貼り付けたときに混ざる。どちらも画面には何も出ない。
type IsBlank<S extends string> = S extends ""
  ? true
  : S extends
        | ` ${infer Rest}`
        | `\u3000${infer Rest}`
        | `\n${infer Rest}`
        | `\r${infer Rest}`
        | `\t${infer Rest}`
    ? IsBlank<Rest>
    : false;

// 文字列 S の 1 文字ずつの union（"ab" → "a" | "b"）。
// WHY 集めた文字を Acc で渡す（Head | CharsOf<Rest> にしない）: 末尾再帰の形にしないと、63 文字で TypeScript の
//   再帰の深さの上限（TS2589「Type instantiation is excessively deep」）に当たる（実測）。
type CharsOf<
  S extends string,
  Acc = never,
> = S extends `${infer Head}${infer Rest}` ? CharsOf<Rest, Acc | Head> : Acc;

// placeholder の名前に使える 1 文字（英数字と _）。formatMessage の置換 /\{(\w+)\}/ の \w と同じ集合（u フラグが無いので ASCII だけ）。
// WHY 文字列から作る（63 個の union を並べない）: 並べると Biome の format で 1 行 1 文字になり、集合が読み取りにくい。
type PlaceholderNameChar =
  CharsOf<"_0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ">;

// 1 文字以上で、すべてが PlaceholderNameChar の文字列か（\w+ に当たるか）。空文字は false（{} は置き換わらない）。
type IsPlaceholderName<S extends string> =
  S extends `${infer Head}${infer Rest}`
    ? Head extends PlaceholderNameChar
      ? Rest extends ""
        ? true
        : IsPlaceholderName<Rest>
      : false
    : false;

// 文言の {...} のうち、名前が \w+ でないもの（"{a-b}"・"{}"・"{ max }"）があるか。
// WHY 型で止める（Issue #125 の reviewer 指摘）: PlaceholderNames は { と } の間の任意の文字列を名前として取り出すが、
//   実行時の置換（formatMessage）は \w+ だけを置き換える。"{a-b}" は型では params の a-b を要求するのに、実行時には
//   置き換わらずに {a-b} のまま画面に出る。型と実行時の名前の規則を 1 つにそろえるため、\w+ 以外の {...} を書けなくする。
//   PlaceholderNames と同じく先頭から 1 つずつ見る（{ の後の最初の } までを 1 つの {...} とする）。対にならない { や } は
//   {...} にならないので書ける。
type HasInvalidPlaceholder<S extends string> =
  S extends `${string}{${infer Name}}${infer Rest}`
    ? IsPlaceholderName<Name> extends true
      ? HasInvalidPlaceholder<Rest>
      : true
    : false;

// 辞書に書けない文言か: 文字列リテラルの型でない（string）、空白だけ、名前が \w+ でない {...} を含む。
// WHY string を止める（Issue #125 の reviewer 指摘）: as const の無い変数（const s: string）を渡すと、const の型引数でも
//   型は string のままになり、空かどうかも placeholder の名前も型で分からない（PlaceholderNames<string> は never なので、
//   t は params を受け取らない型になる）。検査をすり抜けるので、文言は文字列リテラルで書かせる。
type IsInvalidText<S extends string> = string extends S
  ? true
  : IsBlank<S> extends true
    ? true
    : HasInvalidPlaceholder<S>;

// 2 つの文言の placeholder の名前の集合が同じか（順番は問わない。言語によって語順が変わるため）。
type SamePlaceholders<A extends string, B extends string> = [
  PlaceholderNames<A>,
] extends [PlaceholderNames<B>]
  ? [PlaceholderNames<B>] extends [PlaceholderNames<A>]
    ? true
    : false
  : false;

// ja の検査: 書けない文言（IsInvalidText。string 型・空白だけ・名前が \w+ でない {...}）を never にする
//   （never に文字列は代入できないので、その行がコンパイルエラーになる）。
type CheckedJa<J extends Dictionary> = {
  readonly [K in keyof J]: IsInvalidText<J[K]> extends true ? never : J[K];
};

// en の検査: ja に無いキー（余分）、placeholder の集合が ja と違う文言、書けない文言（IsInvalidText）を never にする。
//   en のキーの欠けは、型引数 E の制約（Record<keyof J, string>）で止まる。
//   en の {...} の名前は、ja の名前（CheckedJa で \w+ に限った）と集合が同じことで \w+ に限られる。
// WHY never で止める（エラー用のメッセージの型にしない）: エラーの位置が en の該当キーの行になり、どのキーが悪いかは分かる。
type CheckedEn<J extends Dictionary, E extends Dictionary> = {
  readonly [K in keyof E]: K extends keyof J
    ? SamePlaceholders<J[K], E[K]> extends true
      ? IsInvalidText<E[K]> extends true
        ? never
        : E[K]
      : never
    : never;
};

// 画面・部品の辞書を定義する（<name>.messages.ts で `export const xMessages = defineMessages({ ja: {...}, en: {...} })`）。
// ja をキーの一覧と placeholder の正にし、en のキーの過不足、placeholder の名前の不一致、空の文言をコンパイルエラーにする。
// WHY const の型引数: 呼び出し側に as const を書かせずに、ja の文言を文字列リテラルの型にする（placeholder の名前を型で取り出すため）。
//   en も文字列リテラルの型にして、ja と placeholder の集合を比べる。
// WHY J & CheckedJa<J>（E も同じ）: 型引数を推論したうえで、その型から作った検査の型と交差させ、違反する値だけを never にする。
// WHY 実行時には何もしない（渡したものを返すだけ）: 検査は型だけで足りる。実行時の検査を置くと、同じことを 2 か所で決めることになる。
export function defineMessages<
  const J extends Dictionary,
  const E extends Readonly<Record<keyof J, string>>,
>(messages: {
  readonly ja: J & CheckedJa<J>;
  readonly en: E & CheckedEn<J, E>;
}): Messages<J> {
  return messages;
}

// --- 翻訳 ---

// 辞書 messages のロケール locale の、キー key の文言の {name} を params の値で置き換える。
// name は \w+（英数字と _）。defineMessages の型（HasInvalidPlaceholder）も同じ規則で、それ以外の {...} を辞書に書かせない。
// params に無い名前は {name} のまま残す（"undefined" や空文字に化けると、params の欠けに気づけないため）。
// WHY Object.hasOwn: params の継承したプロパティ（toString など）を値と取り違えない。
// WHY 置換をライブラリ（ICU MessageFormat など）にしない: 今の文言は単純な差し込みだけで、複数形や選択の構文が要らない。
export function formatMessage<M extends Messages>(
  messages: M,
  locale: Locale,
  key: MessageKey<M>,
  params: RuntimeParams = {},
): string {
  return messages[locale][key].replace(
    /\{(\w+)\}/g,
    (placeholder, name: string) =>
      Object.hasOwn(params, name) ? String(params[name]) : placeholder,
  );
}

// 辞書とロケールを固定した型付きの t を作る。画面では useT(messages) から使い、テストでは i18n.test-support.tsx の tJa が使う。
export function createTranslator<M extends Messages>(
  messages: M,
  locale: Locale,
): Translate<M> {
  return (key, ...args) => formatMessage(messages, locale, key, args[0]);
}

// サーバから届いた文字列が辞書 messages のキーかを確かめる（features/todo/api/ が ErrorResponse を読むときに使う）。
// WHY Object.hasOwn: "toString" や "__proto__" のような Object.prototype の名前を、辞書のキーと取り違えない。
export function isMessageKey<M extends Messages>(
  messages: M,
  value: string,
): value is MessageKey<M> {
  return Object.hasOwn(messages.ja, value);
}

// --- ロケールを配る context と hook ---

// 画面のロケールを配る context。app/layout.tsx（Server Component）が x-locale ヘッダから決めたロケールを LocaleProvider に渡し、
//   画面・hook・components は useT(messages) / useLocale() で読む。
// WHY 既定値を DEFAULT_LOCALE にする（Provider が無ければエラーにしない）: layout が必ず包むので、包まれないのはテストなど。
//   Proxy を通らないリクエストと同じ扱い（既定の ja）にそろえる。
const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return <LocaleContext value={locale}>{children}</LocaleContext>;
}

// 画面のロケール（LocaleProvider が配る値）。日付の表示（format.ts）や、実行時のキーの翻訳（toErrorMessage）に渡す。
export function useLocale(): Locale {
  return use(LocaleContext);
}

// 画面のロケールで、辞書 messages を翻訳する型付きの t。画面の文言はすべてこれを通す（.claude/rules/frontend.md の「i18n」）。
// WHY 辞書を引数で受け取る: 画面・部品ごとの辞書（colocation）のキーだけを受け付ける t にし、別の画面の辞書のキーを
//   コンパイルエラーにする。
// WHY useMemo: ロケールと辞書が変わらない限り同じ関数を返し、t を effect や useCallback の依存に入れても作り直しが起きないようにする。
//   辞書は各 *.messages.ts のモジュールの定数なので、描画のたびには変わらない。
export function useT<M extends Messages>(messages: M): Translate<M> {
  const locale = useLocale();
  return useMemo(() => createTranslator(messages, locale), [messages, locale]);
}

import type {
  CSSVariablesResolver,
  MantineThemeComponents,
  MantineThemeOverride,
} from "@mantine/core";

// 画面が使う Mantine の部品の名前（Issue #292）。部品を画面で使い始めたら、ここに足す。
// WHY テーマに部品ごとの見た目を必須にする: テーマを差し替えたときに、ある部品だけ前のテーマ（Mantine の既定）の見た目で
//   残ると、テイストが混ざる。ここに足すと、すべてのテーマがその部品のキーを書くまで型チェック（pnpm typecheck / next build）で止まる。
//   限界: 型が見るのはキーがあることだけで、中身（`Title.extend({})` のような空の指定）は見ない。
// 画面が @mantine/core から import する部品がこの一覧にあることは、rule-tests/design-system.test.ts の
//   design-system-themed-components が見る（一覧に足し忘れると、その部品だけ Mantine の既定の見た目のまま残るため）。
export type ThemedComponent =
  | "Alert"
  | "Anchor"
  | "Button"
  | "Checkbox"
  | "Container"
  | "List"
  | "Paper"
  | "Text"
  | "TextInput"
  | "Title";

// 1 つのテーマ = Mantine のテーマ（色・フォント・角丸・余白・影と、部品ごとの見た目）+ CSS 変数（背景色など、テーマの
// オブジェクトに項目が無いもの）。
// WHY 見た目をすべてここに集める: 画面（features/）は部品を置くだけにし、テイストを変えるときはテーマのファイルを差し替える
//   だけで済むようにする（daiki の要望 2026-10-02）。画面に style / className / Mantine の style props を書くことは
//   rule-tests/design-system.test.ts が止める。
export type ThemeDefinition = {
  theme: MantineThemeOverride & {
    components: Pick<Required<MantineThemeComponents>, ThemedComponent>;
  };
  cssVariablesResolver: CSSVariablesResolver;
};

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
  | "Group"
  | "List"
  | "Paper"
  | "Stack"
  | "Text"
  | "TextInput"
  | "Title";

// 余白の段階名（Mantine の theme.spacing のキー）。画面は余白の props（gap・mt・p など）にこの名前だけを書ける
// （rule-tests/design-system.test.ts の design-system-no-direct-style の例外。数値や px は書けない）。
// WHY 余白だけ段階名で画面に書かせる: 画面が増えると、部品の並べ方（どこを詰め、どこを空けるか）をテーマがすべて知る必要が
//   出る。並べ方は画面に書き、各段階の値（rem）の正はテーマに残す（テーマを替えると余白の詰め具合も替わる）。
export type SpacingStep = "xs" | "sm" | "md" | "lg" | "xl";

// 1 つのテーマ = Mantine のテーマ（色・フォント・角丸・余白・影と、部品ごとの見た目）+ CSS 変数（背景色など、テーマの
// オブジェクトに項目が無いもの）。
// WHY 見た目をすべてここに集める: 画面（features/）は部品を置くだけにし、テイストを変えるときはテーマのファイルを差し替える
//   だけで済むようにする（daiki の要望 2026-10-02）。画面に style / className / Mantine の style props を書くことは
//   rule-tests/design-system.test.ts が止める。
export type ThemeDefinition = {
  theme: MantineThemeOverride & {
    // WHY spacing を必須にする: 画面は余白を段階名で書くので、テーマが段階の値を書き忘れると Mantine の既定の値のまま残り、
    //   テーマを差し替えても余白が変わらない。段階をすべて書くまで型チェックで止める。
    spacing: Record<SpacingStep, string>;
    components: Pick<Required<MantineThemeComponents>, ThemedComponent>;
  };
  cssVariablesResolver: CSSVariablesResolver;
};

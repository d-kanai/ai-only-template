import type {
  CSSVariablesResolver,
  MantineThemeComponents,
  MantineThemeOverride,
} from "@mantine/core";

// atom（shared/ui/atoms/）が包む Mantine の部品の名前（Issue #292）。部品を atom で使い始めたら、ここに足す。
// WHY テーマに部品ごとの見た目を必須にする: テーマを差し替えたときに、ある部品だけ前のテーマ（Mantine の既定）の見た目で
//   残ると、テイストが混ざる。ここに足すと、すべてのテーマがその部品のキーを書くまで型チェック（pnpm typecheck / next build）で止まる。
//   限界: 型が見るのはキーがあることだけで、中身（`Title.extend({})` のような空の指定）は見ない。
// atom が @mantine/core から import する部品がこの一覧にあることは、rule-tests/design-system.test.ts の
//   design-system-themed-components が見る（一覧に足し忘れると、その部品だけ Mantine の既定の見た目のまま残るため）。
//   画面（features/・app/）は Mantine を直接 import できない（同じテストの design-system-mantine-boundary）。
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

// 余白の段階名（Mantine の theme.spacing のキー）。画面は余白を atom の Stack / Group の gap にこの名前で書く（atom の型が
// この型で受けるので、数値や px は書けない。shared/ui/atoms/stack.tsx）。atom の外で余白の props を書くときも段階名だけ
// （rule-tests/design-system.test.ts の design-system-no-direct-style の例外）。
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

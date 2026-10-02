import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Container,
  Group,
  List,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import type { ThemeDefinition } from "../theme-definition";
import classes from "./pop.module.css";

// pop テーマ（Issue #292）: 太い黒の枠線とずらした影、角丸なし、等幅のフォント、黄色とピンク。bento とまったく違う
// テイストにし、テーマの差し替えだけでどこまで変わるかを確かめる試作。
// 部品ごとの見た目は隣の pop.module.css に書き、Styles API（components の classNames）で各部品の内側の要素に当てる。
// WHY defaultProps も使う: 部品の variant・size などの「見た目の選択」も画面ではなくテーマで決める（画面は部品を置くだけ）。
export const popTheme: ThemeDefinition = {
  // WHY createTheme を通さない: 戻り値の型が MantineThemeOverride に広がり、components の必須（ThemeDefinition）を
  //   型で確かめられなくなる（createTheme は引数をそのまま返すだけ）。
  theme: {
    primaryColor: "pink",
    defaultRadius: 0,
    // 余白の段階（画面は gap="md" のように段階名だけを書く）。Mantine の既定（xs 0.625rem〜xl 2rem）より詰め気味。
    // WHY 詰め気味: 太い黒の枠線とずらした影で面の境目がはっきりしているので、間を詰めても混ざらない。詰めて並べるほうが
    //   チラシのような賑やかさが出る。bento と値を変え、テーマの差し替えで余白も変わることを確かめる。
    spacing: {
      xs: "0.25rem",
      sm: "0.5rem",
      md: "0.75rem",
      lg: "1rem",
      xl: "1.5rem",
    },
    fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
    headings: {
      fontFamily: "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace",
      fontWeight: "900",
    },
    components: {
      Alert: Alert.extend({
        defaultProps: { variant: "filled", color: "red", radius: 0 },
        classNames: { root: classes.alert },
      }),
      Anchor: Anchor.extend({
        defaultProps: { underline: "always" },
        classNames: { root: classes.anchor },
      }),
      Button: Button.extend({
        defaultProps: { variant: "filled", radius: 0, size: "md" },
        classNames: { root: classes.button },
      }),
      Checkbox: Checkbox.extend({
        defaultProps: { radius: 0, color: "dark", size: "md" },
      }),
      Container: Container.extend({
        defaultProps: { size: "sm" },
        classNames: { root: classes.container },
      }),
      // WHY 横並びは xs: 枠線の付いた部品を横に詰めて並べ、ひと続きの帯に見せる。
      Group: Group.extend({
        defaultProps: { gap: "xs" },
      }),
      List: List.extend({
        classNames: {
          root: classes.list,
          item: classes.listItem,
          itemWrapper: classes.listItemLabel,
          itemLabel: classes.listItemLabel,
        },
      }),
      Paper: Paper.extend({
        defaultProps: { radius: 0 },
        classNames: { root: classes.paper },
      }),
      // WHY 縦並びは sm: ずらした影（枠の外に出る分）が次の面に重ならない最小の間隔。
      Stack: Stack.extend({
        defaultProps: { gap: "sm" },
      }),
      Text: Text.extend({
        classNames: { root: classes.text },
      }),
      TextInput: TextInput.extend({
        defaultProps: { radius: 0, size: "md" },
        classNames: {
          root: classes.inputRoot,
          label: classes.inputLabel,
          input: classes.input,
        },
      }),
      Title: Title.extend({
        classNames: { root: classes.title },
      }),
    },
  },
  // 画面の背景（body）。テーマのオブジェクトに項目が無いので CSS 変数で渡す。
  cssVariablesResolver: () => ({
    variables: {},
    light: { "--mantine-color-body": "#ffe66d" },
    dark: {},
  }),
};

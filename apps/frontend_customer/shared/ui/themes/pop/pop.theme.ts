import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Container,
  List,
  Paper,
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

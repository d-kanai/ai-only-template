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
import classes from "./calm.module.css";

// calm テーマ（Issue #292）: 白い面に柔らかい影、大きめの角丸、落ち着いた緑。既定のテーマ。
// 部品ごとの見た目は隣の calm.module.css に書き、Styles API（components の classNames）で各部品の内側の要素に当てる。
// WHY defaultProps も使う: 部品の variant・size などの「見た目の選択」も画面ではなくテーマで決める（画面は部品を置くだけ）。
export const calmTheme: ThemeDefinition = {
  // WHY createTheme を通さない: 戻り値の型が MantineThemeOverride に広がり、components の必須（ThemeDefinition）を
  //   型で確かめられなくなる（createTheme は引数をそのまま返すだけ）。
  theme: {
    primaryColor: "teal",
    defaultRadius: "lg",
    fontFamily:
      "'Hiragino Sans', 'Noto Sans JP', system-ui, -apple-system, sans-serif",
    headings: {
      fontFamily:
        "'Hiragino Sans', 'Noto Sans JP', system-ui, -apple-system, sans-serif",
      fontWeight: "700",
    },
    components: {
      Alert: Alert.extend({
        defaultProps: { variant: "light", color: "red" },
        classNames: { root: classes.alert },
      }),
      Anchor: Anchor.extend({
        defaultProps: { underline: "hover" },
        classNames: { root: classes.anchor },
      }),
      Button: Button.extend({
        defaultProps: { variant: "filled", radius: "xl" },
        classNames: { root: classes.button },
      }),
      Checkbox: Checkbox.extend({
        defaultProps: { radius: "xl", color: "teal" },
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
        defaultProps: { radius: "lg" },
        classNames: { root: classes.paper },
      }),
      Text: Text.extend({
        classNames: { root: classes.text },
      }),
      TextInput: TextInput.extend({
        defaultProps: { radius: "md" },
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
    light: { "--mantine-color-body": "#f4f7f6" },
    dark: {},
  }),
};

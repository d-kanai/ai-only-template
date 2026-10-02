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

// calm テーマ（Issue #292）: 既定のテーマ。緑（emerald）をアクセントに、白い面と細い線で区切る今どきの（Linear・Vercel 風の）
// 見た目。影は薄く、角丸は中くらい、見出しは字間を詰める。daiki の「ダサい。緑をベースにもっとモダンに」（2026-10-02）で作り直した。
// 部品ごとの見た目は隣の calm.module.css に書き、Styles API（components の classNames）で各部品の内側の要素に当てる。
// WHY defaultProps も使う: 部品の variant・size などの「見た目の選択」も画面ではなくテーマで決める（画面は部品を置くだけ）。
export const calmTheme: ThemeDefinition = {
  // WHY createTheme を通さない: 戻り値の型が MantineThemeOverride に広がり、components の必須（ThemeDefinition）を
  //   型で確かめられなくなる（createTheme は引数をそのまま返すだけ）。
  theme: {
    primaryColor: "emerald",
    primaryShade: 6,
    defaultRadius: "md",
    // emerald: Mantine の既定に無い緑。teal より青みが少なく彩度の高い緑（Tailwind の emerald と同じ値）。
    colors: {
      emerald: [
        "#ecfdf5",
        "#d1fae5",
        "#a7f3d0",
        "#6ee7b7",
        "#34d399",
        "#10b981",
        "#059669",
        "#047857",
        "#065f46",
        "#064e3b",
      ],
    },
    // WHY Web フォントを読み込まない: 外部への読み込みを増やさず、端末に入っているフォントで描く（Inter があれば Inter）。
    fontFamily:
      "Inter, 'Hiragino Sans', 'Noto Sans JP', system-ui, -apple-system, sans-serif",
    headings: {
      fontFamily:
        "Inter, 'Hiragino Sans', 'Noto Sans JP', system-ui, -apple-system, sans-serif",
      fontWeight: "650",
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
        defaultProps: { variant: "filled", radius: "md", size: "sm" },
        classNames: { root: classes.button },
      }),
      Checkbox: Checkbox.extend({
        defaultProps: { radius: "sm", color: "emerald", size: "sm" },
        classNames: { input: classes.checkbox, label: classes.checkboxLabel },
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
        defaultProps: { radius: "md", size: "sm" },
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
    light: { "--mantine-color-body": "#fafafa" },
    dark: {},
  }),
};

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
import classes from "./bento.module.css";

// bento テーマ（Issue #292）: 既定のテーマ。濃い緑（jade）にライムの差し色。大きく丸めた白い面をお弁当箱のように並べ、
// 線ではなく緑みの影で浮かせ、太い見出しで元気に見せる（今どきの SaaS のダッシュボードの方向）。
// daiki が緑の 3 案（forest / sage / bento）から選んだ（2026-10-02。試作は /mnt/project-files/mockups/todo-rich/）。
// 部品ごとの見た目は隣の bento.module.css に書き、Styles API（components の classNames）で各部品の内側の要素に当てる。
// WHY defaultProps も使う: 部品の variant・size などの「見た目の選択」も画面ではなくテーマで決める（画面は部品を置くだけ）。
export const bentoTheme: ThemeDefinition = {
  // WHY createTheme を通さない: 戻り値の型が MantineThemeOverride に広がり、components の必須（ThemeDefinition）を
  //   型で確かめられなくなる（createTheme は引数をそのまま返すだけ）。
  theme: {
    primaryColor: "jade",
    // WHY 7: ボタンの白い文字と並べたときに読める濃さ（6 以下だと緑が明るく、白い文字が沈む）。
    primaryShade: 7,
    defaultRadius: "lg",
    // 余白の段階（画面は gap="md" のように段階名だけを書く）。Mantine の既定（xs 0.625rem〜xl 2rem）より広め。
    // WHY 広め: 白い面（Paper）を影で浮かせて並べるので、面と面の間を空けないと影が重なり、お弁当箱の仕切りに見えない。
    spacing: {
      xs: "0.75rem",
      sm: "1rem",
      md: "1.5rem",
      lg: "2rem",
      xl: "3rem",
    },
    // jade: Mantine の既定に無い緑。green より黄みが少なく、濃い側（8・9）はサイドバーや塗りの面に使う深い緑。
    colors: {
      jade: [
        "#eafbf1",
        "#cdf5df",
        "#9eeabf",
        "#69db9c",
        "#3ec97c",
        "#22b064",
        "#169352",
        "#0f7a45",
        "#0b5e37",
        "#06402a",
      ],
    },
    // WHY Web フォントを読み込まない: 外部への読み込みを増やさず、端末に入っているフォントで描く（Inter があれば Inter）。
    fontFamily:
      "Inter, 'Hiragino Sans', 'Noto Sans JP', system-ui, -apple-system, sans-serif",
    headings: {
      fontFamily:
        "Inter, 'Hiragino Sans', 'Noto Sans JP', system-ui, -apple-system, sans-serif",
      fontWeight: "800",
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
        // WHY radius xl: 角を丸めきった錠剤の形にして、四角い面（Paper）と見分ける。
        defaultProps: { variant: "filled", radius: "xl", size: "sm" },
        classNames: { root: classes.button },
      }),
      Checkbox: Checkbox.extend({
        defaultProps: { radius: "sm", color: "jade", size: "sm" },
        classNames: { input: classes.checkbox, label: classes.checkboxLabel },
      }),
      Container: Container.extend({
        defaultProps: { size: "sm" },
        classNames: { root: classes.container },
      }),
      // WHY 横並びは sm: ボタンや入力欄を横に並べるときは 1 つのまとまりに見せたいので、縦の面の間（md）より詰める。
      Group: Group.extend({
        defaultProps: { gap: "sm" },
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
        defaultProps: { radius: "xl" },
        classNames: { root: classes.paper },
      }),
      // WHY 縦並びは md: 面（Paper）を縦に積む間隔。影が隣の面に掛からない広さにする。
      Stack: Stack.extend({
        defaultProps: { gap: "md" },
      }),
      Text: Text.extend({
        classNames: { root: classes.text },
      }),
      TextInput: TextInput.extend({
        defaultProps: { radius: "xl", size: "sm" },
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
  // 画面の背景（body）と文字の色。テーマのオブジェクトに項目が無いので CSS 変数で渡す。
  // WHY 背景を薄い緑にする: 白い面（Paper）を影だけで浮かせるため、背景は白から少し離す。
  cssVariablesResolver: () => ({
    variables: {},
    light: {
      "--mantine-color-body": "#eef5f0",
      "--mantine-color-text": "#0b2a1e",
      "--mantine-color-dimmed": "#5f7a6d",
    },
    dark: {},
  }),
};

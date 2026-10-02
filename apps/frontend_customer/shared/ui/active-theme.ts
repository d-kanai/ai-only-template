import { calmTheme } from "./themes/calm/calm.theme";
import type { ThemeDefinition } from "./themes/theme-definition";

// 画面全体で使うテーマ（Issue #292）。テイストを変えるときは、ここの 1 行を別のテーマ（themes/<名前>/<名前>.theme.ts）に
// 差し替える。画面（features/）は部品を置くだけなので、画面のコードは変えずに済む。
// WHY 環境変数や実行時の切り替えにしない: 今の要望は「テイストを変えたいときにシステムだけ切り替える」で、利用者が選ぶ機能ではない。
//   1 か所の import にしておけば、使わないテーマの CSS はバンドルに入らない。
export const activeTheme: ThemeDefinition = calmTheme;

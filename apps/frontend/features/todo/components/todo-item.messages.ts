import { defineMessages } from "@/shared/i18n/i18n";

// 一覧の 1 行（todo-item.tsx）の文言。キーはこの部品の中で短く付ける。
// ここを import してよいのは同じディレクトリのファイルだけ（規則 messages-colocation。rule-tests/architecture.test.ts）。
// WHY components/ の直下に置く（todo-item/ のディレクトリを作らない）: 部品は 1 ファイルで、隣に置けば colocation になる。
//   components/ に部品が増えたら、それぞれの <name>.messages.ts を並べる。
export const todoItemMessages = defineMessages({
  ja: {
    toggle: "「{title}」を完了にする",
    delete: "削除",
    deleteAria: "「{title}」を削除",
  },
  en: {
    toggle: "Mark “{title}” as completed",
    delete: "Delete",
    deleteAria: "Delete “{title}”",
  },
});

import { defineMessages } from "@/shared/i18n/i18n";

// 一覧画面（todo-screen.tsx）の文言。キーはこの画面の中で短く付ける（画面の名前はファイルの場所で分かるので、キーに入れない）。
// ここを import してよいのは同じディレクトリのファイルだけ（規則 messages-colocation。rule-tests/architecture.test.ts）。
// API のエラーの文言は共通の辞書（shared/i18n/common.messages.ts）。キー・placeholder の型と en の検査は defineMessages（i18n.tsx）。
export const todoScreenMessages = defineMessages({
  ja: {
    title: "Todo",
    "form.newTitle": "新しい Todo",
    "form.submit": "追加",
    loading: "読み込み中…",
    // 一覧の 1 行（TodoItem）の文言。
    toggle: "「{title}」を完了にする",
    delete: "削除",
    deleteAria: "「{title}」を削除",
  },
  en: {
    title: "Todo",
    "form.newTitle": "New todo",
    "form.submit": "Add",
    loading: "Loading…",
    toggle: "Mark “{title}” as completed",
    delete: "Delete",
    deleteAria: "Delete “{title}”",
  },
});

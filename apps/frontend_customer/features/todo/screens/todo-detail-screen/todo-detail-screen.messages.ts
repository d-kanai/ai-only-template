import { defineMessages } from "@/shared/i18n/i18n";

// 詳細画面（todo-detail-screen.tsx）の文言。キーはこの画面の中で短く付ける。
// ここを import してよいのは同じディレクトリのファイルだけ（規則 messages-colocation。rule-tests/architecture.test.ts）。
// WHY loading を一覧画面と別に持つ（一覧画面の辞書を import しない）: 画面の辞書は隣のファイルだけが使い、画面を消すときに
//   ディレクトリごと消せるようにする。同じ言い回しでも、画面ごとに変えられる。
export const todoDetailScreenMessages = defineMessages({
  ja: {
    back: "一覧へ戻る",
    titleLabel: "タイトル",
    save: "保存",
    completed: "完了",
    loading: "読み込み中…",
  },
  en: {
    back: "Back to list",
    titleLabel: "Title",
    save: "Save",
    completed: "Completed",
    loading: "Loading…",
  },
});

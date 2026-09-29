// 日本語の辞書。キーの一覧と placeholder の正（MessageKey・MessageParams の型はこのファイルから導く。messages.ts）。
// 画面に出す文言は、このファイルと en.ts 以外に書かない（画面・hook・components は t(...) を通す。.claude/rules/frontend.md の「i18n」）。
//
// キーの命名（.claude/rules/frontend.md）:
//   - サーバのエラー: backend の ErrorKey と同じ文字列（<対象>.<項目>.<理由>。例 "todo.title.tooLong"）。
//     backend の ErrorKey がすべてここにあることは、features/todo/api/api-error.ts の ApiErrorKey の型の制約で止める。
//   - 画面の文言: <feature>.<画面・部品>.<要素>（例 "todo.item.delete"）。
//   - 画面側だけのエラー: error.<理由>（例 "error.unknown"）。
// placeholder は {name}（name は英数字と _）。値は t の params で渡す（型で必須になる）。
// WHY as const: 値を文字列リテラルの型にし、文言の {name} から params の型を導くため（messages.ts の PlaceholderNames）。
// WHY 平坦なオブジェクト（入れ子にしない）: キーをサーバの ErrorKey と同じ 1 つの文字列で引けるようにし、型の導出も単純にする。
export const ja = {
  // サーバのエラー（backend の ErrorKey。apps/backend/shared/presentation/http-error.ts）
  "todo.title.empty": "タイトルを入力してください",
  "todo.title.tooLong": "タイトルは {max} 文字以内で入力してください",
  "todo.title.invalid": "タイトルが不正です",
  "todo.id.invalid": "id が不正です",
  "todo.completed.invalid": "完了状態が不正です",
  "todo.createdAt.invalid": "作成日時が不正です",
  "todo.notFound": "Todo（id: {id}）が見つかりません",
  "request.body.notJson": "リクエスト本文が JSON ではありません",
  "request.body.notObject":
    "リクエスト本文は JSON のオブジェクトで指定してください",
  "request.body.unknownKeys": "リクエストに不明な項目があります: {keys}",
  "request.field.notString": "{path} は文字列で指定してください",
  "request.field.notBoolean": "{path} は true か false で指定してください",
  "server.internalError": "サーバでエラーが発生しました",

  // 画面側だけのエラー
  // 本文が ErrorResponse の形でない失敗（プロキシや Next のエラーページなど、backend を通らない応答）。HTTP ステータスだけが分かる。
  "error.unknown": "通信に失敗しました（HTTP {status}）",
  // API の応答ではない失敗（ネットワークの切断など、fetch そのものの失敗）。
  "error.unexpected": "予期しないエラーが発生しました",

  // 一覧画面（features/todo/screens/todo-screen）
  "todo.list.title": "Todo",
  "todo.form.newTitle": "新しい Todo",
  "todo.form.submit": "追加",
  "todo.loading": "読み込み中…",

  // 一覧の 1 行（features/todo/components/todo-item.tsx）
  "todo.item.toggle": "「{title}」を完了にする",
  "todo.item.delete": "削除",
  "todo.item.deleteAria": "「{title}」を削除",

  // 詳細画面（features/todo/screens/todo-detail-screen）
  "todo.detail.back": "一覧へ戻る",
  "todo.detail.titleLabel": "タイトル",
  "todo.detail.save": "保存",
  "todo.detail.completed": "完了",
} as const;

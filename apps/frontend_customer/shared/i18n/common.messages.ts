import { defineMessages } from "./i18n";

// 共通の辞書: 画面をまたいで使う文言だけを置く（Issue #125）。画面・部品に固有の文言は、その画面・部品の隣の *.messages.ts に置く。
// 置くもの:
//   - サーバのエラー: backend の ErrorKey と同じ文字列のキー（<対象>.<項目>.<理由>。例 "todo.title.tooLong"）。
//     backend の ErrorKey がすべてここにあることは、features/todo/api/api-error.ts の ApiErrorKey の型の制約で止める。
//   - 画面側だけのエラー: error.<理由>（例 "error.unknown"）。
// WHY ここだけ shared/ に置く: API のエラーは、どの画面の操作でも同じキーで返り（api-error.ts の ApiErrorMessage.toMessage が翻訳する）、
//   特定の画面の辞書に置くと、ほかの画面から別ディレクトリの *.messages.ts を import することになる（規則 messages-colocation）。
// placeholder は {name}（name は英数字と _）。キー・placeholder の型と en の検査は defineMessages（i18n.tsx）。
export const commonMessages = defineMessages({
  ja: {
    // サーバのエラー（backend の ErrorKey。apps/backend/shared/presentation/problem.ts）
    "todo.title.empty": "タイトルを入力してください",
    "todo.title.tooLong": "タイトルは {max} 文字以内で入力してください",
    "todo.title.invalid": "タイトルが不正です",
    "todo.id.invalid": "id が不正です",
    "todo.completed.invalid": "完了状態が不正です",
    "todo.createdAt.invalid": "作成日時が不正です",
    "todo.statusChanges.invalid": "完了の履歴が不正です",
    "todo.notFound": "Todo（id: {id}）が見つかりません",
    "request.body.notJson": "リクエスト本文が JSON ではありません",
    "request.body.notObject":
      "リクエスト本文は JSON のオブジェクトで指定してください",
    "request.body.unknownKeys": "リクエストに不明な項目があります: {keys}",
    "request.field.notString": "{path} は文字列で指定してください",
    "request.field.notBoolean": "{path} は true か false で指定してください",
    "server.internalError": "サーバでエラーが発生しました",

    // 画面側だけのエラー
    // 本文が Problem Details の形でない失敗（プロキシや Next のエラーページなど、backend を通らない応答）。HTTP ステータスだけが分かる。
    "error.unknown": "通信に失敗しました（HTTP {status}）",
    // API の応答ではない失敗（ネットワークの切断など、fetch そのものの失敗）。
    "error.unexpected": "予期しないエラーが発生しました",
  },
  en: {
    "todo.title.empty": "Enter a title",
    "todo.title.tooLong": "The title must be {max} characters or fewer",
    "todo.title.invalid": "The title is invalid",
    "todo.id.invalid": "The id is invalid",
    "todo.completed.invalid": "The completed state is invalid",
    "todo.createdAt.invalid": "The creation date is invalid",
    "todo.statusChanges.invalid": "The completion history is invalid",
    "todo.notFound": "Todo (id: {id}) was not found",
    "request.body.notJson": "The request body is not JSON",
    "request.body.notObject": "The request body must be a JSON object",
    "request.body.unknownKeys": "The request has unknown fields: {keys}",
    "request.field.notString": "{path} must be a string",
    "request.field.notBoolean": "{path} must be true or false",
    "server.internalError": "A server error occurred",

    "error.unknown": "The request failed (HTTP {status})",
    "error.unexpected": "An unexpected error occurred",
  },
});

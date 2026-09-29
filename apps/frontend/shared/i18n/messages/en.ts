import type { Dictionary } from "../messages";

// 英語の辞書。キーは ja.ts と同じ（説明とキーの命名は ja.ts）。
// WHY satisfies Dictionary: ja のキーの欠け・余分をコンパイルエラーにする（ja にキーを足したら、ここにも足すまで型チェックが通らない）。
//   値の型は string のまま（as const にしない）。placeholder の型は ja から導くので、en の placeholder が ja と同じ集合であることは
//   型では表せず、messages.test.ts の「en の placeholder の集合は ja と同じ」で検査する。
export const en = {
  "todo.title.empty": "Enter a title",
  "todo.title.tooLong": "The title must be {max} characters or fewer",
  "todo.title.invalid": "The title is invalid",
  "todo.id.invalid": "The id is invalid",
  "todo.completed.invalid": "The completed state is invalid",
  "todo.createdAt.invalid": "The creation date is invalid",
  "todo.notFound": "Todo (id: {id}) was not found",
  "request.body.notJson": "The request body is not JSON",
  "request.body.notObject": "The request body must be a JSON object",
  "request.body.unknownKeys": "The request has unknown fields: {keys}",
  "request.field.notString": "{path} must be a string",
  "request.field.notBoolean": "{path} must be true or false",
  "server.internalError": "A server error occurred",

  "error.unknown": "The request failed (HTTP {status})",
  "error.unexpected": "An unexpected error occurred",

  "todo.list.title": "Todo",
  "todo.form.newTitle": "New todo",
  "todo.form.submit": "Add",
  "todo.loading": "Loading…",

  "todo.item.toggle": "Mark “{title}” as completed",
  "todo.item.delete": "Delete",
  "todo.item.deleteAria": "Delete “{title}”",

  "todo.detail.back": "Back to list",
  "todo.detail.titleLabel": "Title",
  "todo.detail.save": "Save",
  "todo.detail.completed": "Completed",
} satisfies Dictionary;

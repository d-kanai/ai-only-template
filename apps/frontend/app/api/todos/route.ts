// /api/todos の Route Handler。
// WHY re-export だけにする: app/ はルーティング専用で、入力検証・レスポンスの組み立ては
//   backend/todo/presentation の各 *.api.ts が持つ。仕様はそちらのテストで固定する。
export { POST } from "@repo/backend/todo/presentation/create-todo.api";
export { GET } from "@repo/backend/todo/presentation/list-todos.api";

// /api/todos/:id の Route Handler。
// WHY re-export だけにする: app/api/todos/route.ts と同じ（処理は apps/backend/features/todo/presentation の各 *.api.ts が持つ）。
export { DELETE } from "@repo/backend/features/todo/presentation/delete-todo.api";
export { GET } from "@repo/backend/features/todo/presentation/get-todo.api";
export { PUT } from "@repo/backend/features/todo/presentation/update-todo.api";

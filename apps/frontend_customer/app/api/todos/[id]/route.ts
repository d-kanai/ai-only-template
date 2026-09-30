// /api/todos/:id の Route Handler。
// WHY re-export だけにする: app/api/todos/route.ts と同じ（処理は apps/backend/features/todo/internal/presentation の各 *.api.ts が持つ）。
export { DELETE } from "@repo/backend/features/todo/internal/presentation/delete-todo.api";
export { GET } from "@repo/backend/features/todo/internal/presentation/get-todo.api";

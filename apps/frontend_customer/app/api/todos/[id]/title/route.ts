// /api/todos/:id/title の Route Handler（Todo の名前の変更）。
// WHY re-export だけにする: app/api/todos/route.ts と同じ（処理は apps/backend/features/todo/internal/presentation の各 *.api.ts が持つ）。
export { PUT } from "@repo/backend/features/todo/internal/presentation/rename-todo.api";

// /api/todos/:id/completion の Route Handler（Todo の完了 / 未完了）。
// WHY re-export だけにする: app/api/todos/route.ts と同じ（処理は apps/backend/features/todo/internal/presentation の各 *.api.ts が持つ）。
export { PUT } from "@repo/backend/features/todo/internal/presentation/change-todo-completion.api";

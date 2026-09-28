// /api/todos/:id の Route Handler。
// WHY re-export だけにする: app/api/todos/route.ts と同じ（処理は backend/todo/presentation の各 *.api.ts が持つ）。
export { DELETE } from "@/backend/todo/presentation/delete-todo.api";
export { GET } from "@/backend/todo/presentation/get-todo.api";
export { PUT } from "@/backend/todo/presentation/update-todo.api";

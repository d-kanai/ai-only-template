// /api/health の Route Handler（ヘルスチェック。Issue #107）。
// WHY re-export だけにする: app/api/todos/route.ts と同じ（処理は apps/backend/features/health/internal/presentation の get-health.api.ts が持つ）。
export { GET } from "@repo/backend/features/health/internal/presentation/get-health.api";

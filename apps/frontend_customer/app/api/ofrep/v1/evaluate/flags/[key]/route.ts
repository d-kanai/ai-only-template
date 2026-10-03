// /api/ofrep/v1/evaluate/flags/:key の Route Handler（OFREP の 1 件の評価。Issue #156）。
// WHY re-export だけにする: app/api/todos/route.ts と同じ（処理は apps/backend/features/feature-flag/internal/presentation の各 *.api.ts が持つ）。
export { POST } from "@repo/backend/features/feature-flag/internal/presentation/evaluate-feature-flag.api";

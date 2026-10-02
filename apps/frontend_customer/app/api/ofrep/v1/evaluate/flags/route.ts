// /api/ofrep/v1/evaluate/flags の Route Handler（OFREP の一括評価。Issue #156）。
// WHY re-export だけにする: app/api/todos/route.ts と同じ（処理は apps/backend/features/feature-flag/internal/presentation の各 *.api.ts が持つ）。
// WHY /api/ofrep/v1/...: 画面の OFREP の web provider に baseUrl "/api" を渡すと、provider が仕様のパス /ofrep/v1/evaluate/flags を足す。
export { POST } from "@repo/backend/features/feature-flag/internal/presentation/evaluate-feature-flags.api";

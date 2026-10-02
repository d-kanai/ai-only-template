// feature-flag feature の公開 API。feature の外（app/・他の feature）からはここだけを import する（Issue #156）。
// WHY フィーチャーフラグを shared/ ではなく feature に置く: フラグの key の型（FeatureFlagKey）は backend の一覧から import type で
//   読む。画面側で backend を参照してよいのは features/<f>/api/ だけで、shared/ からは参照できない（rule-tests/architecture.test.ts の
//   screen-to-backend・feature-api-to-backend）。backend の feature（features/feature-flag/）と同じ名前の feature にし、api/ が
//   自 feature の presentation の型を読む。
export type { FeatureFlagKey } from "./api/feature-flag-api";
export { FeatureFlagProvider } from "./components/feature-flag-provider";
export { useFeatureFlag } from "./hooks/use-feature-flag.hook";

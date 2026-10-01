# 人が読む backend の仕様（API 仕様・API ジャーニー）を apps/backend/spec/ の下の api/ と journey/ にまとめる

- 日付: 2026-10-01
- 状態: 採用
- 関連: Issue #251 / `.claude/rules/testing.md` / `.claude/rules/backend.md` / `rule-tests/api-spec.test.ts` / `rule-tests/api-journey.test.ts` / quality/20260930-api-spec-in-feature.md / quality/20260930-gherkin-journeys-with-vitest-cucumber.md

## 背景
人が読む backend の仕様が、API 仕様は `apps/backend/api-specs/<feature>/`（quality/20260930-api-spec-in-feature.md）、API ジャーニーは `apps/backend/api-journeys/`（quality/20260930-gherkin-journeys-with-vitest-cucumber.md）と、`apps/backend/` の直下の別々のディレクトリにあった。ユーザーが `backend/spec/api/todo/…` と `backend/spec/journey/…` に整理するよう求めた（2026-10-01）。

## 決定
- API 仕様を `apps/backend/spec/api/<feature>/`、API ジャーニーを `apps/backend/spec/journey/` に置く。ファイル名（`<api>.feature`・`<api>.api-spec.test.ts`・`support.ts`・`<ユースケース>.feature`・`<ユースケース>.api-journey.test.ts`）と規則の ID（`api-spec-*`・`api-journey-*`）は変えない。
- `.dockerignore` は `**/spec` で `spec/` の下をまとめてイメージから外す（`rule-tests/test-support.test.ts` の `dockerignore-excludes`）。
- 2 つの ADR の置き場所の記述（`api-specs/`・`api-journeys/`）は書き換えず、この ADR で読み替える（置き場所以外の決定は変わらない）。

## 理由
- 人が読む仕様を `spec/` の 1 か所にまとめると、仕様だけを拾い読みでき、コード（`features/`・`shared/`）とテスト基盤（`test-support/`）と分けて見える。
- ファイル名と規則の ID を変えないと、移動の差分がパスだけになり、検査の中身を変えずに済む。

## 採用しなかった案
- ファイル名の `.api-spec` / `.api-journey` も短くする: 名前でテストの種類を見分ける検査（`db-tests-in-infra-only` など）を直す範囲が広がり、ユーザーも求めていない。
- `.dockerignore` を `**/api` と `**/journey` に分ける: `api` は `app/api`（Next の Route Handler）と同じ名前で、本番のコードを外してしまう。

## 影響
- 良い点: 人が読む仕様の置き場所が `spec/` の 1 つになる。
- 悪い点: 既存の 2 つの ADR と作業ログの古いパスは、この ADR で読み替える必要がある。

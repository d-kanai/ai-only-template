# backend も最初の階層を features/ と shared/ にし、Drizzle の設定とマイグレーションは shared/drizzle/ に置く

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #98 / `.claude/rules/backend.md` / `.claude/rules/architecture-check.md` / スキル `db-migration`

## 背景
frontend は `apps/frontend/features/<feature>/` と `apps/frontend/shared/` の 2 つを最初の階層にしているのに、backend は feature（`apps/backend/todo/`）が `apps/backend/shared/` と同じ階層に直下で並んでいた。直下には drizzle-kit の設定 `drizzle.config.ts` と生成したマイグレーション `drizzle/` もあり、置き場所の規則（`backend-placement`）は「直下の `<name>.config.<拡張子>`」を例外にしていた。

## 決定
- `apps/backend/` の直下は `features/` と `shared/` だけにする（ほかは `package.json`・`tsconfig.json`）。feature は `apps/backend/features/<feature>/` の 4 層、feature をまたぐものは `apps/backend/shared/` の 4 層に置く。
- drizzle-kit の設定と生成したマイグレーション（`*.sql`・`meta/`）は `apps/backend/shared/drizzle/` に置く。設定の `schema` は `features/*/infra/schema.ts` を glob で読み、`out` は設定と同じディレクトリにする。
- `backend-placement` の例外を「直下の `<name>.config.<拡張子>`」から「`shared/drizzle/drizzle.config.<拡張子>`」に置き換える。`features/` 直下のファイル、`features/` を挟まない `apps/backend/<x>/`、`shared/drizzle/` のほかのソースは違反。
- exports のキーは feature ごとに `./features/<feature>/presentation/*.api` にする（Node の exports のパターンは `*` を 1 つしか持てない）。

## 理由
- ユーザー判断（2026-09-29 の work-logs「PR #97（Issue #96）を作成し、backend の features/ + shared/ 構成（Issue #98）を提案した」）。frontend と同じ構成にし、feature を足すときの置き場所をそろえる。
- 例外を「直下の config」から「`shared/drizzle/`」に置き換えると、直下を `features/` と `shared/` の 2 つに固定できる。drizzle-kit の設定とその生成物は feature をまたぐので `shared/` に置き、1 か所にまとめる。

## 採用しなかった案
- `shared/infra/drizzle/` に置く: 階層が深い（ユーザー判断で不採用）。
- 設定を `apps/backend/` 直下に残す: 直下の例外が残り、直下を 2 つに固定できない。

## 影響
- 良い点: feature を足すときの置き場所が frontend と揃う。`pnpm db:generate` の schema の glob が `features/` の下だけを見る（`shared/` にテーブルを置かない）。
- 悪い点: feature のファイルから backend/shared への相対パスが 1 段深くなる（`../../../shared/...`）。drizzle-kit のスクリプトは `--config shared/drizzle/drizzle.config.ts` を渡す。
- `shared/drizzle/drizzle.config.ts` は backend/shared の中なので、依存の規則 `backend-shared` もかかる（feature のコードを import しない）。
- 見直す条件: 記録に無い。

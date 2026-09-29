# ORM は Drizzle にし、スキーマは TypeScript で宣言して SQL のマイグレーションを生成する（push は使わない）

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #57 / PR #60 / `.claude/rules/backend.md` / スキル `db-migration` / `apps/backend/drizzle.config.ts`

## 背景
Compose で起動できる Postgres（workflow/20260928-postgres-via-docker-compose-everywhere.md）に、アプリから接続する必要があった。それまでの永続化は InMemory だった（architecture/20260928-feature-based-directory-and-ddd-backend.md）。TypeScript は 7 系（tech-stack/20260928-typescript-7.md）。

## 決定
- ORM は Drizzle（drizzle-orm / drizzle-kit）、ドライバは `pg`。
- スキーマは `<feature>/infra/schema.ts` に TypeScript で宣言し（codebase-first）、`drizzle-kit generate` で SQL を生成してコミットし、`drizzle-kit migrate` で当てる。`drizzle-kit push` は使わない。
- Drizzle と `pg` を参照するのは infra 層だけ。domain / application は参照しない（`rule-tests/architecture.test.ts` の `core-to-persistence`）。

## 理由
- ユーザーの判断（「Drizzle で良い。Prisma はトランザクションが大変だった」）。npm の週間ダウンロードが候補の中で最多で、TypeScript の peer 制約が無い（2026-09-28 の work-logs「ORM に Drizzle を採用（Issue #57）」）。
- `push` は公式でも開発用の位置づけで、SQL がファイルに残らない。generate + migrate なら当てる SQL をレビューでき、すべての環境で同じ SQL を同じ順に当てられる（スキル `db-migration`）。

## 採用しなかった案
- Prisma: トランザクションの扱いが重かった（ユーザーの経験）。peer が `typescript >=5.4.0` で、TS 7 での動作は未確認。
- kysely / typeorm: 週間ダウンロードで比べた候補（同日の work-logs）。採らなかった理由は記録に無い。
- `drizzle-kit push`: SQL が残らず、列の改名を「削除 + 追加」と解釈してデータを消す変更も、レビューなしで当たる。

## 影響
- 良い点: スキーマの形の正が 1 か所（TypeScript）で、SQL もレビューできる。
- 悪い点: Drizzle のトランザクションは `tx` を明示的に渡す方式で、Repository が実行先（`Executor`）を受け取る設計が要る（architecture/20260928-commands-always-in-transaction.md）。生成した SQL は手で直さない。
- 見直す条件: 記録に無い。

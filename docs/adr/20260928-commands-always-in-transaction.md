# command は組み立て（container）で一律にトランザクションで包み、query は包まない

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #57 / PR #60 / `.claude/rules/backend.md` / `apps/backend/todo/infra/container.ts`

## 背景
Drizzle はトランザクションの `tx` を明示的に渡す方式で、暗黙の伝播が無い（20260928-drizzle-with-generated-sql-migrations.md）。application 層は query（読むだけ）と command（状態を変える）に分かれている（20260928-feature-based-directory-and-ddd-backend.md）。ユーザーの指示は「command は一律トランザクション」（Issue #57 のコメント、PR #60）。

## 決定
- domain（`shared/domain`）に Drizzle に依存しない `TransactionRunner` の interface を置き、infra の実装が `db.transaction()` を使う。
- `infra/container.ts` が `.command.ts` の関数をすべて `runner.run((tx) => command(repositoryFor(tx), input))` の形で包む。`.query.ts` は包まない。command / query の本体は tx を意識せず、Repository を受け取るだけ。
- command の中で外部 I/O をしない。入れ子の command には同じ tx を渡す。InMemory の runner はスナップショットで rollback を再現する。

## 理由
- 「command = 状態を変える = トランザクション」と機械的に対応づけられ、包む場所が 1 か所なので付け忘れが起きない（Issue #57 のコメント）。
- 組み立てで包めば、デコレータなどの言語機能に依存しない。

## 採用しなかった案
- デコレータ（TC39 標準デコレータ）: command は class ではなく関数で、TS 7 / Biome / Vitest でのデコレータの扱いが未確認。
- `AsyncLocalStorage` で tx を暗黙に伝播する: どの処理がトランザクションの中かが見えなくなる（ユーザーが Prisma で苦労した状態。Drizzle も明示的に渡す方式）。
- シリアライズ失敗の再試行を入れる: 必要になったら isolation level とあわせて検討する。

## 影響
- 良い点: command を足すだけでトランザクションに入る。rollback のテストを InMemory でも書ける。
- 悪い点: 外部 I/O を command の外に出す設計が要る。トランザクション中の外部 I/O はロックを長引かせる。
- 見直す条件: isolation level や再試行が必要になったとき（Issue #57 のコメント）。

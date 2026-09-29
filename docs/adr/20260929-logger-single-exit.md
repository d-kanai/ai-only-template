# サーバ側のログは logger.ts を唯一の出口にし、console の直接の呼び出しを Biome とテストの 2 系統で止める

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #85 / PR #89 / `.claude/rules/backend.md` / `.claude/rules/lint.md` / `.claude/rules/architecture-check.md` / `apps/shared/logger.ts`

## 背景
リクエストログ（20260929-request-log-in-proxy.md）が `console.log(JSON.stringify(...))` を直接呼ぶなど、ログの形と出力先が各所に散り始めていた。Biome の `noConsole` は `console.error` / `console.warn` を許していた。

## 決定
- サーバ側のログは `logger.info / warn / error(event)` を必ず通す。`console.*` を書いてよいのは `logger.ts` だけ（テストは除く）。`logger.ts` は Issue #90 で `apps/shared/` に移した（20260929-apps-shared-package.md）。
- 1 呼び出し = JSON 1 行（先頭に `level` と `timestamp`）。info は stdout、warn / error は stderr。`Error` は `{ name, message }` にし、JSON にできないときは例外にせず、失敗を示す 1 行を出す。
- ログのライブラリは足さない。
- Biome の `noConsole`（allow なし。`logger.ts` とテストだけ off）と、`rule-tests/architecture.test.ts` の `console-direct-access` の 2 系統で止める。
- presentation 層から logger を直接使ってよい（container 経由で注入しない）。

## 理由
- ユーザーの指示（2026-09-29 の work-logs「logger.ts を作ってログを必ずそれ経由にする指示 → Issue #85」）。
- 行の形を 1 か所で決め、出力先を変える（ファイル・外部のログ基盤）ときに直すのを `logger.ts` だけにする。`noConsole` の allow は、logger を通らない書き方の抜け道になる（Issue #85）。
- Biome とテストでは、片方だけが拾う書き方がある（2026-09-29 の work-logs「Issue #85: logger.ts をログの唯一の出口にした」）。`env.ts` の `process.env` と同じ設計（20260928-env-single-entry-all-required.md）。
- ログは横断的な関心で、env と同じ扱いにする方が単純（PR #89）。

## 採用しなかった案
- container 経由で logger を注入する: 横断的な関心なので env と同じ扱いにした。
- ログのライブラリ（pino など）: 足さない。中は `console` で、呼び出し側のテストが `vi.spyOn(console, ...)` で確かめられる。
- `Error` の stack を出す: 1 行が長くなり、内部のパスも含む。

## 影響
- 良い点: ログの形と出力先が 1 か所で決まる。
- 悪い点: `node:console` の import はどちらの検査も拾わない（レビューで見る）。起動時の検証エラーは、stack 付きの複数行から 1 行の JSON（改行はエスケープ）になった。
- 見直す条件: 記録に無い。

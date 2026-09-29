# ログ（logger.ts）の経緯と検査の限界（Issue #85）

規則は `.claude/rules/backend.md` の「ログ」（使い方・使ってよい場所）、`lint.md`（`noConsole` と overrides）、`architecture-check.md`（規則 `console-direct-access`）。
実装は `apps/shared/logger.ts`（Issue #90 で `apps/backend/shared/infra/` から移した）、仕様は `logger.test.ts`。

## 決めたこと（ユーザー指示 2026-09-29）
- `proxy.ts` の `console.log(JSON.stringify(log))` のような直接の呼び出しをやめ、サーバ側のログは `logger.info / warn / error(event)` を必ず通す。`console.*` を書いてよいのは `logger.ts` だけ（テストは除く）。
- WHY:
  - 行の形を 1 か所で決める: 1 呼び出し = JSON 1 行（NDJSON）、先頭に `level` と `timestamp`（ISO 8601、UTC。event に `timestamp` があればそれ）。info は stdout、warn / error は stderr。
  - 出力先を変える（ファイル・外部のログ基盤へ送る）ときに、直すのが `logger.ts` だけで済む。
  - `noConsole` の `allow`（以前は `console.error` / `console.warn`）は、logger を通らない書き方の抜け道になる。
- 依存（pino など）は足さない。中は `console.log` / `console.warn` / `console.error`（呼び出し側のテストが `vi.spyOn(console, ...)` で確かめられる）。
- `Error` は `{ name, message }` にする（`JSON.stringify` のままだと `{}` になる。stack は 1 行が長くなり、内部のパスも含むので出さない）。循環参照・BigInt で `JSON.stringify` が失敗したら、例外にせず `{ level, timestamp, message: "logger: event を JSON にできなかった（循環参照・BigInt など）" }` の 1 行を出す。
- 置き換えた呼び出し: `apps/frontend/proxy.ts`（リクエストログ。`logger.info`）、`apps/backend/shared/presentation/http-error.ts`（500 の想定外の例外。`logger.error({ message: "想定外の例外", error })`）、`apps/backend/shared/infra/database.ts`（`pool.on("error")`）、`apps/frontend/instrumentation-node.ts`（起動時の環境変数の検証の失敗）。
  - presentation から `shared/infra/logger` を使えるよう、依存の規則 `presentation` の許可に足した（presentation の infra は自 feature の `container` だけ、の例外）。frontend 直下も `frontend-root-to-backend` の許可に足した（Issue #90 で logger を `apps/shared` に移し、`frontend-root-to-backend` の例外は無くした。presentation の許可は `SHARED_MODULES_BY_LAYER` の logger）。
  - 起動時の検証の失敗は、以前の `console.error(error)`（stack 付きの複数行）から 1 行の JSON になり、欠けた変数の一覧（`env.ts` のメッセージの改行）は `\n` にエスケープされて `message` に入る。

## 検査の 2 系統と、片方だけが拾う書き方（Biome 2.5.13、2026-09-29 実測）
`env.ts` の `process.env` と同じ設計（`docs/env.md`）。Biome の `suspicious/noConsole`（`biome.json` の overrides で `logger.ts` とテストだけ off）と、`rule-tests/architecture.test.ts` の規則 `console-direct-access`。Biome は overrides・allow の書き換えで黙って効かなくなるので、テスト側で対象と例外を固定する。

`./node_modules/.bin/biome lint --only=suspicious/noConsole <ファイル>` で、1 行ずつのファイルを検査した結果:

| 書き方 | Biome `noConsole` | `console-direct-access` |
| --- | --- | --- |
| `console.log(1)` / `console.error(1)` / `console?.log(1)` / `console["log"](1)` / `globalThis.console.log(1)` | 検出 | 検出 |
| `global.console.log(1)` / `(console).log(1)` | 検出しない | 検出 |
| `const { log } = console` / `const c = console; c.log(1)` / `run(console)` | 検出しない | 検出（`console` という名前を書いた時点で違反） |
| `` `x: ${console.log(1)}` ``（テンプレートリテラルの `${}` の中） | 検出 | 検出しない（文字列の中とみなす） |
| `import { log } from "node:console"` / `import c from "node:console"` | 検出しない | 検出しない（レビューで見る） |

- `console-direct-access` の限界は `rule-tests/architecture.test.ts` の「console の参照の抽出（findConsoleAccesses）」のテストで固定している。
- `console-direct-access` は `obj.console` や `{ console: 1 }` のようなプロパティ名も拾う（多く検出する方向。今のリポジトリには無い）。
- どちらもテスト（`*.test.ts` / `*.test.tsx`）は対象外。E2E の spec（`apps/e2e/*.spec.ts`）は対象（テストの overrides に当たらない）。

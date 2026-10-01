---
paths:
  - "apps/shared/**"
---

# shared（frontend と backend で共通の基盤。apps/shared）

`apps/shared/` は workspace パッケージ `@repo/shared`（Issue #90）。frontend（直下のサーバ側のファイル）と backend の両方が使う横断的な基盤だけを置く。Node 標準と `zod`（logger のスキーマ。Issue #216）だけを使う TypeScript で、`dependencies` は `zod` だけ（版は backend と同じ。`.claude/rules/dependencies.md`）。
規則は `rule-tests/architecture.test.ts` が検査する（一覧は `.claude/rules/architecture-check.md`）。決定は ADR `docs/adr/architecture/20260929-apps-shared-package.md`。

## 置いてよいもの
- `env.ts`（環境変数の唯一の入口。`.claude/rules/env.md`）、`logger.ts`（サーバ側のログの唯一の出口。`.claude/rules/backend.md` の「ログ」）、`now.ts`（現在時刻の唯一の出口。下の「now」）、そのテスト（`env.test.ts`・`logger.test.ts`・`now.test.ts`）、`log-event.ts`（logger の `event.name` に使える名前の一覧 `LOG_EVENT_NAMES`（Issue #209）と、種類ごとの行の zod スキーマ `LOG_EVENT_SCHEMAS`・マスクの印 `sensitive()` / `freeText()`・重大度 `severityOf`（Issue #216。下の「ログのスキーマとマスクの印」））とそのテスト `log-event.test.ts`（Issue #216 でマスクの正規表現の仕様を置くために足した。行の丸ごとの形は `logger.test.ts`）、`package.json`・`tsconfig.json` だけ（規則 `shared-placement`。ソース以外のファイルも名前で決める）。
  - WHY: 「frontend と backend の両方で使う」ものは多く、共通の置き場所を自由にすると feature のコードや DB・React に依存するコードが集まり、層の規則（backend の 4 層・画面側の境界）の外で依存が育つ。置いてよいのは、どの層・どのパッケージからも同じものを使うべき基盤（外の世界との入口・出口）だけにする。
- 文言（`env.ts` のエラー、`logger.ts` のメッセージ）は英語で書き、日本語のリテラルを置かない（規則 `server-hardcoded-text`）。WHY: 利用者に見せる文言は frontend の辞書（`apps/frontend_customer/` の `*.messages.ts`）だけで、運用者向けの文言は英語に統一する。
- 置かないもの: feature のコード（型・DTO を含む。画面とサーバの契約は backend の api ファイルに置く）、DB（`drizzle-orm` / `pg`。永続化は backend の infra）、React・Next・ブラウザの API。
- 足すときは、Issue で「frontend と backend の両方が使う基盤か」を決めてから、`shared-placement` の一覧（`SHARED_FILES`）・`exports`・このファイルを同じ変更で直す（足すことを規則の変更としてレビューに出す）。

## 使い方（import の書き方）
- 外からは `@repo/shared/env`・`@repo/shared/logger`・`@repo/shared/now` で使う（各パッケージの `package.json` に `"@repo/shared": "workspace:*"`）。
  - frontend 直下（`instrumentation-node.ts`・`proxy.ts`）・`apps/e2e/`・リポジトリ直下（`vitest.global-setup.ts`）は `@repo/shared/...` の書き方だけ（相対パスと `@/../shared/...` は不可。規則 `frontend-to-shared-specifier`）。
  - backend の中も `@repo/shared/...` だけで書く（相対パスは違反。規則 `backend-relative-only`）。WHY: exports を経由しない参照を許すと、公開範囲（exports）が意味を持たなくなる。backend の層ごとに使ってよいもの: infra は env・logger・now、presentation は logger・now、domain・application は now だけ（`SHARED_MODULES_BY_LAYER`）。
  - 画面側（`apps/frontend_customer/` の `app/`・`features/`・`shared/`）は使わない（規則 `screen-to-shared`）。WHY: env は `process.env` と `.env` のファイルを読み、logger は stdout に書くサーバ専用のもので、ブラウザのバンドルに入れない。now も今は画面が現在時刻を読まないので許していない（使う必要が出たら、画面の時刻をこの出口にそろえるかを決めて規則を緩める）。
- `apps/shared` の中は同じディレクトリのファイルと `node:` の組み込みだけを読む。backend・frontend、React・Next・DB、`node:` と `zod` 以外のパッケージは参照しない（規則 `shared-self-contained`。許すパッケージは `rule-tests/architecture.test.ts` の `SHARED_ALLOWED_PACKAGES` に名前の完全一致で書き、`zod/v4`・`zod/mini` などのサブパスも違反）。WHY: frontend 直下と backend の両方が読み込む基盤なので、ここから外を参照すると `frontend-root-to-backend` や層の規則を `apps/shared` 経由ですり抜けられ、依存も env・logger を使うすべての場所に入る。
  - WHY `zod` だけ許す（Issue #216）: logger が種類ごとの行の形をスキーマで parse し、一覧に無いキーを落として個人情報を `***` にする（ADR `docs/adr/architecture/20260930-log-masking-in-logger.md`）。`package.json` の dependencies を読んで許す形にしない（依存を足すだけで通り、置いてよいものの判断がレビューに出ない）。足すときは Issue で決め、`SHARED_ALLOWED_PACKAGES` とこのファイルを同じ変更で直す。

## exports（`apps/shared/package.json`）
- キーは `./env`・`./logger`・`./now` の 3 つ。1 ファイル = 1 キーで、パターン（`"./*"`）を使わない（規則 `shared-exports` が過不足と値の形を止める。検査の内容は `backend-exports` と同じ）。
  - WHY: 置いてよいファイルを名前で決めている（`shared-placement`）ので、公開も名前で決め、置き場所と公開を 1 対 1 にする。
  - 例外: `log-event.ts` は公開しない（`./log-event` のキーを置かない。Issue #209）。WHY: 使うのは `logger.ts`（`LogEvent` の型）だけで、外の呼び出し側は `logger.emit({ message: "db write start", event: { name: "db_write", phase: "start" }, … })` のように名前を文字列で書けば `LogEvent`（種類ごとのスキーマの入力の型の union）で一覧と種類ごとの必須項目に縛られる。外から参照されないキーは `shared-exports` が違反にする（2026-09-30 に `./log-event` を足して実測）。外から一覧の値（`LOG_EVENT_NAMES`）が要るようになったら、キーと `SHARED_MODULES_BY_LAYER` の許可を同じ変更で足す。
- 値はキーのパスに `.ts` を付けた TS のソース（ビルドしない。`@repo/backend` と同じ）。

## ログのスキーマとマスクの印（`log-event.ts`。Issue #216）
- logger の口は `logger.emit(event)` の 1 つ（`info` / `warn` / `error` は無い）。logger は `event.name` で `LOG_EVENT_SCHEMAS` のスキーマを選んで `safeParse` し、その結果だけを 1 行にする。重大度は `severityOf`（種類と `event.phase`）が決める。使い方と行の形は `.claude/rules/backend.md` の「ログ」、決定は ADR `docs/adr/architecture/20260930-log-masking-in-logger.md`。
- 種類を足す・項目を足すときは `LOG_EVENT_NAMES` と `LOG_EVENT_SCHEMAS` を同じ変更で直す（`satisfies` が過不足を型で止める）。項目は `z.object` に書いたものだけが出る（一覧に無いキーは落ちる = allowlist。`.strict()` にしない: 行そのものを失う）。
- 値の印（どの項目に何を付けるか）:
  - `sensitive(schema)`: 値を常に `***` にする（`transform`）。利用者の入力・利用者に由来する値（`url.query` の値・`referer`・`client.address`）。`null` を残すときは外側に `.nullable()`。WHY `transform`（zod の `.meta()` にしない）: `.meta()` の印は `.optional()` などで包むと外側に引き継がれず、logger から見えなくなる。
  - `freeText()`: 自由文（`message`・`url.path`・`url.query` のキー・`error.message`・通知の本文）。値は出すが、メール・JWT・Bearer・Luhn に合う 13〜19 桁を `***` にし、2000 文字で切る。正規表現は入れ子の量指定子を使わない線形の形に限る（ReDoS。時間の上限は `log-event.test.ts` が測る）。電話番号は入れない（誤検知）。
  - 印なし: コードと DB が決める名前・id（`event.*`・`db.*`・`row_id`・`http.request.id`・`server.address` など）。`http.request.id` と `server.address` に `freeText` をかけない（E2E の 13 桁の id が Luhn に合うことがあり、`***` になって不安定になる）。
  - `error`: `Error` は `{ type, message }`（message は `freeText`）、`type` を持つオブジェクトはそのまま、それ以外の throw は `{ type: typeof 値 }`（値を出さない）。
- 型: `LogEvent` は `z.input` の union（`z.infer` = 出力の型だと sensitive の項目が `"***"` 型になり、生の値を渡せない）。種類ごとの必須項目の縛りは `logger.test.ts` の `@ts-expect-error`（`pnpm typecheck`）が固定する。
- テスト: `logger.test.ts` が全種類の行を丸ごと比べ、sensitive の項目に入れた番兵の値が出力に含まれないことを確かめる。WHY 丸ごと比べる: `LOG_EVENT_SCHEMAS` は最上位の値なので Stryker の static な変異になり ignoreStatic で検査から外れ、項目と印の変更はこの比較だけが止める。

## now（現在時刻の唯一の出口。`now.ts`）
- アプリのコード（`apps/frontend_customer`・`apps/backend`・`apps/shared` のテスト以外）で現在時刻が要るときは `now()` を呼ぶ。引数の無い `new Date()`・`Date.now()`・`new` の無い `Date()` を書いてよいのは `now.ts` だけ（規則 `now-single-source`。`rule-tests/architecture.test.ts`）。引数のある `new Date(x)`（解析）・`Date.parse`・`Date.UTC` は可。
  - WHY: 時刻を各所で直接読むと、時刻に依存する振る舞い（Entity の作成日時・一覧の並び順・ログの時刻）のテストが実行した瞬間で結果を変え、決定的にならない。出口が 1 つなら、テストは `vi.mock` でそのモジュールを差し替えるだけで時刻を決められる（`.claude/rules/testing.md` の「テストダブル」）。
  - WHY 引数で時刻を受け取る形（`Todo.create(title, createdAt)`・Clock の注入）にしない: 「作ったときの時刻が入る」は Entity の生成ルールで、呼び出し側が時刻を渡せるとルールが呼び出し側に漏れる（ユーザー判断）。
  - 対象外: テスト・テストの補助（アプリの直下の `test-support/` の下。Issue #181）、`apps/e2e/`（別プロセスの本番ビルドを操作し now を差し替えられない。現在時刻は一意なタイトルを作るためだけ）、`scripts/`・リポジトリ直下の設定。
- `apps/shared` の中からは相対パスで読む（`logger.ts` の `import { now } from "./now"`）。
- 決定は ADR `docs/adr/architecture/20260930-now-single-source.md`、検査の書き方と限界は `.claude/rules/architecture-check.md`。

## 型チェック・テスト
- `apps/shared/tsconfig.json` は `apps/backend/tsconfig.json` と同じ方針（Next の plugin・jsx・DOM の型なし）。`pnpm typecheck` が `tsc -p apps/shared --noEmit` で検査する（`rule-tests/typecheck.test.ts`）。
- テストは隣に置き、先頭に `// @vitest-environment node`。カバレッジ（`vitest.config.mts` の `coverage.include`）と Stryker（`stryker.config.mjs` の `mutate`）の対象（`.claude/rules/testing.md`）。
- テストは同じディレクトリのファイルを相対パス（`./env`）で import する。WHY: Stryker のサンドボックスで `@repo/shared/...` から読むと、変異していない元のファイルに解決される（`stryker.config.mjs` の注意）。

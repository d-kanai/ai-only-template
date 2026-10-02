---
paths:
  - "apps/shared/**"
---

# shared

## 概要

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| パッケージ | `apps/shared/` は workspace パッケージ `@repo/shared`（Issue #90）。frontend（直下のサーバ側のファイル）と backend の両方が使う横断的な基盤だけを置く | - | 説明 |
| 検査 | 規則は `rule-tests/architecture.test.ts` が検査する（一覧は `.claude/rules/code/architecture-check.md`） | 決定は ADR `docs/adr/architecture/20260929-apps-shared-package.md` | 説明 |

## ディレクトリ構成

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 置いてよいもの | 置いてよいのは `env.ts`（環境変数の唯一の入口。`.claude/rules/tooling/env.md`）、`logger.ts`（サーバ側のログの唯一の出口。`.claude/rules/code/backend.md` の「ログ」）、`now.ts`（現在時刻の唯一の出口。下の「現在時刻」）、そのテスト（`env.test.ts`・`logger.test.ts`・`now.test.ts`）、`log-event.ts`（logger の `event.name` に使える名前の一覧 `LOG_EVENT_NAMES`（Issue #209）と、種類ごとの行の zod スキーマ `LOG_EVENT_SCHEMAS`・マスクの印 `LogFieldMarks.sensitive()` / `LogFieldMarks.freeText()`・重大度 `LogSeverity.of`（Issue #216。下の「ログのスキーマとマスクの印」））とそのテスト `log-event.test.ts`、`package.json`・`tsconfig.json` だけ（規則 `shared-placement`。ソース以外のファイルも名前で決める） | 「frontend と backend の両方で使う」ものは多く、共通の置き場所を自由にすると feature のコードや DB・React に依存するコードが集まり、層の規則（backend の 4 層・画面側の境界）の外で依存が育つ。置いてよいのは、どの層・どのパッケージからも同じものを使うべき基盤（外の世界との入口・出口）だけにする。`log-event.test.ts` は Issue #216 でマスクの正規表現の仕様を置くために足した（行の丸ごとの形は `logger.test.ts`） | `rule-tests/architecture.test.ts` の `shared-placement`・`SHARED_FILES` |
| 置いてよいもの | 足すときは、Issue で「frontend と backend の両方が使う基盤か」を決めてから、`shared-placement` の一覧（`SHARED_FILES`）・`exports`・このファイルを同じ変更で直す（足すことを規則の変更としてレビューに出す） | - | レビュー |
| 置かないもの | feature のコード（型・DTO を含む。画面とサーバの契約は backend の api ファイルに置く）を置かない | - | `rule-tests/architecture.test.ts` の `shared-placement`・`shared-self-contained` |
| 置かないもの | DB（`drizzle-orm` / `pg`。永続化は backend の infra）、React・Next を使わない | - | `rule-tests/architecture.test.ts` の `shared-self-contained` |
| 置かないもの | ブラウザの API（`window`・`document` など DOM の型）を使わない | `shared-self-contained` は import だけを見るので、グローバルの API は止めない。`apps/shared/tsconfig.json` の `lib: ["esnext"]`（DOM なし）と `types: ["node"]` で `tsc -p apps/shared` が型エラーにする。限界: Node にもある API（`fetch`・`URL` など）は止まらず、tsconfig の中身（`lib`）はどの検査も見ない（下の「型チェックとテスト」） | `pnpm typecheck` |

## 依存の向き

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 使う側 | backend の層ごとに使ってよいもの: infra は env・logger・now、presentation は logger・now、domain・application は now だけ（`SHARED_MODULES_BY_LAYER`） | - | `rule-tests/architecture.test.ts` の `SHARED_MODULES_BY_LAYER` |
| 使う側 | 画面側（`apps/frontend_customer/` の `app/`・`features/`・`shared/`）は使わない（規則 `screen-to-shared`） | env は `process.env` と `.env` のファイルを読み、logger は stdout に書くサーバ専用のもので、ブラウザのバンドルに入れない。now も今は画面が現在時刻を読まないので許していない（使う必要が出たら、画面の時刻をこの出口にそろえるかを決めて規則を緩める） | `rule-tests/architecture.test.ts` の `screen-to-shared` |
| 参照先 | Node 標準と `zod`（logger のスキーマ。Issue #216）だけを使う TypeScript で書く | - | `rule-tests/architecture.test.ts` の `shared-self-contained` |
| 参照先 | `apps/shared` の中は同じディレクトリのファイルと `node:` の組み込みだけを読む。backend・frontend、React・Next・DB、`node:` と `zod` 以外のパッケージは参照しない（規則 `shared-self-contained`。許すパッケージは `rule-tests/architecture.test.ts` の `SHARED_ALLOWED_PACKAGES` に名前の完全一致で書き、`zod/v4`・`zod/mini` などのサブパスも違反） | frontend 直下と backend の両方が読み込む基盤なので、ここから外を参照すると `frontend-root-to-backend` や層の規則を `apps/shared` 経由ですり抜けられ、依存も env・logger を使うすべての場所に入る | `rule-tests/architecture.test.ts` の `shared-self-contained`・`SHARED_ALLOWED_PACKAGES` |
| パッケージ | `zod` だけ許す（Issue #216） | logger が種類ごとの行の形をスキーマで parse し、一覧に無いキーを落として個人情報を `***` にする（ADR `docs/adr/architecture/20260930-log-masking-in-logger.md`）。`package.json` の dependencies を読んで許す形にしない（依存を足すだけで通り、置いてよいものの判断がレビューに出ない） | `rule-tests/architecture.test.ts` の `SHARED_ALLOWED_PACKAGES` |
| パッケージ | パッケージを足すときは Issue で決め、`SHARED_ALLOWED_PACKAGES` とこのファイルを同じ変更で直す | 置いてよいものの判断をレビューに出す | レビュー |
| パッケージ | `dependencies` は `zod` だけ（`.claude/rules/tooling/dependencies.md`） | `shared-self-contained` が止めるのは参照だけで、`package.json` の `dependencies` に足すこと自体は止めない | レビュー |
| パッケージ | `zod` の版は backend と同じ | - | `rule-tests/package.test.ts` の `findInconsistentVersions` |

## import と exports

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| import | 外からは `@repo/shared/env`・`@repo/shared/logger`・`@repo/shared/now` で使う（各パッケージの `package.json` に `"@repo/shared": "workspace:*"`） | - | 説明 |
| import | frontend 直下（`instrumentation-node.ts`・`proxy.ts`）・`apps/e2e/`・リポジトリ直下（`vitest.global-setup.ts`）は `@repo/shared/...` の書き方だけ（相対パスと `@/../shared/...` は不可。規則 `frontend-to-shared-specifier`） | - | `rule-tests/architecture.test.ts` の `frontend-to-shared-specifier` |
| import | backend の中も `@repo/shared/...` だけで書く（相対パスは違反。規則 `backend-relative-only`） | exports を経由しない参照を許すと、公開範囲（exports）が意味を持たなくなる | `rule-tests/architecture.test.ts` の `backend-relative-only` |
| import | `apps/shared` の中からは相対パスで読む（`logger.ts` の `import { Clock } from "./now"`） | - | レビュー |
| exports | `apps/shared/package.json` の exports のキーは `./env`・`./logger`・`./now` の 3 つ。1 ファイル = 1 キーで、パターン（`"./*"`）を使わない（規則 `shared-exports` が過不足と値の形を止める。検査の内容は `backend-exports` と同じ） | 置いてよいファイルを名前で決めている（`shared-placement`）ので、公開も名前で決め、置き場所と公開を 1 対 1 にする | `rule-tests/architecture.test.ts` の `shared-exports` |
| exports | 例外: `log-event.ts` は公開しない（`./log-event` のキーを置かない。Issue #209） | 使うのは `logger.ts`（`LogEvent` などの型と、値の `LOG_EVENT_NAMES`・`LOG_EVENT_SCHEMAS`・`LogSeverity`）だけで、外の呼び出し側は `logger.emit({ message: "db write start", event: { name: "db_write", phase: "start" }, … })` のように名前を文字列で書けば `LogEvent`（種類ごとのスキーマの入力の型の union）で一覧と種類ごとの必須項目に縛られる。外から参照されないキーは `shared-exports` が違反にする（2026-09-30 に `./log-event` を足して実測） | `rule-tests/architecture.test.ts` の `shared-exports` |
| exports | 外から一覧の値（`LOG_EVENT_NAMES`）が要るようになったら、キーと `SHARED_MODULES_BY_LAYER` の許可を同じ変更で足す | - | レビュー |
| exports | 値はキーのパスに `.ts` を付けた TS のソース（ビルドしない。`@repo/backend` と同じ） | - | `rule-tests/architecture.test.ts` の `shared-exports` |

## 現在時刻

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 規則 | アプリのコード（`apps/frontend_customer`・`apps/backend`・`apps/shared` のテスト以外）で現在時刻が要るときは `Clock.now()` を呼ぶ。引数の無い `new Date()`・`Date.now()`・`new` の無い `Date()` を書いてよいのは `now.ts` だけ（規則 `now-single-source`。`rule-tests/architecture.test.ts`）。引数のある `new Date(x)`（解析）・`Date.parse`・`Date.UTC` は可 | 時刻を各所で直接読むと、時刻に依存する振る舞い（Entity の作成日時・一覧の並び順・ログの時刻）のテストが実行した瞬間で結果を変え、決定的にならない。出口が 1 つなら、テストは `vi.mock` でそのモジュールを差し替えるだけで時刻を決められる（`.claude/rules/quality/testing.md` の「テストダブル」） | `rule-tests/architecture.test.ts` の `now-single-source` |
| 規則 | 対象外: テスト・テストの補助（アプリの直下の `test-support/` の下。Issue #181）、`apps/e2e/`、`scripts/`・リポジトリ直下の設定 | `apps/e2e/` は別プロセスの本番ビルドを操作し now を差し替えられない。現在時刻は一意なタイトルを作るためだけ | 説明 |
| 規則 | 決定は ADR `docs/adr/architecture/20260930-now-single-source.md`、検査の書き方と限界は `.claude/rules/code/architecture-check.md` | - | 説明 |
| 形 | 引数で時刻を受け取る形（`Todo.create(title, createdAt)`・Clock の注入）にしない | 「作ったときの時刻が入る」は Entity の生成ルールで、呼び出し側が時刻を渡せるとルールが呼び出し側に漏れる（ユーザー判断） | レビュー |
| 形 | クラスの static メソッドにする（関数 `now()` にしない。Issue #262） | apps/shared も最上位に関数を置かない（下の「クラスと文言」）。インスタンスの注入にしないのは上の WHY と同じで、差し替えは `vi.mock` の 1 つのまま（自動モックは static メソッドも差し替える） | `rule-tests/architecture.test.ts` の `class-based` |

## ログのスキーマとマスクの印

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| スキーマ | logger の口は `logger.emit(event)` の 1 つ（`info` / `warn` / `error` は無い）。logger は `event.name` で `LOG_EVENT_SCHEMAS` のスキーマを選んで `safeParse` し、その結果だけを 1 行にする。重大度は `LogSeverity.of`（種類と `event.phase`）が決める。スキーマ・印・重大度は `log-event.ts` に置く（Issue #216） | 使い方と行の形は `.claude/rules/code/backend.md` の「ログ」、決定は ADR `docs/adr/architecture/20260930-log-masking-in-logger.md` | 説明 |
| スキーマ | 種類を足す・項目を足すときは `LOG_EVENT_NAMES` と `LOG_EVENT_SCHEMAS` を同じ変更で直す（`satisfies` が過不足を型で止める） | - | `pnpm typecheck` |
| スキーマ | 項目は `z.object` に書いたものだけが出る（一覧に無いキーは落ちる = allowlist）。`.strict()` にしない | `.strict()` にすると行そのものを失う | レビュー |
| 印 | `LogFieldMarks.sensitive(schema)`: 値を常に `***` にする（`transform`）。利用者の入力・利用者に由来する値（`url.query` の値・`referer`・`client.address`）に付ける。`null` を残すときは外側に `.nullable()` | `transform`（zod の `.meta()` にしない）: `.meta()` の印は `.optional()` などで包むと外側に引き継がれず、logger から見えなくなる | レビュー |
| 印 | `LogFieldMarks.freeText()`: 自由文（`FreeTextMask.mask` を通す。`message`・`url.path`・`url.query` のキー・`error.message`・通知の本文）に付ける。値は出すが、メール・JWT・Bearer・Luhn に合う 13〜19 桁を `***` にし、2000 文字で切る。電話番号は入れない | 電話番号は誤検知するので入れない | レビュー |
| 印 | `FreeTextMask` の正規表現は入れ子の量指定子を使わない線形の形に限る（ReDoS） | 時間の上限は `log-event.test.ts` が測る。形そのもの（入れ子の量指定子が無いか）は見ない | `apps/shared/log-event.test.ts` |
| 印 | 印なし: コードと DB が決める名前・id（`event.*`・`db.*`・`row_id`・`http.request.id`・`server.address` など）。`http.request.id` と `server.address` に `freeText` をかけない | E2E の 13 桁の id が Luhn に合うことがあり、`***` になって不安定になる | レビュー |
| 印 | `error`: `Error` は `{ type, message }`（message は `freeText`。ただし `query` か `params` のプロパティを持つ `Error`（SQL とパラメータを抱える DrizzleQueryError など）の message は `***`。`LogFieldMarks.holdsQueryParameters`）、`type` を持つオブジェクトはそのまま、それ以外の throw は `{ type: typeof 値 }`（値を出さない） | - | 説明 |
| 型とテスト | `LogEvent` は `z.input` の union | `z.infer` = 出力の型だと sensitive の項目が `"***"` 型になり、生の値を渡せない | 説明 |
| 型とテスト | 種類ごとの必須項目の縛りは `logger.test.ts` の `@ts-expect-error`（`pnpm typecheck`）が固定する | - | `apps/shared/logger.test.ts` の `@ts-expect-error`、`pnpm typecheck` |
| 型とテスト | `logger.test.ts` が全種類の行を丸ごと比べ、sensitive の項目に入れた番兵の値が出力に含まれないことを確かめる。項目を足すときはこの比較と番兵の値も足す | 丸ごと比べる: `LOG_EVENT_SCHEMAS` は最上位の値なので Stryker の static な変異になり ignoreStatic で検査から外れ、項目と印の変更はこの比較だけが止める | レビュー |

## クラスと文言

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| クラス | 本番のファイル（テスト以外）は最上位に関数を置かず、クラスにする（static だけのクラスの補助は `static` / `private static`。インスタンスで使うクラス（`Logger`）の補助は `private` のインスタンスのメソッドにする。規則 `no-static-in-instance-class`、Issue #300）。backend と同じ規則 `class-based`（`rule-tests/architecture.test.ts`。`.claude/rules/code/architecture-check.md`）が検査する。Issue #262 で決めた | 決定は ADR `docs/adr/architecture/20261002-class-based-shared-and-test-support.md` | `rule-tests/architecture.test.ts` の `class-based`・`no-static-in-instance-class` |
| クラス | static だけのクラスは `biome.json` の override で `noStaticOnlyClass` を off にしている（`.claude/rules/quality/lint.md`） | - | `biome.json` の `noStaticOnlyClass`、`rule-tests/lint.test.ts` の `noStaticOnlyClass` |
| クラス | クラスの対応: `now.ts` の `Clock.now()`、`logger.ts` の `logger`（`Logger` のインスタンス。呼び出しは `logger.emit` のまま）、`log-event.ts` の `LogFieldMarks`（印 `sensitive` / `freeText` と `bounded` / `boundedFreeText` / `error`）・`FreeTextMask`（自由文の網 `mask` と上限 `limit`）・`RequestLogSchema`（`of`。export しない）・`LogSeverity`（`of`）、`env.ts` の `EnvReader`（`read` / `readTool`）・`DotEnvFile`（`load` / `findRepoRoot` / `loadFromRepoRoot`）。値の `env` / `toolEnv` / `LOG_EVENT_SCHEMAS` などはそのまま | - | 説明 |
| クラス | クラスの中の表・定数は static フィールドにせず、メソッドの中で作る（今の static フィールドは 0 件）。最上位の値（`LOG_EVENT_NAMES`・`MASK`・`LOG_EVENT_SCHEMAS`・`logger.ts` の文言の定数・`env` / `toolEnv` / `logger`）は置いてよい（上の行の「値はそのまま」） | static フィールドの初期化は読み込み時に 1 回だけ評価されるので、Stryker の ignoreStatic で検査から外れるおそれがある（未確認。ADR `docs/adr/architecture/20261002-class-based-backend.md`）。最上位の値も static な変異で検査から外れる（`.claude/rules/quality/testing.md`）ので、その中身は行の丸ごとの比較などのテストで固定する（上の「型とテスト」の `logger.test.ts`） | レビュー |
| クラス | `LOG_EVENT_SCHEMAS` が読み込み時に呼ぶクラス（`LogFieldMarks` など）は、それより前に書く | クラスの宣言は巻き上げられない | 説明 |
| 文言 | 文言（`env.ts` のエラー、`logger.ts` のメッセージ）は英語で書き、日本語のリテラルを置かない（規則 `server-hardcoded-text`） | 利用者に見せる文言は frontend の辞書（`apps/frontend_customer/` の `*.messages.ts`）だけで、運用者向けの文言は英語に統一する | `rule-tests/architecture.test.ts` の `server-hardcoded-text` |

## 型チェックとテスト

| カテゴリ | WHAT | WHY | 強制 |
| --- | --- | --- | --- |
| 型チェック | `apps/shared/tsconfig.json` は `apps/backend/tsconfig.json` と同じ方針（Next の plugin・jsx・DOM の型なし） | 限界: tsconfig の中身（`lib` など）はどの検査も見ない | レビュー |
| 型チェック | `pnpm typecheck` が `tsc -p apps/shared --noEmit` で検査する | - | `rule-tests/typecheck.test.ts` の `apps/shared` |
| テスト | テストは隣に置き、先頭に `// @vitest-environment node` | - | レビュー |
| テスト | カバレッジ（`vitest.config.mts` の `coverage.include`）と Stryker（`stryker.config.mjs` の `mutate`）の対象（`.claude/rules/quality/testing.md`） | - | 説明 |
| テスト | テストは同じディレクトリのファイルを相対パス（`./env`）で import する | Stryker のサンドボックスで `@repo/shared/...` から読むと、変異していない元のファイルに解決される（`stryker.config.mjs` の注意） | レビュー |

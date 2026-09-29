---
paths:
  - "rule-tests/architecture.test.ts"
---

# 依存の向きの検査（rule-tests/architecture.test.ts）

`rule-tests/architecture.test.ts`（`pnpm test` に含まれ、CI の `ci` ジョブで止まる）が、ディレクトリ構成の規則（`.claude/rules/backend.md`・`.claude/rules/frontend.md`・`.claude/rules/shared.md`）と環境変数の直参照の禁止（`.claude/rules/env.md`）、`console` の直接の呼び出しの禁止（`.claude/rules/backend.md` の「ログ」）、画面と、サーバ側（backend・shared）のハードコードの文言の禁止（Issue #116 の i18n）、画面・部品の辞書の置き場所（Issue #125）を 1 規則 = 1 テストで検査する。
ルール検査テストなので、must pass / must reject と fault injection が必須（`.claude/rules/testing.md`、手順はスキル `rule-check-test`）。

## 対象と抽出
- 対象: `apps/frontend/`・`apps/backend/`・`apps/shared/`（Issue #90）の全体（再帰。除くのは `node_modules/` と `.next/` だけで、ほかの `.` で始まるディレクトリも検査する）、`apps/e2e/`（workspace パッケージ `@repo/e2e`。Issue #84）、リポジトリ直下のファイル。拡張子は `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.jsx` / `.mjs` / `.cjs`（tsconfig の `allowJs: true` に合わせる）。テスト（`*.test.*`）は除く。
  - WHY テストを除く: テストは組み立てのために規則の外を参照する（presentation のテストが InMemory のリポジトリを使うなど）。
- import / re-export / dynamic import を正規表現で抜き出す（依存は足さない）。コメントと文字列の中の import 風の文字列は除く。``import(`x`)``（`${}` 無し）と第 2 引数つきの `import("x", { with: ... })` も拾う。
- 参照先の正規化: `@/x` → `apps/frontend/x`（backend のファイルに書いても frontend の paths が当たるため）、`@repo/backend/x` → `apps/backend/x`、`@repo/shared/x` → `apps/shared/x`（`@repo/backend-extra`・`@repo/shared-extra` は別パッケージ）、相対パスはリポジトリ相対、それ以外はパッケージ。`@/`・`@repo/backend/`・`@repo/shared/` の後ろの `..` も解決する。
- ハードコードの文言だけは構文木で見る（JSX のテキスト・属性・文字列リテラルの範囲を正規表現では正しく切り出せないため）。TypeScript 7.0.2 は JS のパーサ（`ts.createSourceFile`）を持たないので、同梱の tsgo を `typescript/unstable/sync` の API で起動し、仮想のファイルシステムに置いたソースの構文木を `forEachChild` の再帰でたどる（依存は足さない。`parseSourceFiles`）。
- 違反は「ファイル → 参照先」（環境変数・console・ハードコードの文言は「ファイル:行」）の一覧で出す。

## 規則（全部で 30 = 依存の 21 `RULES` + 置き場所 3 + 環境変数 1 + console 1 + exports 2 + ハードコードの文言 2）
- `frontend-to-backend-specifier`: `apps/frontend/`・`apps/e2e/`・リポジトリ直下から `apps/backend/` へは `@repo/backend/...` だけ。相対パスと `@/../backend/...` は、参照先が許される場所でも違反。例外は `vitest.global-setup.ts` → `apps/backend/shared/infra/database.test-support` の相対参照だけ（`TEST_INFRA_RELATIVE_EXCEPTION`。ファイルと参照先の組で絞る）。
- `frontend-to-shared-specifier`（Issue #90）: `apps/frontend/`・`apps/e2e/`・リポジトリ直下から `apps/shared/` へは `@repo/shared/...` だけ。相対パスと `@/../shared/...` は違反（例外なし）。`frontend-to-backend-specifier` を広げずに別の規則にしたのは、失敗したときにどちらの境界かが分かり、fault injection も独立にできるため。backend は対象外（backend の中の書き方は `backend-relative-only` が見る）。
- `backend-exports`: (1) 外の `@repo/backend/<path>` はすべて exports のキーに当たる（Node と同じく完全一致を優先し、次に `*` の前が最も長いパターン）、(2) 各キーは外から 1 か所以上で参照される、(3) キーは `./` で始まり、値はキーのパス + `.ts`、(4) キーが指すファイルがある（パターンなら 1 つ以上）。本番の検査では、exports を 1 件以上読めることと外の参照を取り出せていることも確かめる（読み込みや列挙が壊れて素通りしないため）。
- `shared-exports`（Issue #90）: `apps/shared/package.json` の exports を `backend-exports` と同じ関数（`findExportsViolations`。パッケージのディレクトリと名前だけを変える）で検査する。外は `apps/shared` の外（backend も含む）。本番ではキーが `./env`・`./logger` の 2 つであることも確かめる。
- `backend-to-frontend`: `apps/backend/`（層に属さない `shared/drizzle/drizzle.config.ts` を含む）は `apps/frontend/` を参照しない。
- `backend-relative-only`: backend の中の自前コードへは相対パスだけ（`@/` と `@repo/backend/` は不可。参照先ではなく specifier で判定する）。`apps/shared` へは `@repo/shared/...` だけ（相対パスと `@/../shared/` は不可。exports を経由させるため。Issue #90）。
- `frontend-root-to-backend`: `apps/frontend/` 直下のファイルは backend を参照しない（例外なし。以前の例外 env・logger は Issue #90 で `apps/shared` に移した）。
- `messages-colocation`（Issue #125）: 参照先（拡張子を除く）の名前が `.messages` で終わる自前のファイル（画面・部品の辞書 `*.messages.ts`）を参照してよいのは、同じディレクトリのファイルだけ（子・親のディレクトリも不可、書き方は `./` でも `@/` でも場所で見る）。例外は `apps/frontend/shared/i18n/common.messages`（共通の辞書）で、`apps/frontend/` のどこからでも可。参照元は全ファイル（`apps/e2e/` からは共通の辞書も不可）。テストは対象外（列挙がテストを除く）。`*.messages-helper`・`messages`（`.` の無いもの）・パッケージ（`some-lib/app.messages`）は対象外。`*.messages` の re-export（`export ... from`。型だけも）は、同じディレクトリでも共通の辞書でも違反（中継のファイル `zz-barrel.ts` を別のディレクトリから import すると素通りするため。抽出の `reExport`）。限界: import してから別の文で `export { x }` する中継は拾わない（from の無い export 文は参照として抽出しない）。
- `shared-self-contained`（Issue #90 の reviewer 指摘）: `apps/shared/` の中は `apps/shared/` の自前コードと `node:` の組み込みだけを参照する。backend・frontend（`@/`・`@repo/backend/`・`../backend/...`）、`next` / `react` / `react-dom`、DB（`drizzle-orm`・`pg`）、`node:` 以外のパッケージ（`zod`、`node:` の付かない `fs` も）は違反。WHY `node:` 以外を一律に不可（`package.json` の dependencies で許さない）: 依存を持たないパッケージで、依存を足すだけで通る形にすると置いてよいものの判断がレビューに出ない。足すときは Issue で決めて規則を広げる。
- `screen-to-shared`（Issue #90）: `apps/frontend/` の `app/`・`features/`・`shared/` は `apps/shared/` を参照しない（型だけでも不可。env・logger をブラウザのバンドルに持ち込まない）。
- `features/<f>/` の `api/` 以外と `shared/` は backend を参照しない。`features/<f>/api/` から backend へは `import type` / `export type` だけで、参照先は自 feature の `presentation/*.api` か `apps/backend/shared/presentation/`。
- 別の feature は `apps/frontend/features/<other>`（`/index`）だけ。`features/` と `shared/` は `app/` を参照しない。`shared/` は `features/` を参照しない。
- backend の 4 層は許可の一覧（`.claude/rules/backend.md` の表）: domain → domain / application → domain・application / presentation → application・domain（feature の domain は型だけ）・presentation・自 feature の `infra/<名前>-repository.postgres` と `apps/backend/shared/infra/database`（feature の presentation だけ。api ファイルが本番の handler を組み立てる。InMemory の実装・`schema`・前方一致だけの別ファイル・深い階層は不可。`isOwnPostgresRepository`。Issue #123）・`apps/shared/logger` / infra → domain・application・infra・`apps/shared/env`・`apps/shared/logger`（apps/shared の許可は `SHARED_MODULES_BY_LAYER`。Issue #90）。パッケージは `next` / `react` / `react-dom`（サブパス含む）以外を許す。層を持つのは `apps/backend/features/<f>/` と `apps/backend/shared/` だけで、自 feature と backend/shared は名前ではなく場所で見分ける（`features/shared/` という feature は backend/shared ではない。`BackendLocation` の `scope`。Issue #98）。
- `core-to-persistence`: backend の domain・application（shared を含む）は DB のパッケージ（`drizzle-orm` とサブパス、`pg`。`pg-format` のような前方一致だけの別パッケージは対象外）を参照しない（`import type` も不可）。DB のパッケージを足したら `PERSISTENCE_PACKAGES` にも足す。
- `apps/backend/shared/`（`shared/drizzle/drizzle.config.ts` を含む）が参照してよい自前コードは shared の中と `apps/shared/` だけ。`next` / `react` / `react-dom` も不可。
- `app/`（`app/api` 以外）が features / backend / shared を参照するなら `apps/frontend/features/<f>`（`/index`）か `apps/frontend/shared/` だけ。パッケージと `app/` の中の相対参照（`./globals.css`）は検査しない。`app/api/` が参照してよいのは `apps/backend/features/<f>/presentation/*.api`（と `apps/backend/shared/presentation/*.api`）だけ。
- 置き場所: `shared-placement`（Issue #90。`apps/shared/` に置いてよいのは `env.ts`・`logger.ts`・`env.test.ts`・`logger.test.ts`・`package.json`・`tsconfig.json` だけ。ソース以外も含め全ファイルを見る。`SHARED_FILES` と `SHARED_PLACEMENT_EXAMPLES`）、`backend-placement`（Issue #98。`apps/backend/features/<f>/` か `apps/backend/shared/` の 4 層の下だけ。例外は `apps/backend/shared/drizzle/drizzle.config.<拡張子>` だけで、`features/` 直下・`features/` を挟まない `apps/backend/<x>/`・`shared/drizzle/` のほかのソースは違反。ソースだけを見るので、`package.json`・`tsconfig.json`・生成した `*.sql`・`meta/*.json` は対象外）、`frontend-placement`（`app/`・`features/`・`shared/` か直下の 5 ファイル: `next.config.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`proxy.ts`・`next-env.d.ts`。`middleware.ts` と `proxy.js` は違反）。参照の有無に関係なく違反。`apps/e2e/` とリポジトリ直下のファイルも判定に通すが、どちらの規則の対象でもない（`PLACEMENT_EXAMPLES` / `FRONTEND_PLACEMENT_EXAMPLES` と fixture で固定。Issue #84）。
- `env-direct-access`: `process.env`（空白・改行を挟むもの、`process?.env`、`globalThis.process.env` / `global.process.env`、`(process).env`）と `process["env"]` / `process['env']` を、`apps/shared/env.ts` 以外で違反にする。例外は `apps/frontend/instrumentation.ts` の `NEXT_RUNTIME` だけ（`allowedVariables`）。対象は依存の検査と同じファイルに `apps/e2e/` とリポジトリ直下の設定・セットアップファイルを足したもの。判定の例は `ENV_ACCESS_EXAMPLES`。
- `console-direct-access`（Issue #85）: `console` という識別子（`console.log` / `console?.log` / `console["log"]`、`globalThis.console` / `global.console`、`(console)`、別名・分割代入・引数に渡すものも含む。`consoleLog`・`myconsole`・`console_` は別の識別子）を、`apps/shared/logger.ts` 以外で違反にする。対象は `env-direct-access` と同じファイルに `scripts/` のソース（テスト以外。今は無い）を足したもの。判定の例は `CONSOLE_ACCESS_EXAMPLES`。Biome の `noConsole` と 2 系統にする理由は ADR `docs/adr/architecture/20260929-logger-single-exit.md`、どちらか片方だけが拾う書き方は `rule-tests/architecture.test.ts` のコメントと「console の参照の抽出」のテスト。

- `frontend-hardcoded-text`（Issue #116）: `apps/frontend/` のテスト以外のソース（辞書 `apps/frontend/**/*.messages.ts` は `defineMessages(...)` の呼び出しの引数の中だけを除き、引数の外（トップレベルの `const label = "削除"`、ほかの関数の引数、`createElement` の日本語）は同じ検査。呼び出しは名前 `defineMessages` だけで見る。Issue #125 で `shared/i18n/messages/` の直下から変え、reviewer の指摘でファイルごとの除外をやめた。`.messages.tsx`・`*-messages.ts`・`*.messages.helper.ts` と旧置き場所の `messages/ja.ts` は引数の中も除かない）で、(1) JSX のテキストに空白以外の文字がある（英語も）、(2) 利用者に見える属性（`VISIBLE_TEXT_ATTRIBUTES`: `aria-label`・`aria-description`・`placeholder`・`title`・`alt`・`label`）の値が文字列リテラル・テンプレートリテラル（`"x"`・`{"x"}`・``{`x ${y}`}``）で空白以外の文字を持つ、(3) どこであれ文字列リテラル・テンプレートリテラル（型の位置、エスケープを解釈した値も）に日本語（`\p{Script=Hiragana}`・`Katakana`・`Han`）がある、のどれかを違反にする。通すもの: `{t("...")}`・`aria-label={t("x", { title })}`、一覧に無い属性（`className` など）、空白だけの値（`alt=""`）と埋め込み式だけのテンプレート、JSX ではない ASCII の文字列（`layout.tsx` の `metadata.title`）、コメント（構文木に現れない）。1 つの値が (2) と (3) の両方に当たっても 1 件。判定の例は `HARDCODED_TEXT_EXAMPLES`。
- `server-hardcoded-text`（Issue #116。もとの名前は `backend-hardcoded-text`。`apps/shared` を対象に加えて改名）: `apps/backend/` と `apps/shared/` のテスト以外のソースで、上の (3) だけを違反にする（例外なし。エラーは `ErrorKey` と params で表す）。英語は止めない（Problem Details の `detail` の英語は `apps/backend/shared/presentation/problem-detail.en.ts` の 1 か所に書く規約で、この規則では検査しない。Issue #126）。ログのメッセージ・開発者向けのエラー（`database.test-support.ts` のようなテスト以外の補助、`apps/shared/env.ts` のエラー、`logger.ts` のメッセージも）も対象で、運用者向けの文言は英語で書く。JSX のテキストと属性は見ない（ASCII の文字列は ErrorKey・ログ・SQL など文言でないものが大半のため）。

## テストの持ち方
- 規則ごとに判定の例（`RULE_EXAMPLES`。違反になる例・ならない例を架空の参照で 3 件以上ずつ）。今のコードに違反が無いことだけでは、規則が緩すぎても気づけない。`RULES` のすべての規則に例があることもテストで確かめる。exports は `resolveExportKey`・`findExportsViolations` に当たる例・当たらない例・違反の例を持つ。
- fixture（`collectViolations(root)`）: 一時ディレクトリに架空のツリーを作り、本番と同じ列挙 → 抽出 → 正規化 → 判定に通す。
  - must-reject（`MUST_REJECT_FILES` / `MUST_REJECT_VIOLATIONS`）: 全規則の違反を、alias と相対パス、値の import / `import type` / inline の `type` / `export { X } from` / `export type { X } from` / dynamic `import()` / 副作用だけの import、8 つの拡張子で置き、前方一致の境界（`apps/backend/shared-x`・`apps/frontend/app/api-x`・`apps/frontend/features/todo-extra`）とパスに `test` を含む本番のファイルも含めて、検出の一覧を丸ごと比較する。
  - must-pass（`MUST_PASS_FILES`）: 許可される参照を網羅したツリーで違反 0 件。今の本番コードの参照の形はすべて含める。コメント・文字列の中の import 風の文字列、テストファイル、TS / JS 以外、生成物・依存（`apps/frontend/.next/`・`apps/backend/node_modules/`）の中の違反も置く。
  - WHY: 抽出の取りこぼしは、規則が正しくても見逃しになる。1 件の参照を判定に渡すだけではそこを検証できない。

## 規則を足す・変えるとき
- `RULES` と `RULE_EXAMPLES`、置き場所の規則（`BACKEND_PLACEMENT` と `PLACEMENT_EXAMPLES`、`SHARED_PLACEMENT` と `SHARED_PLACEMENT_EXAMPLES`）、fixture の `MUST_REJECT_FILES` / `MUST_REJECT_VIOLATIONS` / `MUST_PASS_FILES` を同じ変更で直す。本番コードに新しい import の形（層の組み合わせや書き方）を足したときも、must-pass に同じ形を足す。
- ハードコードの文言の規則を変えるとき（属性の一覧 `VISIBLE_TEXT_ATTRIBUTES`、辞書の例外 `I18N_MESSAGES`（`*.messages.ts`）と `defineMessages` の引数の判定（`isDefineMessagesCall`）、日本語の判定 `JAPANESE`）は、`HARDCODED_TEXT_EXAMPLES`・「ハードコードの文言の抽出」のテスト・fixture を同じ変更で直す。
- `.claude/rules/backend.md`・`frontend.md`・`shared.md` の規則の文と、テストの規則を突き合わせる。

## 限界（見逃す方向と多く検出する方向）
- 見逃す: 正規表現リテラルやテンプレートリテラルの入れ子でコメント・文字列の区切りを誤認しうる、`${}` の中の `import()`、``import(`@repo/backend/${name}`)``（静的に決められない）、`}` の直後に同じ行で続けた `export ... from`。
- 多く検出する: 型の位置の `import("x").T` は値の参照として数える。
- `frontend-to-backend-specifier`・`frontend-to-shared-specifier` と `backend-exports`・`shared-exports` は `apps/frontend/`・`apps/backend/`・`apps/shared/`・`apps/e2e/`・リポジトリ直下のファイルしか見ない（`scripts/*.ts` のテスト以外などは見ない。今は該当なし）。足すときは `listReferencingFiles` と fixture も直す。
- ハードコードの文言: ASCII の文字列を変数に入れてから JSX に渡す（`const s = "x"; <p>{s}</p>`）、JSX の子に式で書く（`<p>{"x"}</p>`）、一覧に無い props（`<Dialog heading="x" />`）、三項演算子の中（`title={c ? "A" : "B"}`）は見逃す（日本語なら (3) で止まる。「ハードコードの文言の抽出」のテストで固定）。`apps/shared/`・`apps/e2e/`・リポジトリ直下は対象外。逆に、一覧の属性の文言ではない値（`title="-"`）は多く検出する。`typescript/unstable/*` は TypeScript を上げると形が変わりうる（版は完全固定なので、上げたときにこのテストの失敗で気づく）。tsgo を閉じるときに stderr に `context canceled` が出ることがあるが、結果には関係しない。
- 環境変数の抽出の限界（分割代入など）は `.claude/rules/env.md`、console の抽出の限界（`node:console` の import、`${}` の中）は「console の参照の抽出」のテストで固定。詳細と WHY は `rule-tests/architecture.test.ts` のコメントと、「参照の抽出」「参照先の正規化」「環境変数の直参照の抽出」のテスト。

## 採用しなかった検査の手段
- Biome の `noRestrictedImports`（`import type` だけを許せない。feature・層ごとの `overrides` が要る）、dependency-cruiser（TypeScript 7 に未対応）。詳細は ADR `docs/adr/quality/20260928-dependency-direction-checked-by-own-test.md`。

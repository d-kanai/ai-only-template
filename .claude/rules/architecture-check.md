---
paths:
  - "architecture.test.ts"
---

# 依存の向きの検査（architecture.test.ts）

`architecture.test.ts`（`pnpm test` に含まれ、CI の `ci` ジョブで止まる）が、ディレクトリ構成の規則（`.claude/rules/backend.md`・`.claude/rules/frontend.md`）と環境変数の直参照の禁止（`.claude/rules/env.md`）を 1 規則 = 1 テストで検査する。
ルール検査テストなので、must pass / must reject と fault injection が必須（`.claude/rules/testing.md`、手順はスキル `rule-check-test`）。

## 対象と抽出
- 対象: `apps/frontend/` と `apps/backend/` の全体（再帰。除くのは `node_modules/` と `.next/` だけで、ほかの `.` で始まるディレクトリも検査する）、`e2e/`、リポジトリ直下のファイル。拡張子は `.ts` / `.tsx` / `.mts` / `.cts` / `.js` / `.jsx` / `.mjs` / `.cjs`（tsconfig の `allowJs: true` に合わせる）。テスト（`*.test.*`）は除く。
  - WHY テストを除く: テストは組み立てのために規則の外を参照する（presentation のテストが InMemory のリポジトリを使うなど）。
- import / re-export / dynamic import を正規表現で抜き出す（依存は足さない）。コメントと文字列の中の import 風の文字列は除く。``import(`x`)``（`${}` 無し）と第 2 引数つきの `import("x", { with: ... })` も拾う。
- 参照先の正規化: `@/x` → `apps/frontend/x`（backend のファイルに書いても frontend の paths が当たるため）、`@repo/backend/x` → `apps/backend/x`（`@repo/backend-extra` は別パッケージ）、相対パスはリポジトリ相対、それ以外はパッケージ。`@/` と `@repo/backend/` の後ろの `..` も解決する。
- 違反は「ファイル → 参照先」（環境変数は「ファイル:行」）の一覧で出す。

## 規則（全部で 21 = 依存の 17 `RULES` + 置き場所 2 + 環境変数 1 + exports 1）
- `frontend-to-backend-specifier`: `apps/frontend/`・`e2e/`・リポジトリ直下から `apps/backend/` へは `@repo/backend/...` だけ。相対パスと `@/../backend/...` は、参照先が許される場所でも違反。例外は `vitest.global-setup.ts` → `apps/backend/shared/infra/database.test-support` の相対参照だけ（`TEST_INFRA_RELATIVE_EXCEPTION`。ファイルと参照先の組で絞る）。
- `backend-exports`: (1) 外の `@repo/backend/<path>` はすべて exports のキーに当たる（Node と同じく完全一致を優先し、次に `*` の前が最も長いパターン）、(2) 各キーは外から 1 か所以上で参照される、(3) キーは `./` で始まり、値はキーのパス + `.ts`、(4) キーが指すファイルがある（パターンなら 1 つ以上）。本番の検査では、exports を 1 件以上読めることと外の参照を取り出せていることも確かめる（読み込みや列挙が壊れて素通りしないため）。
- `backend-to-frontend`: `apps/backend/`（直下の `drizzle.config.ts` を含む）は `apps/frontend/` を参照しない。
- `backend-relative-only`: backend の中は相対パスだけ（参照先ではなく specifier で判定する）。
- `frontend-root-to-backend`: `apps/frontend/` 直下のファイルが backend を参照するなら `apps/backend/shared/infra/env` だけ。
- `features/<f>/` の `api/` 以外と `shared/` は backend を参照しない。`features/<f>/api/` から backend へは `import type` / `export type` だけで、参照先は自 feature の `presentation/*.api` か `apps/backend/shared/presentation/`。
- 別の feature は `apps/frontend/features/<other>`（`/index`）だけ。`features/` と `shared/` は `app/` を参照しない。`shared/` は `features/` を参照しない。
- backend の 4 層は許可の一覧（`.claude/rules/backend.md` の表）: domain → domain / application → domain・application / presentation → application・domain（feature の domain は型だけ）・presentation・自 feature の `infra/container` / infra → domain・application・infra。パッケージは `next` / `react` / `react-dom`（サブパス含む）以外を許す。
- `core-to-persistence`: backend の domain・application（shared を含む）は DB のパッケージ（`drizzle-orm` とサブパス、`pg`。`pg-format` のような前方一致だけの別パッケージは対象外）を参照しない（`import type` も不可）。DB のパッケージを足したら `PERSISTENCE_PACKAGES` にも足す。
- `apps/backend/shared/` が参照してよい自前コードは shared の中だけ。`next` / `react` / `react-dom` も不可。
- `app/`（`app/api` 以外）が features / backend / shared を参照するなら `apps/frontend/features/<f>`（`/index`）か `apps/frontend/shared/` だけ。パッケージと `app/` の中の相対参照（`./globals.css`）は検査しない。`app/api/` が参照してよいのは `apps/backend/<x>/presentation/*.api` だけ。
- 置き場所: `backend-placement`（4 層の下か直下の `<name>.config.<拡張子>`）、`frontend-placement`（`app/`・`features/`・`shared/` か直下の 4 ファイル）。参照の有無に関係なく違反。
- `env-direct-access`: `process.env`（空白・改行を挟むもの、`process?.env`、`globalThis.process.env` / `global.process.env`、`(process).env`）と `process["env"]` / `process['env']` を、`apps/backend/shared/infra/env.ts` 以外で違反にする。例外は `apps/frontend/instrumentation.ts` の `NEXT_RUNTIME` だけ（`allowedVariables`）。対象は依存の検査と同じファイルに `e2e/` とリポジトリ直下の設定・セットアップファイルを足したもの。判定の例は `ENV_ACCESS_EXAMPLES`。

## テストの持ち方
- 規則ごとに判定の例（`RULE_EXAMPLES`。違反になる例・ならない例を架空の参照で 3 件以上ずつ）。今のコードに違反が無いことだけでは、規則が緩すぎても気づけない。`RULES` のすべての規則に例があることもテストで確かめる。exports は `resolveExportKey`・`findExportsViolations` に当たる例・当たらない例・違反の例を持つ。
- fixture（`collectViolations(root)`）: 一時ディレクトリに架空のツリーを作り、本番と同じ列挙 → 抽出 → 正規化 → 判定に通す。
  - must-reject（`MUST_REJECT_FILES` / `MUST_REJECT_VIOLATIONS`）: 全規則の違反を、alias と相対パス、値の import / `import type` / inline の `type` / `export { X } from` / `export type { X } from` / dynamic `import()` / 副作用だけの import、8 つの拡張子で置き、前方一致の境界（`apps/backend/shared-x`・`apps/frontend/app/api-x`・`apps/frontend/features/todo-extra`）とパスに `test` を含む本番のファイルも含めて、検出の一覧を丸ごと比較する。
  - must-pass（`MUST_PASS_FILES`）: 許可される参照を網羅したツリーで違反 0 件。今の本番コードの参照の形はすべて含める。コメント・文字列の中の import 風の文字列、テストファイル、TS / JS 以外、生成物・依存（`apps/frontend/.next/`・`apps/backend/node_modules/`）の中の違反も置く。
  - WHY: 抽出の取りこぼしは、規則が正しくても見逃しになる。1 件の参照を判定に渡すだけではそこを検証できない。

## 規則を足す・変えるとき
- `RULES` と `RULE_EXAMPLES`、置き場所の規則（`BACKEND_PLACEMENT` と `PLACEMENT_EXAMPLES`）、fixture の `MUST_REJECT_FILES` / `MUST_REJECT_VIOLATIONS` / `MUST_PASS_FILES` を同じ変更で直す。本番コードに新しい import の形（層の組み合わせや書き方）を足したときも、must-pass に同じ形を足す。
- `.claude/rules/backend.md`・`frontend.md` の規則の文と、テストの規則を突き合わせる。

## 限界（見逃す方向と多く検出する方向）
- 見逃す: 正規表現リテラルやテンプレートリテラルの入れ子でコメント・文字列の区切りを誤認しうる、`${}` の中の `import()`、``import(`@repo/backend/${name}`)``（静的に決められない）、`}` の直後に同じ行で続けた `export ... from`。
- 多く検出する: 型の位置の `import("x").T` は値の参照として数える。
- `frontend-to-backend-specifier` と `backend-exports` は `apps/`・`e2e/`・リポジトリ直下のファイルしか見ない（`scripts/*.ts` のテスト以外などは見ない。今は該当なし）。足すときは `listReferencingFiles` と fixture も直す。
- 環境変数の抽出の限界（分割代入など）は `.claude/rules/env.md`。詳細と WHY は `architecture.test.ts` のコメントと、「参照の抽出」「参照先の正規化」「環境変数の直参照の抽出」のテスト。

## 採用しなかった検査の手段
- Biome の `noRestrictedImports`（`import type` だけを許せない。feature・層ごとの `overrides` が要る）、dependency-cruiser（TypeScript 7 に未対応）。詳細は `docs/architecture-decisions.md`。

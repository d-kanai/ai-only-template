---
paths:
  - "package.json"
  - "apps/*/package.json"
  - "pnpm-workspace.yaml"
  - "pnpm-lock.yaml"
  - "patches/**"
  - "rule-tests/package.test.ts"
  - "rule-tests/pnpm-workspace.test.ts"
  - ".github/renovate.json5"
  - "rule-tests/licenses.test.ts"
---

# 依存パッケージ

npm パッケージの版は `package.json` と `pnpm-lock.yaml` の両方で固定し、意図した版だけが入る状態を保つ。
追加・更新・lockfile の作り直し・pnpm patch の手順はスキル `dependency-update`。実測（lockfile の再解決、safe-chain、TS 7 の確認など）は 2026-09-28 の work-logs。

## workspace の package.json（Issue #68）
- pnpm workspace（`pnpm-workspace.yaml` の `packages: ["apps/*"]`）で、`package.json` はリポジトリ直下・`apps/frontend_customer`（`@repo/frontend-customer`）・`apps/backend`（`@repo/backend`）・`apps/e2e`（`@repo/e2e`。Issue #84）・`apps/shared`（`@repo/shared`。Issue #90）の 5 つ。lockfile と pnpm の設定（サプライチェーン保護・`allowBuilds`・`patchedDependencies`）はリポジトリ直下に 1 つで、workspace 全体に効く。
- 置き場所: そのパッケージのコードが import するものを、そのパッケージの `package.json` に置く（`next` / `react` / `react-dom` は frontend、`drizzle-orm` / `pg` / `zod` / `drizzle-kit` は backend（`zod` は入力検証と domain の不変条件。Issue #88）、`@playwright/test`・`playwright-bdd`（E2E の `.feature` の実行。Issue #279）と E2E が DB を見るための `pg` / `@types/pg` は e2e）。workspace のパッケージも同じく、使うパッケージに `workspace:*` で置く（`@repo/backend` は frontend、`@repo/shared` は frontend・backend・e2e・リポジトリ直下（`vitest.global-setup.ts`））。`apps/shared` 自身の依存は `zod` だけ（logger のスキーマ。Issue #216。版は backend と同じで、`rule-tests/package.test.ts` が workspace をまたいで同じ版であることを検査する。ほかは Node 標準だけで、パッケージの許可は `rule-tests/architecture.test.ts` の `SHARED_ALLOWED_PACKAGES`。`.claude/rules/code/shared.md`）。リポジトリ直下のツールとテストだけが使うもの（Biome・Lefthook・Vitest・Testing Library・Stryker・TypeScript・`@types/node`）はリポジトリ直下。
  - WHY: pnpm は宣言した依存だけを `<パッケージ>/node_modules` に置くので、宣言していないパッケージは import できない。テストはリポジトリ直下の Vitest が動かし、Node の解決は親の `node_modules` も探すので `apps/*` のテストからも見える。
- 同じパッケージを複数の `package.json` に置くときは同じ版にする（`rule-tests/package.test.ts` の `findInconsistentVersions` が止める）。WHY: 片方だけ上げると workspace に 2 つの版が入り、どのコードがどの版で動くかが読めなくなる。
  - `@testing-library/react` の peer（`react` / `react-dom`）は、pnpm が workspace の中の `react@19.2.8` で解決している（lockfile の importers の `.`）。React を上げるときは lockfile のこの行も同じ版か確かめる（別の版だと画面のテストで React が 2 つ読み込まれ hook が動かない見込み。未確認）。
- `packageManager`（pnpm の版）はリポジトリ直下にだけ書く（`.claude/rules/tooling/env.md`）。
- リポジトリ直下の `package.json` の scripts で `pnpm --filter <パッケージ名>` を使うときは `--fail-if-no-match` を付ける（Issue #134）。WHY: pnpm は `--filter` に一致するパッケージが 0 件でも何も実行せず exit 0 で終わる（pnpm 12.7.0 で実測）。パッケージを改名して scripts を直し忘れると、`pnpm build` などが何もせずに成功したように見える。
- `apps/backend/package.json` の `exports` は `.claude/rules/code/backend.md`、`apps/shared/package.json` の `exports` は `.claude/rules/code/shared.md`。

## 完全固定
- workspace のすべての `package.json` の `dependencies` / `devDependencies` は `x.y.z`（数字 3 つ）だけで書く。`^` `~` `>=` `*` `latest`、プレリリース（`1.2.3-beta.1`）、ビルドメタ（`1.2.3+build`）、`=1.2.3` / `v1.2.3` は使わない。
  - WHY: lockfile だけに頼ると `pnpm update` や再解決で範囲内の別の版が入りうる。PR の差分で「どの版からどの版へ」が見える。プレリリースは semver の互換性の約束の外、ビルドメタは比較で無視されて別ビルドを区別できない。書き方は 1 通りにする（Issue #50）。使う必要が出たら Issue で決める。
- 例外: workspace の中のパッケージへの依存は `workspace:*` だけ（`"@repo/backend": "workspace:*"`）。
  - WHY: レジストリではなくリポジトリの中のソースへの symlink で、範囲内の別の版が入ることが起きない。`workspace:^` / `workspace:~` / `workspace:1.2.3` は書き方を 1 通りにするため使わない（公開しない private のパッケージで、`apps/*` は `version` を書かない）。
- `pnpm-workspace.yaml` の `savePrefix: ''` で `pnpm add` も完全固定で書かれるが、版は明示する（`pnpm add <pkg>@2` のように範囲を渡すと範囲のまま書かれる）。
- 担保: `rule-tests/package.test.ts`（判定 `isPinnedVersion` / `isAllowedVersion`、列挙 `listWorkspaceManifests` は `pnpm-workspace.yaml` の `<ディレクトリ>/*` の形だけを扱い、それ以外の形は失敗する。リポジトリ直下・`apps/backend`・`apps/e2e`・`apps/frontend_customer`・`apps/shared` が列挙に入ることも確かめる）。

## 版の決め方
- 原則 **latest**（npm レジストリの dist-tags が 1 次情報）。ただし公開から 5 日未満の版は入らないので、5 日以上経った版のうち最新を使い、latest でなければ理由を PR に書く。
  - リポジトリの pnpm は `minimumReleaseAge: 7200`（分 = 5 日。`rule-tests/pnpm-workspace.test.ts` が値を検査）。開発機の safe-chain は 14 日。pnpm 側を 14 日に揃えないのは、Next.js などへの追随が 2 週間遅れになるため（Issue #32 のユーザー判断）。pnpm 側の設定は safe-chain の有無（クラウド・CI）に関係なく効く。
  - `packageManager`（pnpm 本体）の解決はこの対象外（実測。`.tool-versions` と `packageManager` で明示するので影響はない）。
- TypeScript は最新版を使う（7.0.2 で `next build` の型チェックと Vitest の動作を確認済み）。
- 更新は Issue → PR で行う。

## 自動更新（Renovate。Issue #111）
- Renovate の GitHub App が `.github/renovate.json5` を読み、週 1 回、公開から 5 日経った版への更新の PR を作る。決定と Dependabot を採らなかった理由は ADR `docs/adr/tech-stack/20261003-renovate-for-dependency-updates.md`、人との分担と PR の確かめ方はスキル `dependency-update` の 0.。
- Renovate の待つ日数（`minimumReleaseAge`）は `pnpm-workspace.yaml` の `minimumReleaseAge` と同じ日数にし、`internalChecksFilter: strict` で待つ間は PR を作らせない。pnpm patch を当てた依存は Renovate で更新しない（`enabled: false`）。担保: `rule-tests/pnpm-workspace.test.ts`。WHY: 5 日未満の版の PR は PR の中の install が `minimumReleaseAgeStrict` で落ちる。パッチのキーは版まで固定で、版が変わるとパッチが当たらなくなる。
- 作業ログの CI は、作者が `renovate[bot]` で依存のファイルだけを変えた PR を通す（`.claude/rules/tooling/work-log-hooks.md`）。
- patch / minor は CI が緑なら自動マージ、メジャーと Next.js / React は人が確かめる（Issue #375、ADR `docs/adr/tech-stack/20261003-renovate-automerge-patch-minor.md`）。メジャーに automerge が付かないことは `rule-tests/pnpm-workspace.test.ts` が検査する。

## 例外の版
- フレームワークが版を固定して要求するものは、それに従い、理由をここに書く。
- React / React DOM 19.2.8: create-next-app@16.3.6 が生成する `package.json` の版に合わせる（同パッケージの `dist/index.js` で確認）。
- `@types/node`: `.tool-versions` の Node メジャー（24）に合わせた 24.x の最新。WHY: 実行環境より新しい Node の API の型が使えると、実行時に無い API を呼ぶコードが型チェックを通る。Node の LTS を上げるときに一緒に上げる。

## pnpm patch
- 依存の不具合を上流の修正を待たずに直すときだけ使う。条件（すべて）: 上流の不具合で設定や使い方では避けられない / 修正が数行 / 上流の Issue・PR を確認し `patchedDependencies` のコメントにリンク（無い・確認できないならその旨と理由）/ 当てる前に不具合を再現し、当てて直ることを実測する。
- パッチは `patches/<pkg>@<版>.patch`、対応は `pnpm-workspace.yaml` の `patchedDependencies`。何を・なぜ直したかは `pnpm-workspace.yaml` と、そのパッケージを使う設定ファイルのコメントに書く。`patches/`・`pnpm-workspace.yaml`・`pnpm-lock.yaml` は同じコミットに入れる（lockfile にパッチのハッシュが入る）。
- 上流が直した版が出たら、その版に上げてパッチを消す（キーは版まで固定なので、版を上げるたびに要否を見直す）。
- 現在のパッチ: `@stryker-mutator/vitest-runner@10.0.0`（Issue #52）: テスト名の連結を ` > ` にする（Vitest 5.0.1 との組み合わせの不具合）。上流の Issue / PR の有無は未確認（GitHub の Issue 検索がこの環境から 403）。詳細は `stryker.config.mjs` と ADR `docs/adr/tech-stack/20260928-patch-stryker-vitest-runner.md`。

## ライセンス（Issue #368）
- 依存（推移的な依存・devDependencies を含む）のライセンスは許可リストで止める。許可リストは許容型（MIT・ISC・Apache-2.0・BSD など）だけで、それ以外は名前とライセンスの組と理由を例外に書いたものだけを許す。強制は `rule-tests/licenses.test.ts`（`pnpm -r licenses list --json` を読む。`pnpm test` の中で動くので CI の `ci` ジョブで止まる。許可リスト・例外・限界はテストの冒頭、決定は ADR `docs/adr/quality/20261003-dependency-license-allow-list.md`）。
  - WHY: GPL / AGPL のような強いコピーレフト・商用の制限付き・ライセンス無しの依存が、依存の追加や更新で推移的に入っても気づけない（daiki の希望 2026-10-03）。
  - 落ちたら: そのパッケージのライセンスの中身と使われ方（`pnpm why -r <名前>`）を確かめ、使ってよければ許可リスト（許容型のとき）か例外（名前を限るとき）に理由を書いて足す。使えなければ別のパッケージにする。
  - 日次のジョブは置かない（公開済みの版は差し替えられず、lockfile が変わらなければライセンスも変わらない。lockfile が変わる PR では毎回動く）。

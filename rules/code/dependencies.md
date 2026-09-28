# 依存パッケージルール

npm パッケージの版は `package.json` と `pnpm-lock.yaml` の両方で固定し、意図した版だけが入る状態を保つ。

## workspace の package.json（Issue #68 の段階 2）
- pnpm workspace（`pnpm-workspace.yaml` の `packages: ["apps/*"]`）で、`package.json` はリポジトリ直下・`apps/frontend`（`@repo/frontend`）・`apps/backend`（`@repo/backend`）の 3 つ。lockfile（`pnpm-lock.yaml`）と pnpm の設定（`pnpm-workspace.yaml`。サプライチェーン保護・`allowBuilds`・`patchedDependencies`）はリポジトリ直下に 1 つで、workspace 全体に効く。
- どこに置くか: そのパッケージのコードが import するものを、そのパッケージの `package.json` に置く（`next` / `react` は frontend、`drizzle-orm` / `pg` / `drizzle-kit` は backend）。ツールとテストだけが使うもの（Biome・Vitest・Testing Library・Playwright・Stryker・TypeScript・`@types/node`）はリポジトリ直下。何をどこに置いたかの一覧と WHY は `rules/code/architecture.md` の「workspace パッケージと exports」。
  - 同じパッケージを複数の `package.json` に置くときは同じ版にする（今は `pg` / `@types/pg` がリポジトリ直下（E2E 用）と `apps/backend` の両方）。版を上げるときは両方を上げる。
- `apps/backend/package.json` の `exports` は、frontend / e2e / 設定が使うアプリの入口だけを公開する（一覧と足し方は `rules/code/architecture.md` の「exports」）。テスト基盤（`database.test-support`）は公開面に含めず、`vitest.global-setup.ts` から相対パスで読む。
- `packageManager`（pnpm の版）はリポジトリ直下の `package.json` にだけ書く（`rules/code/env.md`）。

## 完全固定
- workspace のすべての `package.json`（リポジトリ直下と `apps/*`）の `dependencies` / `devDependencies` はすべて完全固定（`x.y.z`）で書く。`^` `~` `>=` などの範囲指定は使わない。
- 例外: workspace の中のパッケージへの依存（`"@repo/backend": "workspace:*"`）は `workspace:*` と書く（Issue #68 の段階 2）。
  - 理由: `workspace:` はレジストリの版ではなく、同じリポジトリの中のパッケージ（`apps/backend`）への symlink になる。入る中身は常にリポジトリの中のソースで、「範囲内の別の版が入る」ことが起きないので、完全固定の狙いは満たす。
  - `workspace:^` / `workspace:~` / `workspace:1.2.3` は使わない。書き方を 1 通りにするため（`^` / `~` は公開時に範囲へ置き換わる書き方で、公開しない private のパッケージでは意味がない。版の指定は参照先の `version` と一致する必要があり、`apps/*` は `version` を書かない）。
- 理由: lockfile だけに頼ると、`pnpm update` や lockfile の再解決で範囲内の別の版が入りうる。`package.json` でも版を固定して意図しない版が入るのを防ぐ。あわせて、PR の差分で「どの版からどの版へ」が `package.json` 上で見えるようにする。
- プレリリース（`1.2.3-beta.1`）とビルドメタ（`1.2.3+build`）も使わない（`x.y.z` の数字 3 つだけ。Issue #50 で決定）。理由: プレリリースは安定版の前提（semver の互換性の約束）から外れ、ビルドメタは版の比較で無視されて同じ `x.y.z` の別ビルドを区別できない。`=1.2.3` / `v1.2.3` も、書き方を 1 通りにするため使わない。使う必要が出たら Issue で決める。
- 担保: `package.test.ts` が workspace のすべての `package.json` に範囲指定が残っていないことを検査する（`pnpm test` に含まれる）。判定（`isPinnedVersion`）は、許可する例（`1.2.3` など）と拒否する例（`^` / `~` / `>=` / `1.2.x` / `1.2` / `*` / `latest` / `workspace:*` / `npm:` の別名 / 空文字 / プレリリース / ビルドメタなど）の両方で固定している。`workspace:*` だけを許す例外は `isAllowedVersion` で、`workspace:^` / `workspace:~` / `workspace:1.2.3` などは拒否する例で固定している。
  - 対象の `package.json` は `pnpm-workspace.yaml` の `packages`（`<ディレクトリ>/*` の形だけを扱い、それ以外の形は読み落とさずに失敗する）から列挙する（`listWorkspaceManifests`）。リポジトリ直下・`apps/backend`・`apps/frontend` が列挙に入っていることも確かめる（列挙が漏れると、そのパッケージは検査されないまま通るため）。

## 版の決め方
- 原則 **latest**。npm レジストリの dist-tags を 1 次情報として確認する。
  ```
  curl -s https://registry.npmjs.org/<pkg> | jq -r '.["dist-tags"].latest'
  ```
- ただし safe-chain（開発機）と pnpm の `minimumReleaseAge`（`pnpm-workspace.yaml`）により、公開直後の版は入らない。その場合は入る版のうち最新を使い、理由を PR に書く。
  - 開発機の safe-chain は公開から 14 日（`~/.aikido/config.json` の最小パッケージ年齢）、リポジトリの pnpm は 5 日（`minimumReleaseAge: 7200`、単位は分）。pnpm 側を 14 日に揃えないのは、Next.js などの更新に 2 週間遅れで追随することになるため（Issue #32 でのユーザー判断）。pnpm 側の設定は safe-chain の有無（クラウドセッション・CI）に関係なく効く。値は `pnpm-workspace.test.ts` で検査している。例外: `packageManager`（pnpm 本体）の解決は対象外で、公開 5 日未満の pnpm でも拒否されない（2026-09-28 実測。公式仕様は未確認）。pnpm の版は `.tool-versions` と `packageManager` で明示するので影響はない。
  - 版の選び方: `curl -s https://registry.npmjs.org/<pkg> | jq '.time'` で公開日時を見て、公開から 5 日以上経った版のうち最新を選ぶ。
  - 依存を別の `package.json` に移すとき（Issue #68 の段階 2 でリポジトリ直下から `apps/*` に移した）: 版を変えずに `package.json` を書き換え、`pnpm install`（`--frozen-lockfile` なし）で lockfile を更新する。変わるのは lockfile の `importers`（パッケージごとの依存の一覧）だけで、`packages` / `snapshots`（解決した版）は変わらないはず。更新前の lockfile と `packages:` 以降を比べて同じことを確かめ、`CI=true pnpm install --frozen-lockfile` が通ることを確かめる（2026-09-28 に実測。`minimumReleaseAge` の再解決は起きなかった）。
  - lockfile の再解決: 既存の lockfile にポリシーを満たさないエントリがあると、`pnpm install --frozen-lockfile` / `pnpm update`（引数なし）は `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、`pnpm add <pkg>@<x.y.z>` / `pnpm update <pkg>` は lockfile に残る別の拒否エントリで `ERR_PNPM_NO_MATURE_MATCHING_VERSION` になり、lockfile を部分的に直せない（2026-09-28、pnpm 12.7.0 で確認）。直接依存の版を `package.json` で直したうえで、`pnpm clean --lockfile` → `pnpm install` で作り直し、`pnpm install --frozen-lockfile` が通ることを確認する。作り直した後は、lockfile の差分で意図しない版の変化がないかを確認する。
  - 拒否されたエントリを入れ替えるには、それを要求している親パッケージも条件を満たす版である必要がある。開発機では safe-chain が 14 日未満の親パッケージ（例: 2026-09-28 時点の `next@16.3.6` / `jsdom@30.1.1`、どちらも 09-22 公開）を隠すため、5 日の条件では入るはずの親が見つからず再解決できなかった（Issue #32）。その場合はクラウドセッション（safe-chain なし）で再解決する。
- TypeScript は最新版を使う（2026-09-28 時点 7.0.2。Next.js 16.3.6 の `next build` の型チェックと Vitest で動作することを確認済み）。

## 例外
- フレームワークが版を固定して要求するものは、その要求に従う。例外にした理由はこのファイルに書く。
- 現状の例外:
  - React / React DOM 19.2.8: create-next-app@16.3.6 が生成する `package.json` の版に合わせる（create-next-app@16.3.6 の `dist/index.js` で `react` / `react-dom` に `19.2.8` を指定していることを確認済み）。
  - `@types/node`: latest ではなく、`.tool-versions` の Node メジャー（24）に合わせた 24.x の最新を使う。理由: 実行環境より新しい Node の API の型が使えてしまい、実行時に存在しない API を呼ぶコードが型チェックを通ってしまうため。Node の LTS を上げるとき（`rules/code/env.md`）に一緒に上げる。

## pnpm patch（依存パッケージへのパッチ）
依存パッケージの不具合を、上流の修正を待たずに手元で直すときに使う。パッチは `pnpm install` のたびに node_modules に当たるので、手元・CI・クラウドセッションのどこでも同じ中身になる。

- 使ってよい条件（すべて満たすこと）:
  - 上流の不具合で、このリポジトリの設定や使い方では避けられない。
  - 修正が数行で、差分を読めば何を変えたか分かる。
  - 上流に Issue / PR があるかを確認し、あれば `pnpm-workspace.yaml` の `patchedDependencies` のコメントにリンクを書く。無い・確認できないときはその旨と理由を書く。
  - パッチを当てた状態と当てない状態を実測で比べ、パッチで直ることを確かめる（テスト = 仕様。当てる前に失敗・不具合を再現してから当てる）。
- 置き場所: パッチファイルは `patches/<パッケージ名>@<版>.patch`（`pnpm patch-commit` が作る。スコープの `/` は `__` になる）。対応は `pnpm-workspace.yaml` の `patchedDependencies`。パッチファイルにはコメントを書けないので、何を・なぜ直したかは `pnpm-workspace.yaml` のコメントと、そのパッケージを使う設定ファイルのコメントに書く。
- 手順:
  ```
  pnpm patch <pkg>@<x.y.z> --edit-dir <作業用ディレクトリ>   # 展開された中身を編集する
  pnpm patch-commit <作業用ディレクトリ>                     # patches/ に差分を書き、patchedDependencies と lockfile を更新する
  ```
  - `patches/`・`pnpm-workspace.yaml`・`pnpm-lock.yaml` は同じコミットに入れる。lockfile にパッチのハッシュが入るため、パッチだけを変えると `pnpm install --frozen-lockfile` が「"patchedDependencies" configuration doesn't match the value found in the lockfile」で失敗する（2026-09-28、pnpm 12.7.0 で実測）。
- 外す条件: 上流が直した版が出たら、その版に上げてパッチと `patchedDependencies` の行を消す。キーは版まで固定なので、版を上げるときは必ずパッチの要否を見直す（残すなら新しい版で作り直す）。
- 確認方法:
  - `CI=true pnpm install --frozen-lockfile` が通ること。
  - 当たっていること: `node_modules/<pkg>/` の該当ファイルにパッチの変更が入っていることを grep で見る。
  - パッチで直したい挙動が直っていること（パッチを入れたときの実測と同じ方法で確かめる）。
- 現在のパッチ:
  - `@stryker-mutator/vitest-runner@10.0.0`（Issue #52）: テスト名の連結を ` > ` にする（Vitest 5.0.1 と組み合わせたときの不具合）。上流の Issue / PR の有無は、GitHub の Issue 検索がこの環境から使えず（API は 403）未確認。2026-09-28 時点で上流の master の `packages/vitest-runner/src/test-helpers.ts` もスペース区切りのまま（raw.githubusercontent.com で確認）。詳細は `stryker.config.mjs` と `rules/code/test.md` の「mutation testing（Stryker）」。

## 追加・更新の手順
- 版を明示して、置き場所のパッケージに追加する（どこに置くかは上の「workspace の package.json」）。
  ```
  pnpm --filter @repo/backend add <pkg>@<x.y.z>       # apps/backend の dependencies
  pnpm --filter @repo/frontend add -D <pkg>@<x.y.z>   # apps/frontend の devDependencies
  pnpm add -D <pkg>@<x.y.z>                           # リポジトリ直下（ツール）。リポジトリ直下で実行する
  ```
  - `--filter` はパッケージの名前（`@repo/backend` / `@repo/frontend`）で指定する。pnpm 12.7.0 では、リポジトリ直下で `-w` を付けずに `pnpm add` してもリポジトリ直下の `package.json` に入った（2026-09-28 実測。既にある版で確認）。
  - workspace の中のパッケージへの依存は `"<name>": "workspace:*"` と書いて `pnpm install` する。
- `pnpm-workspace.yaml` の `savePrefix: ''` により `pnpm add <pkg>` でも完全固定で書かれるが、版を明示するのを基本とする（`pnpm add <pkg>@2` のように範囲を指定すると `savePrefix` は無視され、範囲のまま書かれるため）。
- 更新は Issue → PR で行う。

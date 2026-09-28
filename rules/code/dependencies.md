# 依存パッケージルール

npm パッケージの版は `package.json` と `pnpm-lock.yaml` の両方で固定し、意図した版だけが入る状態を保つ。

## 完全固定
- `package.json` の `dependencies` / `devDependencies` はすべて完全固定（`x.y.z`）で書く。`^` `~` `>=` などの範囲指定は使わない。
- 理由: lockfile だけに頼ると、`pnpm update` や lockfile の再解決で範囲内の別の版が入りうる。`package.json` でも版を固定して意図しない版が入るのを防ぐ。あわせて、PR の差分で「どの版からどの版へ」が `package.json` 上で見えるようにする。
- 担保: `package.test.ts` が `package.json` に範囲指定が残っていないことを検査する（`pnpm test` に含まれる）。

## 版の決め方
- 原則 **latest**。npm レジストリの dist-tags を 1 次情報として確認する。
  ```
  curl -s https://registry.npmjs.org/<pkg> | jq -r '.["dist-tags"].latest'
  ```
- ただし safe-chain（開発機）と pnpm の `minimumReleaseAge`（`pnpm-workspace.yaml`）により、公開直後の版は入らない。その場合は入る版のうち最新を使い、理由を PR に書く。
  - 開発機の safe-chain は公開から 14 日（`~/.aikido/config.json` の最小パッケージ年齢）、リポジトリの pnpm は 5 日（`minimumReleaseAge: 7200`、単位は分）。pnpm 側を 14 日に揃えないのは、Next.js などの更新に 2 週間遅れで追随することになるため（Issue #32 でのユーザー判断）。pnpm 側の設定は safe-chain の有無（クラウドセッション・CI）に関係なく効く。値は `pnpm-workspace.test.ts` で検査している。例外: `packageManager`（pnpm 本体）の解決は対象外で、公開 5 日未満の pnpm でも拒否されない（2026-09-28 実測。公式仕様は未確認）。pnpm の版は `.tool-versions` と `packageManager` で明示するので影響はない。
  - 版の選び方: `curl -s https://registry.npmjs.org/<pkg> | jq '.time'` で公開日時を見て、公開から 5 日以上経った版のうち最新を選ぶ。
  - lockfile の再解決: 既存の lockfile にポリシーを満たさないエントリがあると、`pnpm install --frozen-lockfile` / `pnpm update`（引数なし）は `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、`pnpm add <pkg>@<x.y.z>` / `pnpm update <pkg>` は lockfile に残る別の拒否エントリで `ERR_PNPM_NO_MATURE_MATCHING_VERSION` になり、lockfile を部分的に直せない（2026-09-28、pnpm 12.7.0 で確認）。直接依存の版を `package.json` で直したうえで、`pnpm clean --lockfile` → `pnpm install` で作り直し、`pnpm install --frozen-lockfile` が通ることを確認する。作り直した後は、lockfile の差分で意図しない版の変化がないかを確認する。
  - 拒否されたエントリを入れ替えるには、それを要求している親パッケージも条件を満たす版である必要がある。開発機では safe-chain が 14 日未満の親パッケージ（例: 2026-09-28 時点の `next@16.3.6` / `jsdom@30.1.1`、どちらも 09-22 公開）を隠すため、5 日の条件では入るはずの親が見つからず再解決できなかった（Issue #32）。その場合はクラウドセッション（safe-chain なし）で再解決する。
- TypeScript は最新版を使う（2026-09-28 時点 7.0.2。Next.js 16.3.6 の `next build` の型チェックと Vitest で動作することを確認済み）。

## 例外
- フレームワークが版を固定して要求するものは、その要求に従う。例外にした理由はこのファイルに書く。
- 現状の例外:
  - React / React DOM 19.2.8: create-next-app@16.3.6 が生成する `package.json` の版に合わせる（create-next-app@16.3.6 の `dist/index.js` で `react` / `react-dom` に `19.2.8` を指定していることを確認済み）。
  - `@types/node`: latest ではなく、`.tool-versions` の Node メジャー（24）に合わせた 24.x の最新を使う。理由: 実行環境より新しい Node の API の型が使えてしまい、実行時に存在しない API を呼ぶコードが型チェックを通ってしまうため。Node の LTS を上げるとき（`rules/code/env.md`）に一緒に上げる。

## 追加・更新の手順
- 版を明示して追加する。
  ```
  pnpm add <pkg>@<x.y.z>       # dependencies
  pnpm add -D <pkg>@<x.y.z>    # devDependencies
  ```
- `pnpm-workspace.yaml` の `savePrefix: ''` により `pnpm add <pkg>` でも完全固定で書かれるが、版を明示するのを基本とする（`pnpm add <pkg>@2` のように範囲を指定すると `savePrefix` は無視され、範囲のまま書かれるため）。
- 更新は Issue → PR で行う。

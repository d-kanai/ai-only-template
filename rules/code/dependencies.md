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

# 依存パッケージの実測と経緯

規則は `.claude/rules/dependencies.md`、手順はスキル `dependency-update`。ここは読み込まれない記録（Issue #64 で旧ルールファイルから移した）。

## pnpm（12.7.0、2026-09-28）
- リポジトリ直下で `-w` を付けずに `pnpm add` しても、リポジトリ直下の `package.json` に入った（既にある版で確認）。
- `packageManager`（pnpm 本体）の解決は `minimumReleaseAge` の対象外で、公開 5 日未満の pnpm でも拒否されなかった（公式仕様は未確認）。
- lockfile の再解決: 既存の lockfile にポリシーを満たさないエントリがあると、`pnpm install --frozen-lockfile` / `pnpm update`（引数なし）は `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、`pnpm add <pkg>@<x.y.z>` / `pnpm update <pkg>` は lockfile に残る別の拒否エントリで `ERR_PNPM_NO_MATURE_MATCHING_VERSION` になり、lockfile を部分的に直せなかった。`pnpm clean --lockfile` → `pnpm install` で作り直した。
- 拒否されたエントリを入れ替えるには、それを要求している親パッケージも条件を満たす版である必要がある。開発機では safe-chain が 14 日未満の親（2026-09-28 時点の `next@16.3.6` / `jsdom@30.1.1`、どちらも 09-22 公開）を隠すため、5 日の条件では入るはずの親が見つからず再解決できなかった（Issue #32）。クラウドセッション（safe-chain なし）で再解決した。
- 依存を別の `package.json` に移したとき（Issue #68 の段階 2）: 変わったのは lockfile の `importers` だけで、`packages` / `snapshots` は変わらなかった。`minimumReleaseAge` の再解決は起きなかった。
- パッチだけを変えると `pnpm install --frozen-lockfile` が「"patchedDependencies" configuration doesn't match the value found in the lockfile」で失敗した。
- `package.json` の依存の版を書き換えた後（戻した直後も）に `pnpm exec` を実行すると、pnpm が install を走らせ（`pnpm-lock.yaml` が変わる）、lefthook の postinstall が共有フックを書き換えた（Issue #50。`scripts` だけの変更では走らない。自動 install を決める設定名は未確認。LEARNINGS.md）。

## safe-chain と minimumReleaseAge（Issue #32）
- 開発機の safe-chain は公開から 14 日（`~/.aikido/config.json` の最小パッケージ年齢）、リポジトリの pnpm は 5 日（`minimumReleaseAge: 7200`）。pnpm 側を 14 日に揃えないのは、Next.js などの更新に 2 週間遅れで追随することになるため（ユーザー判断）。
- 版の選び方: `curl -s https://registry.npmjs.org/<pkg> | jq '.time'` で公開日時を見て、公開から 5 日以上経った版のうち最新を選ぶ。

## 版の確認
- TypeScript 7.0.2: Next.js 16.3.6 の `next build` の型チェックと Vitest で動作を確認した（Issue #17）。
- React / React DOM 19.2.8: create-next-app@16.3.6 の `dist/index.js` で `react` / `react-dom` に `19.2.8` を指定していることを確認した。
- プレリリース・ビルドメタ・`=1.2.3`・`v1.2.3` を拒否に決めたのは Issue #50（オーケストレータの指示）。

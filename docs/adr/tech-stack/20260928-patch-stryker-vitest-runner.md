# Stryker の vitest-runner は pnpm patch で直して使う

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #52 / PR #56 / `.claude/rules/dependencies.md` / スキル `dependency-update` / `patches/@stryker-mutator__vitest-runner@10.0.0.patch`

## 背景
`@stryker-mutator/vitest-runner` 10.0.0 は、変異ごとの実行で describe 名とテスト名をスペースで連結して Vitest に渡す。Vitest 5.0.1 は ` > ` 区切りで照合するため、describe の中のテストが skip され、生き残りとして数えられて score が実際より大きく下がった（2026-09-28 の work-logs「Stryker（mutation testing）を main で日次実行する方針（Issue #52）」）。

## 決定
- `pnpm patch` で vitest-runner の 2 ファイルを各 1 行直し、`pnpm-workspace.yaml` の `patchedDependencies` で当てる。
- pnpm patch を使ってよい条件（上流の不具合で避けられない、修正が数行、上流の Issue・PR の確認、当てる前後の実測）は `.claude/rules/dependencies.md` に置く。

## 理由
- 上流の master も未修正だった（raw.githubusercontent.com で確認。Issue / PR の有無はプロキシの 403 で未確認）。
- patch は lockfile に記録され、patch ファイルを 1 文字変えると `pnpm install --frozen-lockfile` が失敗する（改ざんを検出できる。同日の work-logs）。
- ユーザーの判断で pnpm patch にした。

## 採用しなかった案
- 検討した案は記録に無い。

## 影響
- 良い点: 実際の score を測れる。
- 悪い点: vitest-runner を上げるたびに、patch を作り直すか外す必要がある。
- 見直す条件: 上流が区切りを直したら patch を外す。

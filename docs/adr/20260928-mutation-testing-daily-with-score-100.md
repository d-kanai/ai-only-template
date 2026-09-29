# mutation testing（Stryker）は PR ごとではなく main で日次に実行し、score 100% を必須にする

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #52 / PR #56 / Issue #55 / PR #66 / `.claude/rules/testing.md` / スキル `mutation-testing` / `stryker.config.mjs` / `.github/workflows/mutation.yml`

## 背景
カバレッジ 100%（20260928-coverage-gate-100.md）は、分岐を通すだけのテストでも満たせる。テストが実装の変異を検出できるかを、手作業の fault injection だけでなく機械で測りたかった。Stryker 10.0.0 の初回の計測では、生き残った変異が多かった（2026-09-28 の work-logs「Stryker（mutation testing）を main で日次実行する方針（Issue #52）」）。

## 決定
- Stryker を main で毎日（08:55 JST）実行する。PR ごとには実行しない。
- `thresholds.break: 100`（生き残りが 1 件でも日次ジョブが失敗する）。ロジックの変異はテストを足して殺し、除外（`// Stryker disable`）は等価な変異と検証しない文言に限る。
- 読み込み時だけ評価される static な変異は数えない（`ignoreStatic: true`）。ロジックの定数は関数の中に置き、static にしない。
- `@stryker-mutator/typescript-checker` は入れない。

## 理由
- 全件の変異の実行は時間がかかるので、PR ごとではなく日次にした（ユーザー判断「mutation テストは main branch でのアクションで日次で実行でよい」。同日の work-logs）。GitHub の schedule は毎時 0 分が混雑して遅延しうる（GitHub Docs）ので 08:55 にした。
- Issue #55 は当初「95% 以上を目標、break 90」だったが、等価な変異は除外でき、Ignored は score の分母に入らないので、残りは全部殺せると分かり、ユーザー判断で 100 にした（2026-09-28 の work-logs「mutation score を 85.52% から 100% に上げ…」、Issue #64 のコメント）。
- `ignoreStatic` が無いと、static な変異が実行時間の大半を占め、読み込み時の変異はテストが 1 件も動かないまま Survived と数えられた（同日の work-logs。https://stryker-mutator.io/docs/stryker-js/configuration/ 、https://stryker-mutator.io/docs/mutation-testing-elements/static-mutants/ ）。
- typescript-checker は TypeScript の JS API を使うが、TypeScript 7.0.2 はそれを export しない（20260928-typescript-7.md。同日の work-logs）。

## 採用しなかった案
- PR ごとに実行する: 時間がかかる。
- score 95% を目標・break 90（Issue #55 の当初の方針）: 殺せる変異を残す理由が無くなった。
- effect の片付けの変異を「unmount 後の setState は観測できない」として除外する: React 19.2 の `<Activity mode="hidden">` では検出できたので、テストを足して除外をやめた（PR #66 の reviewer 指摘。2026-09-28 の work-logs「Issue #55 の reviewer 指摘を反映」）。

## 影響
- 良い点: 値を検証しない弱いテストが増えると、日次ジョブが止まる。
- 悪い点: 失敗に気づくのは翌日。等価かどうかの判断が要る。`schema.ts` の static な変異は検査から外れる（等価の理由は `stryker.config.mjs`）。
- 見直す条件: 記録に無い。

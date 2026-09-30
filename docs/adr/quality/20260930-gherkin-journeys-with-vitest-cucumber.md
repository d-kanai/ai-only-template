# ジャーニーテストを Gherkin の .feature と step の対だけで書き、vitest-cucumber で Vitest の中で実行し、呼び名を API ジャーニーに変える

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #200 / `.claude/rules/testing.md`（「API ジャーニーテスト」） / `rule-tests/api-journey.test.ts`（`api-journey-feature-pair` / `api-journey-placement`） / `apps/backend/api-journeys/todo-lifecycle.feature` / `vitest.stryker.config.mts` / quality/20260930-backend-journey-tests.md

## 背景
ジャーニーテスト（quality/20260930-backend-journey-tests.md）は業務の流れを 1 つの TypeScript のテストに書いており、流れ（何をしてどうなるか）と検証の実装（組み立て・DB の行の比較）が同じ場所に混ざって、流れを業務の言葉で読みにくい。Issue #200 で、業務の流れを Gherkin（Given / When / Then）の `.feature` に日本語で書き、step の実装を TypeScript に分ける形を 1 本試した。テストの実行・カバレッジ・globalSetup（テスト用スキーマ）は今の Vitest のまま使いたい。また「ジャーニー」という呼び名は、画面込みの E2E（`apps/e2e/`。Playwright）の「ユーザージャーニー」と混同しやすい。

## 決定
- ライブラリは `@amiceli/vitest-cucumber` 8.0.0（リポジトリ直下の devDependencies）。`.feature` を `loadFeature` で読み、`describeFeature` の中で `Background` / `Scenario` と step（`Given` / `When` / `Then` / `And`）を実装する。Vitest のテストとして動くので、`pnpm test`・`pnpm test:api-journey` にそのまま入る。
- 置き場所と命名: `apps/backend/api-journeys/<name>.feature` と `<name>.api-journey.test.ts` を対で置く。step のファイルに、quality/20260930-backend-journey-tests.md の中身の規則（`vi` を import しない・handler の名前・変更系の後の `db.select(`・実 DB と 2 つ以上の API）を当てる。対は `rule-tests/api-journey.test.ts` の `api-journey-feature-pair` で止める。`api-journeys/` の外の `.feature` も `api-journey-placement` で止める（外に置くと対の検査にかからず、何も実行されないまま残る）。
- TS だけのジャーニー（`*.journey.test.ts`）は廃止し、`.feature` + step の対だけにする（Issue #200 のユーザー判断。消した `todo-lifecycle.journey.test.ts` と `.feature` 版は同じ強さの検証であることを reviewer が確認した）。`*.journey.test.*` はどこに置いても違反にする。
- 呼び名を「API ジャーニー」（ディレクトリ `apps/backend/api-journeys/`、規則 `api-journey-*`、スクリプト `pnpm test:api-journey`）に変える。WHY: E2E（画面込み。Playwright）との混同を避ける。一般には Mike Cohn のテストピラミッドの「サービステスト」、Martin Fowler の「Subcutaneous test」、実務では「API テスト / API 統合テスト」と呼ばれる層（Issue #200 のユーザー判断）。
- Stryker では `.feature` のジャーニーを実行しない（`vitest.config.mts` を継承した `vitest.stryker.config.mts` で exclude し、`stryker.config.mjs` の `vitest.configFile` をそれに向ける）。vitest-cucumber は step 1 つを Vitest の test 1 つにし、「シナリオを 1 つの test にする」設定を持たない。Stryker が変異を通る test だけに絞ると前提の step が飛ばされ、変異と関係なく killed と数えられうるため。

## 理由
- Vitest の中で動くので、テスト用スキーマ（`createTestDatabase`）・globalSetup・カバレッジ・`@vitest-environment` など今の仕組みをそのまま使え、実行の入口も増えない。
- 安定性: npm の公開は 128 版、直近 12 か月に 15 リリース、週 8.5 万ダウンロード、8.0.0（2026-09-05 公開。`minimumReleaseAge` の 5 日を満たす）が Vitest 5 に対応（peerDependencies `vitest: ^5.0.0`）（npm レジストリ https://registry.npmjs.org/@amiceli/vitest-cucumber と https://api.npmjs.org/downloads/point/last-week/@amiceli/vitest-cucumber 、2026-09-30 に確認）。open issue 0 は Issue #200 の調査（GitHub https://github.com/amiceli/vitest-cucumber ）。
- `.feature` の step と実装の過不足・文の違いを、読み込み時に「Missing steps in Scenario」などで失敗にする（2026-09-30 の work-logs）。書いた流れが実装されないまま残らない。

## 採用しなかった案
- quickpickle: 1 シナリオを 1 つの test にするので Stryker の per-test の絞り込みと相性が良いが、利用者が少なく（Stars 52（Issue #200 の調査）・週 9,694 ダウンロード（2026-09-22〜28。https://api.npmjs.org/downloads/point/last-week/quickpickle ））、直近 12 か月のリリースが 3 回（1.11.0〜1.11.2。https://registry.npmjs.org/quickpickle の `time`）で、長く使える見込みを vitest-cucumber より低く見た（どちらも npm のメンテナは 1 人なので、メンテナの数では比べない。2026-09-30 に確認）。
- jest-cucumber: 最新の 4.5.0（2024-07-25 公開）以降更新が無く、Vitest 5 での動作の保証が無い（npm レジストリ、2026-09-30 に確認）。
- @cucumber/cucumber: Vitest の外の独自のランナーで動き、このリポジトリのコード（拡張子なしの相対 import の TypeScript）を ESM で解決できない。テスト用スキーマ・カバレッジも別に用意することになる。

## 影響
- 良い点: 業務の流れを `.feature` の日本語の step で読める。step の不足は読み込み時に止まる。
- 悪い点: step の実装はシナリオの中の変数で値を渡すので、step の関数を読むには `.feature` を並べて見る必要がある。同じシナリオの中で同じ種類の step が同じ式に一致しないよう文を変える必要がある（`.claude/rules/testing.md`）。API ジャーニーは Stryker で実行しないので mutation score に寄与しない（TS だけのジャーニーを廃止したので、業務の流れを通した変異の検出は無くなる。変異は層ごとの単体テストと `*.postgres.test.ts` が殺す）。
- 見直す条件: API ジャーニーのファイルが増えて同じ準備が重なったら、共通の補助（組み立て・行の期待値）を `apps/backend/test-support/` に切り出す。vitest-cucumber が「シナリオを 1 つの test にする」設定を持ったら、Stryker の除外を外して API ジャーニーも変異を殺すテストに数える。

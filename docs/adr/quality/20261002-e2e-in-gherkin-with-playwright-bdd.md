# E2E を API ジャーニーと同じ Gherkin の .feature と step のクラスで書き、playwright-bdd で Playwright のランナーのまま実行する

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #279 / `.claude/rules/testing.md`（「E2E（Playwright + playwright-bdd）」） / `rule-tests/e2e-feature.test.ts` / `apps/e2e/playwright.config.ts` / quality/20260930-gherkin-journeys-with-vitest-cucumber.md

## 背景
E2E（`apps/e2e/*.spec.ts`。Playwright）は、画面の操作と検証を TypeScript の 1 つのテストに並べて書いており、利用者の操作の流れを業務の言葉で読みにくかった。API ジャーニー（quality/20260930-gherkin-journeys-with-vitest-cucumber.md）は業務の流れを Gherkin の `.feature` に日本語で書き、技術の検証を step に閉じている。ユーザーが E2E も API ジャーニーを参考に Cucumber にし、シナリオの書き方を真似るよう求めた（2026-10-02）。E2E は本番ビルドの起動（webServer）・Chromium・トレースなど Playwright のランナーの仕組みに頼っている。

## 決定
- ライブラリは `playwright-bdd` 9.2.1（`apps/e2e` の devDependencies）。`bddgen` が `.feature` から Playwright のテスト（`apps/e2e/.features-gen/*.spec.js`。コミットしない）を生成し、`playwright test` がそれを実行する（`pnpm test:e2e` = `bddgen && playwright test`）。webServer・`workers: 1`・Chromium の設定はそのまま使う。
- 置き場所と命名: `apps/e2e/<name>.feature` と `apps/e2e/<name>.steps.ts` を対で置く。複数の `.feature` が使う step は `apps/e2e/shared.steps.ts` に置く。手書きの `*.spec.ts` は廃止する。
- step はクラスのメソッドにデコレータ（`@Given` / `@When` / `@Then` と `@Fixture`）で書き、`apps/e2e/fixtures.ts` がクラスを Playwright の fixture にする。step の間の値はクラスのフィールドに持つ。
- `.feature` の書き方は API ジャーニーに合わせる: 業務の言葉だけ（同じ禁止語の一覧）・シナリオの When の直前に仕切り `# ───── <業務の動作> ─────`・Background で Todo を空にする。技術の検証（画面の部品の探し方・状態コード・ログの形・DB の件数）は step に閉じる。
- タグは原則使わず、ブラウザの言語を英語にする `@ブラウザの言語が英語` だけを許す（step より前に作られるブラウザの locale を、シナリオごとに変える手段がタグしか無い）。
- 形は `rule-tests/e2e-feature.test.ts`（置き場所・対・業務の言葉・仕切り・タグ）で止める。

## 理由
- Playwright のランナーのまま動くので、webServer での本番ビルドの起動・fixture・トレース・Chromium の差し替え（`PLAYWRIGHT_CHROMIUM_EXECUTABLE`）を変えずに `.feature` に移せる。1 シナリオが Playwright のテスト 1 つ、step は `test.step` になる。
- `.feature` の step に実装が無ければ生成（bddgen）の時点で失敗する（既定の `missingSteps: "fail-on-gen"`）ので、書いた流れが実装されないまま残らない。
- step をクラスに書くと、テストの補助も最上位に関数を置かない規則（`rule-tests/architecture.test.ts` の class-based。ADR architecture/20261002-class-based-shared-and-test-support.md）にそのまま沿う。
- 版: 9.2.1 は 2026-09-06 公開で `minimumReleaseAge` の 5 日を満たす latest、peerDependencies は `@playwright/test >=1.44`（npm レジストリ https://registry.npmjs.org/playwright-bdd 、2026-10-02 に確認）。8 シナリオが通ること・タグを外すと Given で落ちることは 2026-10-02 の work-logs。

## 採用しなかった案
- `@cucumber/cucumber` と Playwright のライブラリ: Playwright のランナーの外で動き、webServer・fixture・トレースを自前で用意することになる。quality/20260930-gherkin-journeys-with-vitest-cucumber.md でも ESM の解決の問題で採らなかった。
- vitest-cucumber（API ジャーニーと同じ）で E2E を動かす: Vitest の中では Playwright のランナーの仕組み（webServer・ブラウザの fixture）が使えない。
- createBdd の `Given(...)` の呼び出しで step を書く: 動くが、step の関数がファイルの最上位の呼び出しに並び、class-based の考え（補助はクラスにまとめる）とずれる。
- ブラウザの言語を step で Accept-Language のヘッダに上書きして変える: Chromium は locale から決めた値を送り、画面は日本語のままだった（2026-10-02 の work-logs）。

## 影響
- 良い点: E2E も業務の言葉で流れを読める。API ジャーニーと同じ読み方（Background・仕切り）で、画面込みの流れと API の流れを並べて読める。
- 悪い点: 生成の手順（bddgen）が増え、失敗の位置が生成したファイルの行で出る（Playwright の報告には `.feature` の step の文が出る）。step はすべての `.feature` から見えるので、同じ文の step を 2 つのクラスに書くと生成で失敗する（共有の step は shared.steps.ts に寄せる）。
- 見直す条件: playwright-bdd の保守が止まる、または Playwright の新しい版を peerDependencies が受け付けなくなったら、別のライブラリか手書きの spec に戻すことを検討する。

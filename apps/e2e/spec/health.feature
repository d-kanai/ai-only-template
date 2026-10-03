# サービスの稼働の確認（Issue #107。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は health.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。
# 応答の分岐（使えない場合など）は apps/backend の get-health.api.test.ts と API 仕様（spec/api/health）で固定しているので、ここでは
#   本番のビルド（next start）を通っても、外からの監視が確かめる口が使えると返すこと（結線と、ビルドで結果が固定されないこと）だけを見る。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: サービスの稼働の確認

  Scenario: 本番の構成でも、サービスは使えると返る
    # ───── 稼働を確かめる ─────
    When サービスが使えるかを確かめる
    Then サービスは使えると返り、確かめた結果は途中に残さないよう伝えられる

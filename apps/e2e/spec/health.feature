# ヘルスチェック（Issue #107。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は health.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。
# 応答の分岐（使えない場合など）は apps/backend の get-health.api.test.ts と API 仕様（spec/api/health）で固定しているので、ここでは
#   本番のビルド（next start）を通っても、外からの監視が呼ぶヘルスチェックが正常を返すこと（結線と、ビルドで結果が固定されないこと）だけを見る。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: ヘルスチェック

  Scenario: 本番ビルドでも、ヘルスチェックが正常を返す
    # ───── ヘルスチェックを呼ぶ ─────
    When ヘルスチェックを呼ぶ
    Then 正常と返り、レスポンスはキャッシュしないよう指定されている

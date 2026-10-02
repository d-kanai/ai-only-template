# 入力の誤りの伝え方（Issue #126 / #144 / #279。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は api-error.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。
# 誤りの本文の形は apps/backend の problem.test.ts と各 api のテストで固定しているので、ここでは本番のビルドを通っても、誤りの
#   種類と誤った項目が届くこと（結線）だけを見る。画面は形の誤った入力を送らないので、step の実装は画面ではなく直接呼ぶ。
# WHY Background で Todo を空にしない: 拒否された入力は何も保存しない（create-todo.api.test.ts で固定）ので、保存の状態に依存しない。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: 入力の誤りの伝え方

  Scenario: 形の誤った入力は、誤った項目を指して拒否される
    # ───── タイトルを数にして Todo を作る ─────
    When タイトルを数にして Todo を作ろうとする
    Then タイトルが文字でないという理由で、タイトルの項目を指して拒否される

  Scenario: 空のタイトルや長すぎるタイトルは、タイトルの項目を指して拒否される
    # ───── タイトルを空白だけにして Todo を作る ─────
    When タイトルを空白だけにして Todo を作ろうとする
    Then タイトルが空という理由で、タイトルの項目を指して拒否される
    # ───── 長すぎるタイトルで Todo を作る ─────
    When タイトルを 101 文字にして Todo を作ろうとする
    Then タイトルが長すぎるという理由で、上限の 100 文字とともに、タイトルの項目を指して拒否される

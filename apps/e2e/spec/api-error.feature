# 入力エラー（Issue #126 / #144 / #279。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は api-error.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。
# エラーの本文の形は apps/backend の problem.test.ts と各 api のテストで固定しているので、ここでは本番のビルドを通っても、エラーの
#   種類と誤りのある項目が届くこと（結線）だけを見る。画面は型の違う入力を送らないので、step の実装は画面ではなく直接呼ぶ。
# WHY Background で Todo を空にしない: エラーになった入力は何も保存しない（create-todo.api.test.ts で固定）ので、保存の状態に依存しない。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: 入力エラー

  Scenario: 型の違う値を送ると、その項目のエラーになる
    # ───── タイトルを数値にして Todo を作る ─────
    When タイトルを数値にして Todo を作ろうとする
    Then タイトルの項目に、文字列でないというエラーが返る

  Scenario: 空や長すぎるタイトルは、タイトルの項目のエラーになる
    # ───── タイトルを空白だけにして Todo を作る ─────
    When タイトルを空白だけにして Todo を作ろうとする
    Then タイトルの項目に、空だというエラーが返る
    # ───── 長すぎるタイトルで Todo を作る ─────
    When タイトルを 101 文字にして Todo を作ろうとする
    Then タイトルの項目に、長すぎるというエラーが上限の 100 文字とともに返る

# 機能の出し分け（フィーチャーフラグ。Issue #156。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は feature-flag.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。共有の step は shared.steps.ts。
# 出し分けの読み方（準備ができるまでは出さない・on と off の描き分け）は apps/frontend_customer/features/feature-flag/ と
#   features/todo/screens/todo-screen/ のテストで固定しているので、ここでは本番の組み立てを通した結線（画面の OpenFeature の
#   provider が backend の評価を受け取り、その値が一覧の詳細へのリンクに反映される）だけを見る。出し分けは本番の一覧
#   （apps/backend/features/feature-flag/internal/domain/feature-flags.ts。詳細画面は使える）のまま読む。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: 機能の出し分け

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 詳細画面が使えるとサーバから受け取ると、一覧から詳細へ進める
    Given Todo "出し分けの確認" が作られている
    # ───── 一覧を開く ─────
    When 機能の出し分けを受け取りながら Todo の一覧を開く
    Then 詳細画面は使えるとサーバから受け取る
    And 一覧の "出し分けの確認" は詳細へのリンクになる

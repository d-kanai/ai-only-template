# フィーチャーフラグ（Issue #156。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は feature-flag.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。共有の step は shared.steps.ts。
# フィーチャーフラグの読み方（準備ができるまでは出さない・on と off の描き分け）は apps/frontend_customer/features/feature-flag/ と
#   features/todo/screens/todo-screen/ のテストで固定しているので、ここでは本番の組み立てを通した結線（画面の OpenFeature の
#   provider が backend の評価を受け取り、その値が一覧の詳細へのリンクに反映される）だけを見る。フィーチャーフラグは本番の設定
#   （apps/backend/features/feature-flag/internal/domain/feature-flags.ts。詳細画面はオン）のまま読む。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: フィーチャーフラグ

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: サーバから詳細画面のフラグがオンで届くと、一覧から詳細画面へ進める
    Given Todo "フラグの確認" が作られている
    # ───── 一覧を開く ─────
    When フィーチャーフラグを受け取りながら Todo の一覧を開く
    Then サーバから詳細画面のフラグがオンで届く
    And 一覧の "フラグの確認" が詳細画面へのリンクになる

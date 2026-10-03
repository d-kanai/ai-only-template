# セキュリティヘッダと CSRF 対策（Issue #106。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は security-headers.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。
# 中身（応答ヘッダの値・CSP の nonce・別のオリジンの書き込みの 403）は apps/frontend_customer/shared/security/ と
#   apps/backend/shared/http/same-origin.ts の単体テストで固定しているので、ここでは本番のビルド（next start）を通っても、
#   ヘッダが付き、CSP の下で画面が壊れず（hydration して操作できる）、別のオリジンの書き込みが止まること（結線）を見る。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: セキュリティヘッダと CSRF 対策

  Background:
    Given Todo が 1 件も無い

  Scenario: 画面にセキュリティヘッダが付き、CSP の下でもふだんどおり使える
    Given ブラウザがブロックした読み込みを数えておく
    # ───── Todo の一覧を開く ─────
    When Todo の一覧を開く
    Then ページ・JS ファイル・API のレスポンスにセキュリティヘッダが付いている
    # ───── Todo を追加する ─────
    When Todo "牛乳を買う" を追加する
    Then 一覧に "牛乳を買う" が表示され、保存されている
    And ブラウザがブロックした読み込みは 1 件も無い

  Scenario: 別オリジンのページからの書き込みは拒否され、Todo は保存されない
    # ───── 別オリジンのページから Todo を作ろうとする ─────
    When 別オリジンのページから Todo "牛乳を買う" を作ろうとする
    Then 別オリジンからの書き込みとして拒否される
    And "牛乳を買う" は保存されていない

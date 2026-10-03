# ほかのサイトからの悪用を防ぐ守り（Issue #106。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は security-headers.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。
# 守りの中身（応答ヘッダの値・CSP の nonce・別のオリジンの書き込みの 403）は apps/frontend_customer/shared/security/ と
#   apps/backend/shared/http/same-origin.ts の単体テストで固定しているので、ここでは本番のビルド（next start）を通っても、
#   ヘッダが付き、CSP の下で画面が壊れず（hydration して操作できる）、別のオリジンの書き込みが止まること（結線）を見る。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: ほかのサイトからの悪用を防ぐ

  Background:
    Given Todo が 1 件も無い

  Scenario: 画面は悪用を防ぐ守りを付けて届き、守りの下でもふだんどおり使える
    Given 画面が止めた読み込みを数えておく
    # ───── Todo の一覧を開く ─────
    When Todo の一覧を開く
    Then 画面と、画面が読み込むファイルと、画面が使う窓口に、悪用を防ぐ守りが付いている
    # ───── Todo を追加する ─────
    When Todo "牛乳を買う" を追加する
    Then 一覧に "牛乳を買う" が表示され、保存されている
    And 画面が止めた読み込みは 1 件も無い

  Scenario: ほかのサイトのページからの書き込みは断られ、Todo は変わらない
    # ───── ほかのサイトのページから Todo を作ろうとする ─────
    When ほかのサイトのページから Todo "牛乳を買う" を作ろうとする
    Then ほかのサイトからの操作は受け付けないと伝えられる
    And "牛乳を買う" は保存されていない

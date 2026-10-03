# 画面の言語（Issue #116 / #279。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は i18n.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。共有の step は shared.steps.ts。
# 言語の決め方（利用者の選択 → ブラウザの言語 → 既定の日本語）は apps/frontend_customer/shared/i18n/locale.test.ts で固定している
#   ので、ここでは本番の組み立てを通した結線（画面の言語の決定 → 画面の表示）だけを見る。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
# タグ @ブラウザの言語が英語 は、そのシナリオのブラウザの言語を英語にする（fixtures.ts の locale。ブラウザは step より前に作られるので
#   step では変えられない）。Given「ブラウザの言語が英語である」がタグの付け忘れを止める。使ってよいタグはこれだけ
#   （rule-tests/e2e-feature.test.ts の e2e-feature-tag）。
Feature: 画面の言語

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 内部のヘッダで言語を英語に偽っても、ブラウザの言語の日本語で表示する
    Given ブラウザの言語が日本語である
    And 画面の言語を渡す内部のヘッダを英語に偽って送る
    # ───── 一覧を開く ─────
    When Todo の一覧を開く
    Then 画面が日本語で表示される

  Scenario: 利用者が英語を選んでいれば、ブラウザの言語が日本語でも英語で表示する
    Given ブラウザの言語が日本語である
    And 利用者が英語を選んでいる
    # ───── 一覧を開く ─────
    When Todo の一覧を開く
    Then 画面が英語で表示される

  @ブラウザの言語が英語
  Scenario: 英語のブラウザでは英語で表示し、作成日時はブラウザのタイムゾーンで表示する
    Given ブラウザの言語が英語である
    # ───── 一覧を開く ─────
    When Todo の一覧を開く
    Then 画面が英語で表示される
    # ───── Todo を追加する ─────
    When 英語の画面で Todo "Buy milk" を追加する
    Then 一覧に "Buy milk" が英語の完了のチェックボックスとともに表示される
    And "Buy milk" の作成日時がブラウザのタイムゾーンで表示される
    # ───── 詳細を見る ─────
    When "Buy milk" の詳細を開く
    Then 詳細画面も英語で表示される

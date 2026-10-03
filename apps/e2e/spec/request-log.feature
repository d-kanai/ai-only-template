# アクセスの記録（Issue #80 / #209 / #279。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は request-log.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。共有の step は shared.steps.ts。
# 1 行の中身の決め方は apps/frontend_customer/shared/request-log/request-log.test.ts で固定しているので、ここでは proxy.ts の結線
#   （規約の場所で呼ばれる・matcher・logger 経由で標準出力への 1 行・応答の追跡の番号）だけを見る。
# 「記録を取るサーバ」は、テストが標準出力を読めるように step の実装が自分で起動する本番ビルドのサーバ（log-server.ts。WHY はそこ）。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: アクセスの記録

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 画面を開くと、画面の表示と一覧の取得とフィーチャーフラグの取得が 1 行ずつ記録され、先読みは記録されない
    Given 記録を取るサーバで Todo "記録の確認" が作られている
    # ───── 一覧を開く ─────
    When 記録を取るサーバで Todo の一覧を開く
    Then 作成・一覧の画面の表示・一覧の取得の順に 1 行ずつ記録され、フィーチャーフラグの取得も 1 行記録される
    And 画面の表示の記録には受け取れる形式が、一覧の取得の記録には伏せた参照元が残る
    # ───── 詳細を見る ─────
    When "記録の確認" の詳細を開く
    Then 詳細の画面の表示と詳細の取得だけが記録され、先読みは記録されない

  Scenario: 呼び出し元が付けた追跡の番号が記録と応答に入り、秘密の値は伏せて記録される
    # ───── 追跡の番号と秘密の値を付けて一覧を取得する ─────
    When 記録を取るサーバから追跡の番号と秘密の値を付けて Todo の一覧を取得する
    Then 一覧を取得でき、応答に同じ追跡の番号が付く
    And 取得が 1 行で記録され、追跡の番号が入り、秘密の値は伏せてある

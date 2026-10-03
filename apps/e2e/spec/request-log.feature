# リクエストログ（Issue #80 / #209 / #279。.claude/rules/quality/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は request-log.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。共有の step は shared.steps.ts。
# 1 行の中身の決め方は apps/frontend_customer/shared/request-log/request-log.test.ts で固定しているので、ここでは proxy.ts の結線
#   （規約の場所で呼ばれる・matcher・logger 経由で標準出力への 1 行・レスポンスの x-request-id）だけを見る。
# 「ログ確認用のサーバ」は、テストが標準出力を読めるように step の実装が自分で起動する本番ビルドのサーバ（log-server.ts。WHY はそこ）。
# 書き方（業務の言葉だけ・When の前の仕切り）は todo.feature の冒頭と同じ。
Feature: リクエストログ

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 画面を開くと、ページ・一覧の取得・フィーチャーフラグの取得のリクエストが 1 行ずつログに出て、プリフェッチは出ない
    Given ログ確認用のサーバで Todo "ログの確認" が作られている
    # ───── 一覧を開く ─────
    When ログ確認用のサーバで Todo の一覧を開く
    Then Todo の作成・一覧のページ・一覧の取得のリクエストがこの順に 1 行ずつログに出て、フィーチャーフラグの取得も 1 行出る
    And ページのログには Accept ヘッダが、一覧の取得のログにはマスクした Referer ヘッダが残る
    # ───── 詳細を見る ─────
    When "ログの確認" の詳細を開く
    Then 詳細のページと詳細の取得だけがログに出て、プリフェッチは出ない

  Scenario: 呼び出し元が付けたトレース用のヘッダの値がログとレスポンスに入り、秘密のクエリパラメータはマスクしてログに出る
    # ───── トレース用のヘッダと秘密のクエリパラメータを付けて一覧を取得する ─────
    When ログ確認用のサーバから、トレース用のヘッダと秘密のクエリパラメータを付けて Todo の一覧を取得する
    Then 一覧を取得でき、レスポンスのヘッダに同じリクエスト番号が返る
    And 取得が 1 行でログに出て、トレースの値が入り、秘密のクエリパラメータはマスクされている

# Todo のライフサイクル（Issue #200。.claude/rules/quality/testing.md の「API ジャーニーテスト」）。
# step の実装は todo-lifecycle.api-journey.test.ts（対の名前。rule-tests/api-journey.test.ts の api-journey-feature-pair）。
# 各 step の文は、同じシナリオの中で同じ種類（Given / When / Then / And）の step と重ならないように書く
#   （vitest-cucumber 8.0.0 は、式（{string} / {int}）の step を、同じ種類で最初に一致した行に割り当てる）。
# このファイルは業務の仕様として読むもの（Issue #217）。step と見出しは業務の言葉だけで書き、技術の言葉（DB・状態コード・
#   応答の形・API など。禁止語の一覧は rule-tests/feature-business-language.ts の FORBIDDEN_WORDS_IN_FEATURE）は書かない。技術の検証
#   （状態コード・応答の本文・DB の行）は step の実装に閉じる（api-journey-business-language。仕切り以外のコメント行は対象外）。
#   Writer が文ごとに自動で残す変更の記録も技術の仕組みなので書かず、同じ操作の結果を確かめる step の実装の中で確かめる
#   （ユーザー指示 2026-10-01）。
# API を呼ぶ step（When）の直前には、業務の動作を名前にした仕切り `# ───── <業務の動作> ─────` を置く
#   （api-journey-section-divider。Background には置かない）。
Feature: Todo のライフサイクル

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 作成から完了・削除まで
    # ───── Todo を作る ─────
    When Todo "牛乳を買う" を作る
    Then 未完了の Todo "牛乳を買う" が作られる
    And Todo は "牛乳を買う" の 1 件だけになる
    And "牛乳を買う" の完了の履歴は作成時の未完了の 1 件になる
    # ───── 2 件目の Todo を作る ─────
    When 作成日時がずれるよう少し待ってから Todo "パンを買う" を作る
    Then 2 件目も未完了の Todo "パンを買う" として作られる
    And Todo は作成順の 2 件になる
    And 完了の履歴は 2 件とも作成時の未完了になる
    # ───── 一覧を見る ─────
    When Todo の一覧を見る
    Then 一覧に 2 件が作成順に並ぶ
    # ───── 名前を変える ─────
    When 1 件目を "豆乳を買う" に改名する
    Then 1 件目のタイトルが "豆乳を買う" に変わる
    And Todo は 1 件目のタイトルだけが変わる
    And 完了の履歴は改名では変わらない
    # ───── 完了にする ─────
    When 1 件目を完了にする
    Then 1 件目が完了になる
    And Todo は 1 件目だけが完了になる
    And 完了の履歴に 1 件目の完了が 1 件追加される
    And 1 件目の完了の通知が 1 件だけ送られる
    # ───── 詳細を見る ─────
    When 1 件目の詳細を見る
    Then 改名と完了が反映された詳細が見える
    # ───── 削除する ─────
    When 1 件目を削除する
    Then 1 件目が削除される
    And Todo は 2 件目の 1 件だけになる
    And 完了の履歴は 2 件目の作成時の 1 件だけになる
    # ───── 一覧を見る ─────
    When 削除の後に Todo の一覧を見る
    Then 一覧に 2 件目だけが並ぶ
    # ───── 詳細を見る ─────
    When 削除した 1 件目の詳細を見る
    Then 削除した 1 件目は存在しないというエラーが返る

  Scenario: 不正な入力は保存されない
    Given Todo "牛乳を買う" が作られている
    # ───── タイトルが空の Todo を作る ─────
    When タイトルが空の Todo を作る
    Then タイトルが空という理由で拒否される
    And Todo は作られていた 1 件のまま変わらない
    # ───── 一覧を見る ─────
    When 拒否の後に Todo の一覧を見る
    Then 一覧に作られていた 1 件だけが並ぶ
    # ───── 存在しない Todo の名前を変える ─────
    When 存在しない Todo を "豆乳を買う" に改名する
    Then 改名しようとした Todo は存在しないというエラーが返る
    And Todo は改名の失敗の後も作られていた 1 件のまま変わらない
    # ───── 一覧を見る ─────
    When 改名の失敗の後に Todo の一覧を見る
    Then 一覧に元の名前のまま 1 件だけが並ぶ

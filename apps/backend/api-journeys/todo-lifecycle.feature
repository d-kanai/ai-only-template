# Todo のライフサイクル（Issue #200。.claude/rules/testing.md の「API ジャーニーテスト」）。
# step の実装は todo-lifecycle.api-journey.test.ts（対の名前。rule-tests/api-journey.test.ts の api-journey-feature-pair）。
# 各 step の文は、同じシナリオの中で同じ種類（Given / When / Then / And）の step と重ならないように書く
#   （vitest-cucumber 8.0.0 は、式（{string} / {int}）の step を、同じ種類で最初に一致した行に割り当てる）。
Feature: Todo のライフサイクル

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 作成から完了・削除まで
    When Todo "牛乳を買う" を作る
    Then 状態 201 で、未完了の Todo "牛乳を買う" が返る
    And DB の todos は "牛乳を買う" の 1 行になる
    And DB の完了の履歴は作成時の未完了の 1 行になる
    And DB の変更履歴は todos と完了の履歴の insert の 2 件になる
    When 作成日時が進むのを待って Todo "パンを買う" を作る
    Then 2 件目も状態 201 で、未完了の Todo "パンを買う" が返る
    And DB の todos は作成順の 2 行になる
    And DB の完了の履歴は 2 件とも作成時の未完了の行になる
    And DB の変更履歴に 2 件目の todos と完了の履歴の insert が足される
    When Todo の一覧を取得する
    Then 状態 200 で、2 件が作成順に並ぶ
    When 1 件目を "豆乳を買う" に改名する
    Then 状態 200 で、title が "豆乳を買う" になった 1 件目が返る
    And DB の todos は 1 件目の title だけが変わる
    And DB の完了の履歴は改名では変わらない
    And DB の変更履歴に 1 件目の title の update が 1 件足される
    When 1 件目を完了にする
    Then 状態 200 で、完了になった 1 件目が返る
    And DB の todos は 1 件目だけが完了になる
    And DB の完了の履歴に 1 件目の完了の行が 1 行足される
    And DB の変更履歴に 1 件目の completed の update と完了の履歴の insert が足される
    And 1 件目の完了の通知が 1 件だけ送られる
    When 1 件目の詳細を取得する
    Then 状態 200 で、改名と完了が反映された詳細が返る
    When 1 件目を削除する
    Then 状態 204 で、本文は空になる
    And DB の todos は 2 件目の 1 行だけになる
    And DB の完了の履歴は 2 件目の作成時の 1 行だけになる
    And DB の変更履歴に 1 件目の todos の delete が 1 件だけ足される
    When 削除の後に Todo の一覧を取得する
    Then 状態 200 で、2 件目だけが並ぶ
    When 削除した 1 件目の詳細を取得する
    Then 状態 404 で、削除した 1 件目の not found の Problem Details が返る

  Scenario: 不正な入力は保存されない
    Given Todo "牛乳を買う" が作られている
    When 空の title で Todo を作る
    Then 状態 400 で、title が空という Problem Details が返る
    And DB の todos は作られていた 1 行のまま変わらない
    And DB の変更履歴は作成の 2 件のまま変わらない
    When 失敗の後に Todo の一覧を取得する
    Then 状態 200 で、作られていた 1 件だけが並ぶ
    When 存在しない id の Todo を "豆乳を買う" に改名する
    Then 状態 404 で、その id の not found の Problem Details が返る
    And DB の todos は改名の失敗の後も作られていた 1 行のまま変わらない
    And DB の変更履歴は改名の失敗の後も作成の 2 件のまま変わらない
    When 改名の失敗の後に Todo の一覧を取得する
    Then 状態 200 で、元の名前のまま 1 件だけが並ぶ

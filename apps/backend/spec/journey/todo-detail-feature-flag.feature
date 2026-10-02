# Todo の詳細画面の出し分け（Issue #156）。step の実装は todo-detail-feature-flag.api-journey.test.ts（対の名前。
#   rule-tests/api-journey.test.ts の api-journey-feature-pair）。
# 画面は開くときに機能の出し分け（フィーチャーフラグ）をまとめて読み、詳細画面が使えるときだけ一覧から詳細へのリンクを出す。
#   その流れを、出し分けの 2 つの読み方（まとめて・1 つだけ）と、Todo の作成・詳細を通して確かめる。
# 書き方（業務の言葉だけ・API を呼ぶ step の前の仕切り・同じ種類の step の文を重ねない）は todo-lifecycle.feature の冒頭と同じ。
# 機能の出し分けは本番の一覧（詳細画面は使える）のまま読む（API ジャーニーは本番と同じ組み立て）。
Feature: Todo の詳細画面の出し分け

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 詳細画面が使えるかを確かめてから詳細を見る
    # ───── 機能の出し分けをまとめて読む ─────
    When 画面を開くときに機能の出し分けをまとめて読む
    Then 詳細画面は使えると返る
    And 出し分けを読んでも Todo は増えない
    # ───── Todo を作る ─────
    When Todo "牛乳を買う" を作る
    Then Todo は "牛乳を買う" の 1 件だけになる
    # ───── 詳細画面が使えるかを確かめる ─────
    When 詳細画面が使えるかを 1 つだけ確かめる
    Then 詳細画面は使えると 1 つだけ返る
    And 確かめても Todo は "牛乳を買う" の 1 件のまま変わらない
    # ───── 詳細を見る ─────
    When "牛乳を買う" の詳細を見る
    Then "牛乳を買う" の詳細が返る

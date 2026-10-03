# サービスの稼働の確認（Issue #107）。step の実装は service-health.api-journey.test.ts（対の名前。
#   rule-tests/api-journey.test.ts の api-journey-feature-pair）。
# 外からの監視がサービスの稼働を確かめる間も、利用者は Todo を作って一覧を見る。その流れを、稼働の確認と Todo の作成・一覧を
#   通して確かめる（稼働の確認が Todo を変えず、Todo を使った後も同じ保存先で使えると返る）。
# 書き方（業務の言葉だけ・API を呼ぶ step の前の仕切り・同じ種類の step の文を重ねない）は todo-lifecycle.feature の冒頭と同じ。
Feature: サービスの稼働の確認

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 稼働を確かめながら Todo を使う
    # ───── 稼働を確かめる ─────
    When サービスが使えるかを確かめる
    Then サービスは使えると返る
    And 確かめても Todo は増えない
    # ───── Todo を作る ─────
    When Todo "牛乳を買う" を作る
    Then Todo は "牛乳を買う" の 1 件だけになる
    # ───── もう一度稼働を確かめる ─────
    When Todo を作った後に、もう一度サービスが使えるかを確かめる
    Then 作った後もサービスは使えると返る
    And 確かめても Todo は "牛乳を買う" の 1 件のまま変わらない
    # ───── 一覧を見る ─────
    When Todo の一覧を見る
    Then 一覧に "牛乳を買う" だけが並ぶ

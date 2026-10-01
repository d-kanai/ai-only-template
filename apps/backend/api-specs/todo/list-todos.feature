# Todo の一覧の API 仕様（Issue #219）。step の実装は対の list-todos.api-spec.test.ts。
# 書き方: Scenario は固定の見出し（読み取りの API は レスポンス / ソート / 検索 / 異常系。該当が無ければ省く）、step は `*` だけ。
#   `*` の 1 行 = 1 振る舞い = 1 テストで、前の行に依存しない（用意・呼び出し・確かめを step の中で完結させる）。
# 業務の言葉だけで書く（技術の言葉は rule-tests/feature-business-language.ts の FORBIDDEN_WORDS_IN_FEATURE。見出しの レスポンス は固定語）。
# 検索の条件はこの一覧に無いので、見出し「検索」は置かない。
Feature: Todo の一覧
  Scenario: レスポンス
    * Todo が無ければ、空の一覧が返る
    * 各 Todo は、タイトル・完了かどうか・作成日時を持つ
    * 完了にした Todo も一覧に含まれる
  Scenario: ソート
    * 作成した順（古いものが先）に並ぶ
    * 同じ日時に作られた Todo は、毎回同じ順で並ぶ
  Scenario: 異常系
    * 壊れた Todo（完了の履歴の日時が、作られた日時より前のもの）が 1 件でもあると、一覧は取得できず、サーバの誤りとして伝えられる

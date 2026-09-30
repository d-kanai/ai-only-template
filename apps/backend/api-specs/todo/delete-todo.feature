# Todo を削除する API の仕様（Issue #219）。step の実装は対の delete-todo.api-spec.test.ts。
# 書き方（固定の見出し・`*` だけ・1 行 = 1 振る舞い・業務の言葉だけ）は list-todos.feature の冒頭と同じ。
#   削除しても通知などは起きないので、見出し「副作用」は置かない。
Feature: Todo を削除する
  Scenario: レスポンス
    * Todo を削除すると、何も返さずに成功を伝える
  Scenario: 記録
    * 削除した Todo は無くなり、ほかの Todo は残る
    * 削除した Todo の完了の履歴も無くなる
    * 変更の記録に、削除した Todo の内容が残る
    * 削除の前の変更の記録は、消えずに残る
  Scenario: 異常系
    * 存在しない Todo は、存在しないと伝えられる
    * 削除済みの Todo をもう一度削除すると、存在しないと伝えられる

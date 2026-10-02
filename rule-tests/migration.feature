# drizzle のマイグレーションの SQL の決まり（Issue #192）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の migration.test.ts。
# 規則の WHY と限界は migration.test.ts の冒頭。
Feature: マイグレーションの SQL
  Scenario: public のスキーマ修飾の判定
    * 修飾の無い書き方は違反なし（修飾なしの外部キー・コメントの中の "public".・public を含む別の名前・空）
    * 表を public で修飾した文は、文の番号で違反になる（drizzle-kit が生成する形・引用符なし・大文字と空白・複数の文）
  Scenario: 列挙と検査（fixture）
    * drizzle の下の SQL のファイル（サブディレクトリを含む）だけを検査し、public で修飾した文をファイルと文の番号で返す
    * drizzle のディレクトリが無ければ対象は 0 件で違反も 0 件になる（本番の検査は 0 件を失敗にする）
  Scenario: 実ファイル
    * drizzle の SQL は表を public で修飾しない

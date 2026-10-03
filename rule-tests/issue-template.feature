# Issue テンプレート（.github/ISSUE_TEMPLATE/。Issue #113）の決まりを検査するルール検査テストの仕様。step の実装は対の issue-template.test.ts。
# 規則の WHY と限界は issue-template.test.ts の冒頭。
Feature: Issue テンプレート
  Scenario: テンプレートの置き場所（issue-template-files）
    * type ラベルごとの 5 つのテンプレートと config.yml がそろっていれば違反なし
    * 足りないテンプレートと、決まった名前でないファイル（Markdown のテンプレート・yaml の拡張子・大文字）を 1 件ずつ違反にする
  Scenario: テンプレートのラベル（issue-template-label）
    * labels がファイル名の type ラベル 1 つなら違反なし（括弧の一覧・引用符・括弧なし・行末のコメント）
    * labels が無い・空・別のラベル・2 つ以上・コメントアウト・body の下にだけあるなら違反にする
  Scenario: テンプレートの項目（issue-template-fields）
    * 項目が 目的・内容・完了条件・前提 の順で、前提だけ任意なら違反なし
    * 項目が足りない・順が違う・見出しが違う・必須の指定が違う・必須の指定が無いなら違反にする
  Scenario: 空の Issue（issue-template-blank）
    * config.yml が blank_issues_enabled を false にしていれば違反なし
    * config.yml が無い・true・指定が無い・コメントアウトなら違反にする
  Scenario: 実ファイル
    * 一時ディレクトリの .github/ISSUE_TEMPLATE から、規則ごとの違反をすべて検出する
    * リポジトリの Issue テンプレートに違反が無い

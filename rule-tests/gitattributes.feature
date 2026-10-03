# PR の差分で最初から畳むファイル（.gitattributes の linguist-generated。Issue #411）を検査するルール検査テストの仕様。step の実装は対の gitattributes.test.ts。
# 規則の WHY と限界は gitattributes.test.ts の冒頭。
Feature: PR で畳むファイル
  Scenario: 畳むファイルの判定
    * lockfile・drizzle-kit の生成物（meta）・docs の下の文書（ADR・作業ログ・構成図）は畳む
    * 手で書くファイル（ソース・テスト・.feature・マイグレーションの SQL・指示ファイル・設定）は畳まない
  Scenario: git の属性の読み方（fixture）
    * linguist-generated を付けた・true にしたファイルだけを畳むと読み、外した・false・指定なしは畳まないと読む
  Scenario: 実ファイル
    * リポジトリのすべてのファイルで、.gitattributes で畳むファイルが判定と一致し、1 件以上ある

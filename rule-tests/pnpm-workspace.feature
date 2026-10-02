# pnpm-workspace.yaml のサプライチェーン保護と版の書き方の設定（.claude/rules/dependencies.md）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の pnpm-workspace.test.ts。
# 規則の WHY と限界は pnpm-workspace.test.ts の冒頭。
Feature: pnpm-workspace.yaml の設定
  Scenario: 設定の読み取りと判定（must pass）
    * 期待どおりの設定だけなら違反なし
    * 値の後ろのコメントは値に含めない
    * 子の間・子の値の後ろのコメントは読まない（違反なし）（インデントされた key: value 形式のコメント行・行頭の key: value 形式のコメント行・子の値の後ろのコメント）
    * 改行が CRLF でも読める
    * トップレベルと子の値を型付きで読む
  Scenario: 設定の読み取りと判定（must reject）
    * 設定が無い・値が違う・コメントアウト・ネストの中にだけある設定は、違反の設定のキーで違反になる（minimumReleaseAge・minimumReleaseAgeStrict・savePrefix・allowBuilds の各形、クォートした文字列・値の後ろの空白、ファイルが空）
    * トップレベルのキーが重複していると例外にする
  Scenario: pnpm-workspace.yaml の実ファイル
    * 違反を含む pnpm-workspace.yaml からは、違反の設定と実際の値をすべて検出する
    * サプライチェーン保護と版の書き方の設定が期待どおり

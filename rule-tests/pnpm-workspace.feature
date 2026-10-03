# pnpm-workspace.yaml のサプライチェーン保護と版の書き方の設定（.claude/rules/tooling/dependencies.md）と、それと食い違わない Renovate の設定（Issue #111）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の pnpm-workspace.test.ts。
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
  Scenario: Renovate の設定の判定（must pass）
    * pnpm と同じ日数を待ち、待つ間は PR を作らず、パッチを当てた依存を更新しない設定は違反なし（パッケージ名そのもの・スコープのワイルドカード・パッチが無い）
    * 行頭の // のコメントは読まない
  Scenario: Renovate の設定の判定（must reject）
    * 待つ日数が pnpm と違う・日数で書いていない・無い、待つ間に PR を作る、パッチを当てた依存を更新すると、その設定のキーで違反になる
    * JSON に行頭の // のコメントだけを足した形でなければ例外にする（値の後ろのコメント・末尾のカンマ）
  Scenario: Renovate の設定の実ファイル
    * .github/renovate.json5 は pnpm-workspace.yaml の minimumReleaseAge と同じ日数を待ち、パッチを当てた依存を更新しない

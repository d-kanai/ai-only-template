# ルール検査テストを .feature と step の実装に分ける形（Issue #282）を検査するルール検査テストの仕様。step の実装は対の rule-test-feature.test.ts。
# 規則の WHY と限界は rule-test-feature.test.ts の冒頭。
Feature: ルール検査テストの形
  Scenario: 対の .feature と step の実装
    * 同じ名前の .feature と .test.ts がそろい、step の実装が対の .feature を読めば違反なし
    * .feature の無い step の実装と、step の実装の無い .feature は、置いたファイルの違反になる
    * step の実装が loadFeature で同じ名前の .feature を読まないと違反になる
  Scenario: Vitest の describe と it を使わない
    * vitest から it・test・describe・suite を import すると違反になる（別名も）
    * vitest から expect や afterAll などを import するのは違反なし
    * コードの途中の文字列にある vitest の import は数えない
  Scenario: .feature の書き方
    * Feature の見出し・Scenario の見出し・箇条書きの step・コメント・空行だけなら違反なし
    * Given などのキーワードの step・タグ・Scenario Outline・説明の行は、行の番号で違反になる
    * step が 1 つも無い Scenario は違反になる
    * step の文に、先頭のほかの星印か波かっこがあると、行の番号で違反になる
    * step の文が正規表現として読めないと、行の番号で違反になる（対になっていないかっこ）
  Scenario: まだ移していないルール検査テスト
    * 移していない一覧にあるテストは、.feature が無くても違反にしない
    * 移していない一覧にあるのに .feature があれば、一覧から消すよう違反になる
  Scenario: ケースの表
    * ケース名ごとに値をまとめ、同じケース名があれば例外になる
  Scenario: 実ファイル
    * ルール検査テストはすべて .feature と step の実装に分かれている

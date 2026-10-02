# 1 ユースケース = 1 command（Issue #175・#177）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の use-case.test.ts。
# 規則の WHY と限界は use-case.test.ts の冒頭。
Feature: command と query の書き方
  Scenario: command の入力の判定（findUseCaseViolations）: must pass
    * Input の項目がすべて必須で、input の項目を比較しなければ違反なし（Input 以外の型の ?:・値の三項演算子など）
  Scenario: command の入力の判定（findUseCaseViolations）: must reject
    * Input の任意の項目と input の項目の有無の分岐は、規則と行で違反になる（title?:・1 行の Input・export の無い Input・? と : の間の空白など）
  Scenario: command のトランザクションの判定（findCommandTransactionViolations）: must pass
    * execute の本体を this.transactions.run で包めば違反なし（複数行・return・修飾子・型引数・空白と改行・run の後の通知など）
  Scenario: command のトランザクションの判定（findCommandTransactionViolations）: must reject
    * execute を run で包まなければ違反（Repository を直接呼ぶ・run が execute の外にだけあるなど）
  Scenario: command / query の列挙と検査（fixture）
    * features/<f>/internal/application/ の .command.ts・.query.ts だけを対象にし、違反を「規則: パス:行: 行の内容」で返す
    * apps/backend/features が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: 1 ユースケース = 1 command（実ファイル）
    * command / query の Input に任意の項目が無く、input の項目の有無で分岐せず、command の execute はトランザクション（runner の run）で包む

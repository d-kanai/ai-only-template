# テストの本体のフェーズコメント（given → when → then。Issue #273）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の test-phases.test.ts。
# 規則の WHY と限界は test-phases.test.ts の冒頭。
Feature: テストのフェーズコメント
  Scenario: フェーズコメント（findPhaseViolations）
    * given → when → then の並びと、テストでない呼び出し・文字列などの中の test の呼び出しの形は違反なし（空の given の説明・when → then の繰り返し・each などの変種・function の本体・割り算と JSX の閉じタグ）
    * フェーズコメントが無い・順が違う・区間が空・本体がブロックでない・字句解析できないテストは、行と理由で違反になる
    * API 仕様の step（And など）は stepFile のときだけテストとして数える
  Scenario: 列挙と検査（fixture）
    * 対象のテストファイルだけを検査し、違反をファイルと行で返す
    * 対象のディレクトリが無ければ対象は 0 件で違反も 0 件になる（本番の検査は 0 件を失敗にする）
  Scenario: フェーズコメント（実ファイル）
    * すべてのテストの本体に given → when → then のフェーズコメントがある

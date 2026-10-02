# E2E（apps/e2e/）の置き場所と .feature の書き方（Issue #279）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の e2e-feature.test.ts。
# 規則の WHY と限界は e2e-feature.test.ts の冒頭。
Feature: E2E の置き場所と .feature の書き方
  Scenario: .feature の中身の判定（must pass）
    * 業務の言葉だけで When の前に仕切りがある .feature は違反なし（許すタグ付きのシナリオ・Background の中の When・助数詞付きの 3 桁の数）
  Scenario: .feature の中身の判定（must reject）
    * 技術の言葉・状態コード・許さないタグを足した行は、その行の違反になる（API・400・skip・許すタグと同じ行の only）
    * 仕切りの無い When・形の違う仕切り（─ が 4 つ）の後の When は、When の行の違反
    * 仕切りの見出しの技術の言葉は、仕切りの行の違反（コメントでも読者が読む行）
  Scenario: 置き場所と対の判定
    * spec/ の直下の .feature と step の対・共有の step は違反なし
    * 手書きのテスト・spec/ の外とサブディレクトリの .feature と step は置き場所の違反だけになる（中身と対は見ない）
    * 対の無い .feature と step は対の違反になる（step の無い .feature・名前の違う step しか無い .feature・.feature の無い step）
  Scenario: E2E の列挙と検査（fixture）
    * apps/e2e の下の .feature・step・手書きのテストを対象にし（依存・生成物・出力は除く）、違反を「規則: パス(:行)」で返す
    * apps/e2e が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: E2E の実ファイル
    * 許すタグは apps/e2e/support/fixtures.ts の ENGLISH_BROWSER_TAG と同じ
    * apps/e2e/spec には対になった .feature と step のファイル（と共有の shared.steps.ts）だけがあり、.feature は業務の言葉だけで When の前に仕切りがあり、許すタグだけを使う

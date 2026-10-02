# 永続化の規則（Issue #177 ほか）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の persistence.test.ts。
# 規則の WHY と限界は persistence.test.ts の冒頭。
Feature: 永続化
  Scenario: 永続化の判定（findPersistenceViolations）: must pass
    * 永続化の規則に従う書き方は違反なし（changed-props を import した update・origin を持つ Entity・insert のみの表への insert・Writer を通した書き込み・JOIN で読む集約・ForUpdate のメソッドなど）
  Scenario: 永続化の判定（findPersistenceViolations）: must reject
    * 永続化の規則の違反を規則と行で返す（upsert・changed-props の import の無い update・origin の無い Entity・insert のみの表の update / delete・Writer を通さない書き込み・子表を JOIN しない集約・ForUpdate で終わらないロックのメソッドなど）
  Scenario: backend のソースの列挙と検査（fixture）
    * apps/backend の下のテスト以外の .ts を対象にし、違反を「規則: パス:行」で返す
    * apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: 永続化（実ファイル）
    * upsert を使わず、.postgres.ts の update は changed-props を import し、reconstruct を持つ Entity は origin を持ち、insert のみの表を update / delete せず、その表を Changes / Events / Logs で終わる変数で宣言し、書き込みは PostgresWriter.of で得た Writer を通し（transaction と recordChange を直接呼ばず、change-log を import しない）、集約は子表の全件を JOIN で読み、行ロックをするメソッドの名前は ForUpdate で終わる

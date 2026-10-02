# DB の列の型・サロゲートキー・列の分類表（Issue #145）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の schema.test.ts。
# 規則の WHY と限界は schema.test.ts の冒頭。
Feature: DB のスキーマの書き方
  Scenario: 列の型の判定（findColumnTypeViolations）: must pass
    * 既定の列の型と、WHY のある既定外の型は違反なし（uuid / text / integer / numeric / timestamptz / jsonb・コメントや文字列の中・名前の一部だけが一致する別の関数など）
  Scenario: 列の型の判定（findColumnTypeViolations）: must reject
    * WHY の無い既定外の列の型は、規則と行で違反になる（varchar・char・timezone 無しの timestamp・serial・json・WHY の書き方の誤りなど）
  Scenario: サロゲートキーの判定（findSurrogateKeyViolations）: must pass
    * 表の id が uuid の primaryKey なら違反なし（名前で import・.defaultRandom() が続くなど）
  Scenario: サロゲートキーの判定（findSurrogateKeyViolations）: must reject
    * 表の id が uuid の primaryKey でなければ違反（id の列が無い・serial・text・uuid を名前に含む別の関数・.primaryKey() が無いなど）
  Scenario: 列の分類表の判定（findColumnClassificationViolations）: must pass
    * 表ごとに列の分類表があれば違反なし（名前空間の pgTable・複数の表・変数名に $ を含む表・pgTable の無いファイルなど）
  Scenario: 列の分類表の判定（findColumnClassificationViolations）: must reject
    * 列の分類表の無い表は違反（分類表が無い・片方の表だけにある・名前が <表>Columns でないなど）
  Scenario: スキーマの列挙と検査（fixture）
    * apps/backend の features と shared の infra/schema.ts だけを対象にし、すべての規則（列の型・surrogate-key・column-classification）の違反を「規則: パス:行」の行の順で返す
    * apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: DB の列の型・サロゲートキー・列の分類表（実ファイル）
    * apps/backend の infra/schema.ts はすべて列の型の既定に従い、すべての表が uuid の id の primaryKey と列の分類表を持つ

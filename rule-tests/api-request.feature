# リクエストの任意項目（1 ユースケース = 1 API。Issue #175）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の api-request.test.ts。
# 規則の WHY と限界は api-request.test.ts の冒頭。
Feature: リクエストの任意項目
  Scenario: リクエストの任意項目の判定（findOptionalViolations）: must pass
    * WHY 任意: のある .optional() と .optional() の無い書き方は違反なし（必須の項目だけ・直前の行の WHY・複数行の chain・コメントの中など）
  Scenario: リクエストの任意項目の判定（findOptionalViolations）: must reject
    * WHY 任意: の無い .optional() は、その行の番号で違反になる（部分更新・複数行の chain・空行を挟む・別の見出し・同じ行の末尾の WHY など）
  Scenario: api ファイルの列挙と検査（fixture）
    * features/<f>/internal/presentation/ の .api.ts だけを対象にし、違反を「パス:行: 行の内容」で返す
    * apps/backend/features が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: リクエストの任意項目（実ファイル）
    * apps/backend/features/<f>/internal/presentation/ の .api.ts は .optional() を WHY 任意: 無しで使わない

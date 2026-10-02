# domain の検証は validate を通す決まり（Issue #177）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の domain-validation.test.ts。
# 規則の WHY と限界は domain-validation.test.ts の冒頭。
Feature: domain の検証
  Scenario: domain の検証の判定（findDomainValidationViolations）: must pass
    * DomainValidation.validated を通す検証と zod でない parse は違反なし（Entity の完全コンストラクタ・JSON.parse / Date.parse など）
  Scenario: domain の検証の判定（findDomainValidationViolations）: must reject
    * domain の zod の parse の直接の呼び出しと validate.ts の外の validation_error は、規則と行で違反になる（schema.parse(x)・safeParse / parseAsync など）
  Scenario: ファイルごとの規則の範囲（rulesFor）
    * domain のファイルには両方の規則を当てる（features の internal/domain・shared/domain・サブディレクトリ・features の validate.ts）
    * domain 以外の backend のファイルには validation_error の規則だけを当てる（application・presentation・infra・internal/ を挟まない domain など）
    * validate.ts・テスト・backend の外・ts でないもの・依存は対象外
  Scenario: domain のファイルの列挙と検査（fixture）
    * apps/backend の .ts（テスト・依存・validate.ts を除く）を対象にし、parse の規則は domain だけに当て、違反を「規則: パス:行: 行の内容」で返す
    * apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: domain の検証（実ファイル）
    * domain は zod の parse を直接呼ばず、backend で validation_error の DomainError を作るのは validate.ts だけ

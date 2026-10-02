# テストダブルの方針（Issue #166・#177）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の test-doubles.test.ts。
# 規則の WHY と限界は test-doubles.test.ts の冒頭。
Feature: テストダブル
  Scenario: テストダブルの判定（findTestDoubleViolations）: must pass
    * 許可されたテストダブルと database の import は違反なし（now の vi.mock・WHY モック: のある vi.mock・infra のテストや API 仕様の step からの test-support/database の import など）
  Scenario: テストダブルの判定（findTestDoubleViolations）: must reject
    * 許可の外の vi.mock と test-support/database の import は、規則と行で違反になる（Repository や now 以外の vi.mock・WHY の書き方の誤り・application のテストからの import など）
  Scenario: テストファイルの列挙と検査（fixture）
    * apps/ のテストと vitest.global-setup.ts を対象にし、違反を「規則: パス:行」で返す
    * apps/ も vitest.global-setup.ts も無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: テストダブル（実ファイル）
    * backend のテストの vi.mock は @repo/shared/now だけ、test-support/database の import は infra のテスト・test-support のテスト（直下とテストデータビルダー）・API ジャーニーテスト・API 仕様テスト・global-setup だけ

# 作業ログの CI の検査（Issue #64）が ci.yml に効く形で入っていることを検査するルール検査テストの仕様（Issue #282）。step の実装は対の work-logs-check.test.ts。
# 規則の WHY と限界は work-logs-check.test.ts の冒頭。
Feature: 作業ログの CI の検査
  Scenario: ワークフローの判定（checksLogsInPullRequests）
    * PR のときだけ失敗で止まる形で lint より前に検査し、checkout が履歴を全部取るワークフローは許可する（checkout → 検査 → lint・if を式の括弧で囲む・continue-on-error: false・間に別のステップ）
    * 検査が無い・効かない・push でも動く・lint の後・履歴が浅いワークフローは拒否する（コメントアウト・|| true・; exit 0・continue-on-error: true・if が無い / push / false・base の固定・env の BASE_REF が無い / 違う・式の直接の埋め込み・fetch-depth が無い / 1・checkout が無い・空文字など）
  Scenario: 作業ログの CI の検査（実ファイル）
    * .github/workflows/ci.yml は PR のときだけ check-work-logs-diff.sh を失敗で止まる形で pnpm lint より前に実行し、checkout は fetch-depth: 0

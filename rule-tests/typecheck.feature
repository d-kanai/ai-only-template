# 型チェックのゲート（pnpm typecheck と CI の ci ジョブ。Issue #68）が効いていることを検査するルール検査テストの仕様（Issue #282）。step の実装は対の typecheck.test.ts。
# 規則の WHY と限界は typecheck.test.ts の冒頭。
Feature: 型チェックのゲート
  Scenario: typecheck の判定（typechecksAllProjects）
    * 3 つの tsconfig を tsc --noEmit で検査するスクリプトは許可する（順不同・--project・pnpm exec・ほかのフラグ）
    * 検査しない tsconfig がある・失敗を打ち消す・型チェックを弱めるスクリプトは拒否する（apps/backend・直下・apps/shared が無い・--noEmit が無い・|| true・;・|・--noCheck・false を渡す・tsc でない・-p が 2 つ・別の tsconfig・空文字）
  Scenario: ワークフローの判定（runsTypecheckBeforeBuild）
    * pnpm typecheck を build より前に失敗で止まる形で実行するワークフローは許可する（lint → typecheck → build・名前付きのステップ）
    * typecheck が無い・効かない・build の後のワークフローは拒否する（ステップが無い・コメントアウト・continue-on-error・if・|| true・build の後）
  Scenario: 型チェックのゲート（実ファイル）
    * package.json の typecheck は、リポジトリ直下と apps/backend・apps/shared の tsconfig を tsc --noEmit で検査する
    * .github/workflows/ci.yml は pnpm typecheck を pnpm build より前に、失敗で止まる形で実行する

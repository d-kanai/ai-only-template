# セキュリティの検査ツール（gitleaks・actionlint・zizmor・hadolint・Trivy・Semgrep。Issue #362。E2E を通す ZAP。Issue #364、日次は Issue #405）が固定した版で、コミットフックと CI とデプロイに効く形で入っていることを検査するルール検査テストの仕様。step の実装は対の security-scan.test.ts。
# 規則の WHY と限界は security-scan.test.ts の冒頭と .claude/rules/tooling/security-scan.md。
Feature: セキュリティの検査の組み込み
  Scenario: イメージの固定の判定（isPinnedImage）
    * 名前とタグと 64 桁の sha256 の digest で書いたイメージは許可する（Docker Hub の名前・owner の無い名前・タグの . と -）
    * digest の無い・タグの無い・digest が短い・大文字・digest の後ろに文字があるイメージは拒否する
  Scenario: 検査ツールの版の固定（findImageViolations）
    * scan.sh のイメージがすべて digest 付きで、zizmor は digest の FROM とハッシュ付きの requirements と同じ版のタグで作り、semgrep-rules をコミットで固定していれば違反なし
    * タグだけのイメージ・zizmor のタグと requirements の版のずれ・digest の無い FROM・ハッシュの無い requirements・--require-hashes の無い pip・短いコミットの semgrep-rules は、規則ごとの違反になる
  Scenario: コミットフックの組み込み（findHookViolations）
    * pre-commit の gitleaks・actionlint・zizmor・hadolint・trivy-config と pre-push の semgrep が、決まった run と glob だけを持てば違反なし（ほかのコマンドがあってもよい）
    * コマンドが無い・コメントアウト・run の変更や || true・glob を狭める・skip や only を足す・フックに skip を足す・トップレベルに extends や rc を足す・別のフックに移すと違反になる
  Scenario: CI の組み込み（findCiViolations）
    * ci.yml の ci job の steps が 6 つの検査をそのまま実行すれば違反なし
    * 検査のステップが無い・if で飛ばす・continue-on-error で無視する・次の行の || true・job の if や continue-on-error・steps の外にだけある検査・step の shell や env・job やワークフローの defaults は違反になる
  Scenario: 日次の ZAP の組み込み（findZapDailyViolations）
    * zap.yml が schedule で動き、zap job の steps が zap-e2e をそのまま実行すれば違反なし
    * ステップが無い・if で飛ばす・continue-on-error で無視する・step の shell や env・job の if や continue-on-error・job やワークフローの defaults・schedule が無い・zap job が無いと違反になる
  Scenario: デプロイのイメージの検査（findDeployViolations）
    * deploy.yml の deploy job が、今回のイメージを trivy-image で検査してからマイグレーションとデプロイをすれば違反なし
    * 検査が無い・デプロイの後・別の条件の if・continue-on-error で無視する・検査のステップの shell や env・ワークフローの defaults は違反になる
  Scenario: セキュリティの検査の組み込み（実ファイル）
    * リポジトリの scan.sh・zizmor のイメージ・lefthook.yml・ci.yml・zap.yml・deploy.yml は上の規則の違反が無い

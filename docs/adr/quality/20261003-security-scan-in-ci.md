# 依存の脆弱性は ci ジョブの pnpm audit（high 以上で失敗）で、コードの脆弱性は CodeQL の advanced setup で検査する

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #112 / `.github/workflows/ci.yml` / `.github/workflows/codeql.yml` / `.claude/rules/tooling/github-actions.md` / `rule-tests/github-actions.test.ts` / quality/20260928-pnpm-minimum-release-age-5-days.md

## 背景
CI は lint / typecheck / test / build / E2E だけで、依存の既知の脆弱性とコードの脆弱性のパターンを検査していなかった（2026-09-29 の基盤の棚卸し、Issue #112）。日次の Claude のセキュリティレビュー（security-review.yml）は文脈を読む検査で、毎回同じに止まる機械の検査ではない。依存は minimumReleaseAge（5 日）で、公開から 5 日未満の版を入れない設定にしている。

## 決定
- 依存: `ci` ジョブ（Ruleset `protect-main` の required status check）の `pnpm install` の直後に `pnpm audit --audit-level high` を置く。high と critical があれば失敗する。devDependencies も含める。`--ignore-registry-errors` は付けない。
- 誤検知・すぐには直せない指摘は、`pnpm-workspace.yaml` の `auditConfig.ignoreGhsas` に GHSA の ID を足して外す。足すときは、行のコメントに WHY（なぜ影響が無いか・いつ外すか）を書く。
- minimumReleaseAge との関係: 直った版が公開から 5 日未満だと install できない。そのときは、待つか、`minimumReleaseAgeExclude` にその版だけを足すか（pnpm 12.7.0 の本体に設定名があることだけを確かめ、効くかは未確認）、`auditConfig.ignoreGhsas` で一時的に外すかを PR で判断する（どれもリポジトリの設定の変更として PR に残る）。
- コード: CodeQL の advanced setup（`.github/workflows/codeql.yml`）で、`javascript-typescript` と `actions` を `build-mode: none` の既定のクエリで解析する。main 宛の PR・main への push・週 1 回の定期実行で動く。
- CodeQL の結果を required status check に入れるかは、この PR の CI で所要時間と誤検知を見てから決める（入れるなら Ruleset の変更で daiki が行う）。CodeQL の誤検知は、GitHub の Security タブで理由を付けて dismiss する（コードにコメントで抑制を書く仕組みは JavaScript の CodeQL には無い。未確認）。
- 検査の形（ci ジョブにあること・コマンドの完全一致・`if` と `continue-on-error` が無いこと、CodeQL の init / analyze と言語・トリガー）は `rule-tests/github-actions.test.ts` が検査する。

## 理由
- high にしたのは、2026-10-03 の実測（2026-10-03 の work-logs）で moderate が 4 件（Stryker の推移的依存の qs など開発時だけ使うもの）あり、moderate で止めると直せるまで全 PR が止まるため。high 以上は開発時の依存でも CI の中で動くので止める。
- ci ジョブに入れたのは、別のジョブにすると required status check に入らず、赤でも auto-merge でマージされるため。新しい advisory が公開されると無関係な PR も止まるが、ignoreGhsas か更新で止めを解くのを先にする（脆弱性を残したまま進めない）。
- `auditConfig.ignoreGhsas` は pnpm 12.7.0 で効くこと（指定した GHSA が「1 ignored」になる）を実測した（2026-10-03 の work-logs）。CLI の `--ignore` より設定ファイルのほうが、外した理由をコメントで残せる。
- CodeQL を advanced setup にしたのは、action の SHA 固定と timeout（Issue #351）・言語・権限をリポジトリのファイルで管理でき、ルール検査テストで縛れるため。default setup とは同時に使えない（https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning ）。
- `actions` も解析するのは、ワークフローに Claude（security-review.yml）と GCP の資格情報（deploy.yml）があり、`${{ }}` のスクリプトインジェクションなどの被害が大きいため。

## 採用しなかった案
- `pnpm audit --audit-level moderate`: 今ある moderate 4 件で全 PR が止まる。
- `pnpm audit --prod`（本番の依存だけ）: CI の中で動く開発時の依存（テスト・ビルドのツール）の high を見逃す。
- audit を別のジョブ（required にしない）に置く: 赤でもマージされ、見られなくなる。
- Dependabot alerts だけに任せる: PR を止めない。Dependabot の導入は Issue #111 で別に決める。
- CodeQL の default setup: 設定がリポジトリのファイルに残らず、テストで縛れない。

## 影響
- 良い点: high 以上の脆弱性のある依存は PR でマージできなくなる。CodeQL の指摘が PR の該当行と Security タブに出る。
- 悪い点: 新しい advisory が公開されると、変更と無関係な PR の `ci` も赤になる（直すか ignoreGhsas で外すまで、全 PR が止まる）。audit は npm レジストリに問い合わせるので、レジストリが落ちていると `ci` が赤になる。moderate 以下は見ない。
- 見直す条件: audit で無関係な PR が止まることが頻繁になったら、audit を別ジョブと日次の実行に分けるかを見直す。CodeQL の誤検知・所要時間が分かったら、required status check に入れるかを決める。

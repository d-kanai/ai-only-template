---
paths:
  - ".github/workflows/**"
  - "rule-tests/github-actions.test.ts"
---

# GitHub Actions のワークフロー（Issue #351）

`.github/workflows/*.yml`（`ci.yml` / `deploy.yml` / `mutation.yml` / `security-review.yml`）の書き方の決まり。強制は `rule-tests/github-actions.test.ts`（`pnpm test`。仕様は対の `rule-tests/github-actions.feature`、判定の細部と限界はテストの冒頭）。

## 規則
- `actions-pinned-sha`: `uses:` は action のリポジトリの full-length（40 桁）の commit SHA で固定し、行末のコメントにそのコミットのタグを書く（`uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0`）。
  - WHY: タグ（`v4`）やブランチは action のリポジトリ側で別のコミットに差し替えられ、CI とデプロイ（GCP の資格情報を持つ）で別のコードが動きうる。GitHub 公式の Actions の secure use が「Pin actions to a full-length commit SHA」を挙げる（https://raw.githubusercontent.com/github/docs/main/content/actions/reference/security/secure-use.md ）。短い SHA も拒否する。
  - WHY 行末のコメントにタグ: SHA だけではどの版か読めない（Dependabot / Renovate がこのコメントを読んで更新するかは未確認）。コメントの有無はテストで見ない（更新の手順で書く）。
  - 例外: `./` で始まる同じリポジトリの action・再利用ワークフロー（ワークフローと同じコミットのファイルが使われる）。`docker://` は `@sha256:<64 桁>` の digest で固定したものだけ許す（イメージのタグもタグと同じく差し替えられる。今は使っていない）。
- `job-timeout`: すべての job に、job の直下の `timeout-minutes: <正の整数>` を書き、直前のコメントに WHY（実測の所要時間か、未確認ならその旨）を書く（コメントの有無はテストで見ない）。フロー形式の job（`b: { ... }`）は中身を読まず違反にする。再利用ワークフローを呼ぶ job が `timeout-minutes` を受け付けるかは未確認で、使い始めて書けなければ例外を足す。
  - WHY: 書かないと GitHub の既定の 360 分まで止まらず、テストの無限ループや待ちの固まりで Actions の分数を食う（Claude Code の GitHub Actions のドキュメント https://code.claude.com/docs/en/github-actions もコスト管理として workflow の timeout を挙げる）。step の `timeout-minutes` は job 全体の上限にならないので数えない。
  - 今の値: `ci` 30 分（直近 100 回の成功の最長は約 3.5 分）、`deploy` 30 分（実際のデプロイの所要時間は未確認）、`mutation` 30 分（ローカルの実測で約 3.5 分）。根拠は各ワークフローのコメント。

## 依存の脆弱性の検査（Issue #112）
決定と採用しなかった案（CodeQL を入れない理由を含む）は ADR `docs/adr/quality/20261003-pnpm-audit-in-ci.md`。
- `audit-in-ci`: `ci.yml` の `ci` ジョブで `pnpm audit --audit-level high` を、`steps:` の中で、step にも `ci` ジョブにも `if` と `continue-on-error` を付けずにそのまま実行する（`|| true` などを、次の行に書く形も含めて足さない）。ワークフローは PR と main への push の両方で、`paths` / `paths-ignore` なしで動く。
  - WHY `ci` ジョブ: required status check は `ci` だけで、別のジョブだと赤でもマージされる。WHY high: moderate は開発時の依存に 4 件あり（2026-10-03 の work-logs）、止めると全 PR が止まる。
  - 止まったら: 直った版に上げる（`dependency-update`）。直った版が minimumReleaseAge（5 日）でまだ入らない・影響が無いときは、`pnpm-workspace.yaml` の `auditConfig.ignoreGhsas` に GHSA の ID を足し、行のコメントに WHY といつ外すかを書く。
- 機械化: `rule-tests/github-actions.test.ts` の `auditsDependencies`。push の branches が main を含むかと、ignoreGhsas の WHY のコメントは縛れない（reviewer が見る）。

## Claude Code を Actions で動かすとき（Issue #354）
今は `security-review.yml`（main に前回のレビュー以降に入った差分の日次セキュリティレビュー。決定は ADR `docs/adr/workflow/20261002-daily-security-review-in-actions.md`）だけ。
- 認証は repo の Secret `CLAUDE_CODE_OAUTH_TOKEN`（daiki が `claude setup-token` で作る。サブスクの枠）。モデルは `--model` で明示する（`.claude/settings.json` の model はオーケストレータ用）。
- action は Claude GitHub App のトークン（書き込み権限あり）を Claude の環境に渡す。Claude の権限は `--allowedTools` で読み取りに絞り（Write も渡さない）、結果は `--json-schema` で返させ、GitHub への書き込みは決まった形の別のステップが行う。Claude の出力は `run:` に式で埋め込まず `env:` で渡す。WHY: claude-code-action の docs/security.md の「権限は最小に」。プロンプトインジェクションで書き込みの口を使わせない。
- runner の中だけ `.claude/settings.json` の hooks と model を外してから呼ぶ（permissions などそれ以外は CI の Claude にも効く）。WHY: OAuth では `--bare`（フックを読まない）が使えず（https://code.claude.com/docs/en/headless.md ）、Stop フック `require-work-log.sh` が作業ログを求めて turn を無駄にする。
- この repo は public なので、脆弱性の指摘は公開の Issue に書かず、非公開の security advisory の下書きにする（Secret `SECURITY_ADVISORY_TOKEN`）。
- 対象が無い日は Claude のステップを `if:` で飛ばす（消費 0）。`--max-turns` と `timeout-minutes` で上限を置く。
- 機械化: SHA 固定と timeout は `rule-tests/github-actions.test.ts`。権限の絞り方は縛れない（ワークフローの書き方で決まり、字句で正否を決められない。reviewer が見る）。

## 更新するとき（版を上げる・action を足す）
1. タグの一覧を引く: `git ls-remote --tags https://github.com/<owner>/<repo>`。
2. 使うタグの行のうち、`refs/tags/<タグ>^{}` の行があればそのコミットを使う（annotated tag は `^{}` の無い行がタグのオブジェクトの SHA で、コミットではない）。`^{}` の行が無ければ（lightweight tag）`refs/tags/<タグ>` の行のコミットを使う。2026-10-02 の実測: `pnpm/action-setup` の `v4` は annotated（`v4` の行は `f40ffcd…`、`v4^{}` の行がコミット `b906aff…`）、`actions/checkout` の `v4` は lightweight（`^{}` の行が無い）。
3. `uses: <owner>/<repo>@<40 桁> # <タグ>` と書く。メジャーのタグ（`v4`）が指すコミットに合わせるときは、同じコミットを指す完全なタグ（`v4.4.0`）をコメントに書く。
4. 版を上げるなら、リリースノートで破壊的な変更を確かめ、PR の CI（`ci` ジョブ）で動くことを確かめる。`deploy.yml` の action は CI では動かないので、マージ後のデプロイの実行を確かめる。

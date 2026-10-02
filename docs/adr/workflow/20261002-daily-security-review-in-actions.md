# main に前回のレビュー以降に入った差分を、GitHub Actions の Claude Code で日次セキュリティレビューする

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #354 / `.github/workflows/security-review.yml` / `.claude/rules/tooling/github-actions.md`

## 背景
AI x GitHub のプラクティス調査（Issue #351 の作業ログ）で、Anthropic のセキュリティの多層化（書いている最中・ブランチ・PR・リポジトリ全体）のうち、この repo には Claude によるセキュリティの観点のレビューが無かった。PR ごとに `/security-review` を回すのは、PR のたびに消費が増えるので入れなかった（workflow/20260929-save-usage-limit.md）。`/security-review` は既定でブランチの差分を対象にする。この repo は public。

## 決定
- 毎朝 1 回（08:47 JST）、main に前回の成功したレビュー以降に入った差分（`--first-parent`。前回が無ければ 24 時間前の main の先頭から）を、`anthropics/claude-code-action` で Claude Code（Sonnet 5.5）にレビューさせる。差分が 0 件の日は Claude を呼ばない。
- 認証は daiki の `claude setup-token` の OAuth トークン（repo の Secret `CLAUDE_CODE_OAUTH_TOKEN`。サブスクの枠）。
- Claude には読むことだけを許し（`--allowedTools` で Read / Grep / Glob と git の読み取り）、結果は `--json-schema` の決まった形で返させる。
- 指摘は、次のステップが指摘ごとに非公開の security advisory の下書きにする（repo の Secret `SECURITY_ADVISORY_TOKEN`。daiki の fine-grained PAT で Repository security advisories の書き込みだけ）。コードは変えない。
- runner の中だけ `.claude/settings.json` の hooks と model を外す（OAuth では `--bare` が使えず、Stop フックが作業ログを求めて turn を無駄にするため。model はオーケストレータ用の指定のため）。

## 理由
- daiki の判断（2026-10-02）: 「main でできてコスト安いなら 1 日 1 回に載せて良い」。実行場所は GitHub Actions（判断のカードで選択）。repo の他の定期ジョブ（mutation）と同じ場所で管理でき、テンプレートとして再利用でき、スレッドの寿命に左右されない。
- 前回からの差分なら 1 回の入力は小さく、schedule の遅れや止まった日があっても、main に入った変更は次の成功した回で 1 度は見られる。
- action は Claude GitHub App のトークン（書き込み権限あり）を Claude の環境に渡すので、ツールの許可で読み取りに絞り、書き込みは決まった形のステップが行う（claude-code-action の docs/security.md の「権限は最小に」）。
- public の repo の Issue に載せると、直す前の脆弱性と悪用の手順が誰でも読める（reviewer の指摘）。security advisory の下書きは管理者だけが読める。GITHUB_TOKEN では作れない（API が security manager か管理者のユーザーを求める。GitHub の REST API の記述 api.github.com.json で確認）。

## 採用しなかった案
- PR ごとに `/security-review` を回す: PR のたびに消費が増え、PR を開くと Codex のレビューが既に走る。
- Claude Code の Routine（定期実行）: このプロジェクト（private）では起動を新しいセッションにできず、作業したスレッドに毎日届く形になる（2026-10-02 に `create_trigger` が拒否）。repo にも残らない。
- `anthropics/claude-code-security-review` の Action: PR の差分向けで、既定のモデルが古く、プロンプトインジェクションへの耐性が無いと README に明記されている。
- main 全体を毎日レビューする: 毎回の入力が大きく、同じコードを毎日見直すことになる。
- 指摘を公開の Issue にする: 上の理由。
- 「実行した時刻から 24 時間前」で区切る: schedule の遅れの差の時間に入ったマージがどちらの回にも入らない（reviewer の指摘）。

## 影響
- 良い点: main に入った変更はすべて、翌朝までにセキュリティの観点で 1 度見られる。指摘は非公開の advisory として残る。
- 悪い点: マージから指摘まで最大 1 日遅れる。Secret が 2 つ要る。OAuth トークンと PAT の期限と更新は未確認。実際の所要時間（timeout 20 分）と、schedule での action の動作は、Secret の登録後の手動実行で確かめる。
- 見直す条件: 指摘の誤検知が多い、見落としが目立つ（Opus に上げる）、または消費が目立つとき。

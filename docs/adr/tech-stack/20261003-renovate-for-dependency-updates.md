# 依存の自動更新は Renovate（GitHub App）で行い、Dependabot は使わない

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #111 / `.github/renovate.json5` / `.claude/skills/dependency-update/SKILL.md` / `scripts/hooks/check-work-logs-diff.sh` / `rule-tests/pnpm-workspace.test.ts`

## 背景
依存は完全固定（quality/20260928-pin-exact-dependency-versions.md）で、`.github/` に Dependabot / Renovate の設定が無く、更新が手動で滞っていた。
制約: pnpm 12（`packageManager: pnpm@12.7.0`）、`pnpm-workspace.yaml` の `minimumReleaseAge: 7200`（5 日）と `minimumReleaseAgeStrict: true`（quality/20260928-pnpm-minimum-release-age-5-days.md）、`@stryker-mutator/vitest-runner` への pnpm patch（tech-stack/20260928-patch-stryker-vitest-runner.md）、すべての PR に作業ログを求める CI（workflow/20260928-work-log-enforced-by-stop-hook-and-ci.md）。

## 決定
- 依存の自動更新は Renovate の GitHub App（Mend が提供する Renovate）で行う。設定は `.github/renovate.json5`。
- 週 1 回（月曜の 0〜9 時、日本時間）。グループは Next.js / React・Biome・Vitest・型定義・pnpm・GitHub Actions。メジャーは同じグループでも別の PR。
- 公開から 5 日経った版だけで PR を作る（pnpm の `minimumReleaseAge` と同じ日数。待つ間は PR を作らない）。
- 見る依存は npm（package.json・lockfile・`packageManager`）・asdf（`.tool-versions` の pnpm）・GitHub Actions。Node.js・Dockerfile・compose.yaml のイメージ・Terraform は人が Issue で上げる。
- Stryker（pnpm patch を当てている）は Renovate で更新しない。
- 作業ログの CI は、作者が `renovate[bot]` で依存のファイルだけを変えた PR を通す。
- 自動マージはしない（Renovate の PR も人かオーケストレータが確かめてマージする。変えるときは新しい ADR にする）。

## 理由
- Dependabot は pnpm 12 を公式に対応していない（GitHub Docs の Supported ecosystems は pnpm v7〜v10。https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories 、2026-10-03 に確認）。pnpm 12 と `minimumReleaseAgeStrict` の組み合わせで、Dependabot の `pnpm update --no-save` が `ERR_PNPM_STRICT_MIN_RELEASE_AGE_REQUIRES_SAVE` で全件失敗した報告がある（https://github.com/shoji9x9/portfolio/issues/109 、2026-09-19）。pnpm 12 への対応の PR（https://github.com/dependabot/dependabot-core/pull/16169 ）はマージされたかを確認できなかった（未確認）。
- Renovate は `packageManager` の pnpm の版で lockfile を作り直し、pnpm 12 のリポジトリで更新の PR を作っている例が複数ある（pnpm 12.7.0 への更新の PR など）。待つ日数（`minimumReleaseAge`）・`internalChecksFilter`・グループ・`groupSlug` を設定でき、試走で意図どおりのブランチの分け方になった（2026-10-03 の work-logs）。
- GitHub App にするのは、GitHub Actions の `GITHUB_TOKEN` で作った PR では `pull_request` のワークフロー（CI）が動かないため（自前の Actions で動かすには PAT か GitHub App の秘密が要る）。
- bot は作業ログを書けない。依存の更新の記録（どの版からどの版へ・リリースノート）は PR そのものに残る。コードの変更が混ざった PR は今までどおり作業ログを求める。

## 採用しなかった案
- Dependabot: 設定ファイルだけで動き、GitHub の Security タブと統合されているが、pnpm 12 と `minimumReleaseAgeStrict` で更新が失敗する（上の理由）。`cooldown` で待つ日数を持てる点は Renovate と同じ。
- Renovate を GitHub Actions で自前で動かす: `GITHUB_TOKEN` では CI が動かず、PAT か GitHub App の秘密の管理が増える。
- bot の PR にも作業ログを求める（例外なし）: bot が書けないので、毎回人が作業ログを足すことになる。
- Stryker も Renovate で更新し、パッチが当たらなくなったら PR の失敗で気づく: 失敗する PR が毎週並ぶ。パッチの要否は人が見直すほうが早い。

## 影響
- 良い点: 依存の更新の PR が週 1 回まとまって届き、CI で確かめてからマージできる。待つ日数が pnpm と食い違わないことを `rule-tests/pnpm-workspace.test.ts` が検査する。
- 悪い点: Renovate の GitHub App をリポジトリに入れる必要がある（リポジトリの持ち主の操作）。Renovate のサーバ（Mend）にリポジトリを読む権限を渡す。人が Renovate のブランチに依存のファイルだけを push すると作業ログ無しで通る。
- 見直す条件: Dependabot が pnpm 12（以降）と `minimumReleaseAgeStrict` に対応したとき。自動マージを始めるとき。

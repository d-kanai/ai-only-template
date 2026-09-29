# pnpm のサプライチェーン保護をリポジトリの設定に持ち、minimumReleaseAge は 5 日にする

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #32 / PR #35 / PR #14 / `.claude/rules/dependencies.md` / `pnpm-workspace.yaml` / `rule-tests/pnpm-workspace.test.ts`

## 背景
開発機の safe-chain（公開から 14 日未満の版を隠す）は、シェルの rc で npm / pnpm を包む関数で、rc を読まないプロセス、`~/.asdf/shims/pnpm` の直叩き、クラウドセッション、CI では効かない。PR #14 で `pnpm-workspace.yaml` に保護の設定を入れた時点の `minimumReleaseAge` は 1440 分（1 日）だった。

## 決定
- サプライチェーン保護はリポジトリの `pnpm-workspace.yaml` に持つ（`minimumReleaseAge` / `minimumReleaseAgeStrict` / `trustPolicy` / `trustPolicyIgnoreAfter` / `blockExoticSubdeps` / `strictDepBuilds`）。
- `minimumReleaseAge` は 7200 分（5 日）。safe-chain の 14 日には揃えない。
- 版は「公開から 5 日以上経った版のうち最新」を選ぶ。

## 理由
- リポジトリの設定なら、実行経路（safe-chain の有無）に関係なく効く（2026-09-28 の work-logs「pnpm のサプライチェーン保護設定を追加」。一次情報は pnpm 公式の settings と supply-chain-security のページ）。
- 14 日に揃えると Next.js などの更新に 2 週間遅れで追随することになる（ユーザー判断。2026-09-28 の work-logs「pnpm の minimumReleaseAge を 5 日（7200 分）に引き上げ、lockfile を再解決（Issue #32）」）。

## 採用しなかった案
- 14 日（safe-chain と同じ）: 更新が 2 週間遅れる。
- 1 日のまま: 公開直後の悪意あるリリースを避ける待機期間として短い（Issue #32）。
- `trustPolicy: no-downgrade` で拒否された古い版を個別に除外する: `trustPolicyIgnoreAfter`（1 年）で古い版をまとめて対象外にした（PR #14）。

## 影響
- 良い点: クラウド・CI・shim の直叩きでも同じ保護が効く。
- 悪い点: 公開から 5 日未満の版はすぐには入れられない。lockfile に条件を満たさないエントリが残ると部分的に直せず、作り直しになる（2026-09-28 の work-logs の同じ項目）。`packageManager` の pnpm 本体は検査の対象外だった（公式の仕様は未確認）。
- 見直す条件: 記録に無い。

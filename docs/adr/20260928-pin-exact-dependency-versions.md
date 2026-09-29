# npm の依存は package.json でも完全固定（x.y.z）にする

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #17 / PR #19 / Issue #50 / `.claude/rules/dependencies.md` / `rule-tests/package.test.ts`

## 背景
create-next-app の生成物は `^` 付きの範囲指定で、lockfile を作り直すと範囲内の別の版が入りうる。どの版を使うかを `package.json` の差分で読めるようにしたかった（Issue #17）。

## 決定
- dependencies / devDependencies はすべて `x.y.z` の完全固定にする。`^` `~` などの範囲、プレリリース、ビルドメタ、`=1.2.3`、`v1.2.3` は書かない（プレリリースなどの拒否は Issue #50）。例外は workspace の `workspace:*` だけ（PR #74）。
- `pnpm add` が範囲を付けないよう `savePrefix: ''` を設定し、`rule-tests/package.test.ts` で検査する。

## 理由
- lockfile だけに頼ると、lockfile の作り直し（20260928-pnpm-minimum-release-age-5-days.md の再解決など）で意図しない版が入る。`package.json` で固定すれば、版の変化は必ず `package.json` の差分に出る。
- 文章のルールではなくテストで止める。範囲指定の依存でテストが失敗することを確かめてから固定した（2026-09-28 の work-logs「rules を general / code に分割し、npm 依存の完全固定をルール化（Issue #17）」、PR #19）。

## 採用しなかった案
- 検討した案は記録に無い。

## 影響
- 良い点: 版の変更がレビューで見える。
- 悪い点: 更新は手で版を書き換える（手順はスキル `dependency-update`）。推移的依存は lockfile でしか固定されない。
- 見直す条件: 記録に無い。

# Renovate の patch / minor の更新は CI が緑なら自動マージし、メジャーと Next.js / React は人が確かめる

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #375 / Issue #111 / tech-stack/20261003-renovate-for-dependency-updates.md / `.github/renovate.json5` / `rule-tests/pnpm-workspace.test.ts`

## 背景
tech-stack/20261003-renovate-for-dependency-updates.md で Renovate を入れたとき、自動マージはユーザーの判断待ちで「しない」にしていた（その ADR の決定の 1 項目）。更新の PR を毎週人が確かめてマージすると、手間の大半が patch / minor の確認になる。

## 決定
- patch / minor と、版の固定（pin）・commit SHA だけの更新（digest）は、CI の `ci` ジョブが緑なら自動でマージする。GitHub の auto-merge を merge commit で付ける。
- メジャーは自動マージしない（リリースノートを読んでから人かオーケストレータがマージする）。
- 0.x の依存（drizzle-orm・drizzle-kit・esbuild など）は patch / minor でも自動マージしない。
- Next.js / React のグループは patch / minor でも自動マージしない。
- この ADR は、tech-stack/20261003-renovate-for-dependency-updates.md の「自動マージはしない」の項目だけを置き換える（ほかの決定はそのまま）。

## 理由
- ユーザー判断（daiki、2026-10-03。Issue #111 のスレッドの選択肢「patch/minor だけ自動」）。テストのカバレッジを 100% にし、CI で E2E まで動かしているので、patch / minor の破壊は CI で止まる見込みが高い。
- 0.x を外すのは、semver では 0.x の minor も破壊的な変更にあたるのに、Renovate は major の数字だけでメジャーかを決め、0.45 → 0.46 を minor にするため（renovate 44.132.2 の `workers/repository/process/lookup/update-type.js`。reviewer の実測）。daiki の判断「メジャーは確かめる」の趣旨（破壊的な変更は人が見る）に合わせた既定。
- Next.js / React を外すのは、React の版を create-next-app が生成する版に合わせる例外があり（`.claude/rules/tooling/dependencies.md`）、CI ではそれを確かめていないため。
- 設定どおりに当たることは、renovate 44.132.2 の packageRules の適用関数に設定を通して確かめた（2026-10-03 の work-logs）。

## 採用しなかった案
- 自動マージしない: 毎週の patch / minor の確認が手間になる。
- メジャーも含めてすべて自動: 破壊的な変更をテストが見逃すと main に入る。

## 影響
- 良い点: patch / minor は人の手を介さずに入る。メジャーに自動マージが付かないことを `rule-tests/pnpm-workspace.test.ts` が検査する。
- 悪い点: CI が見ない壊れ方（本番だけの挙動・mutation のスコア）は、マージ後に気づくことになる（Mutation は日次のジョブで見る）。
- 見直す条件: 自動マージした更新で main が壊れたとき。

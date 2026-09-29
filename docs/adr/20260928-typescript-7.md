# TypeScript は 7 系（7.0.2）を使う

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #17 / PR #19 / `.claude/rules/dependencies.md`

## 背景
Next.js 16.3.6 の導入時（PR #14）は、create-next-app が指定する TypeScript 5 系だった。依存を完全固定する（20260928-pin-exact-dependency-versions.md）にあわせて、最新の 7.0.2 に上げるかを決める必要があった。7 系は従来の JS API（`typescript.js`）を持たない。

## 決定
- TypeScript は 7.0.2 を使う。採用の条件は「Next.js 16 のビルドと Vitest で動くこと」で、動かなければ 5 系のまま固定し理由を書く、としていた（Issue #17）。
- `vite-tsconfig-paths` は外し、Vite 8 標準の `resolve.tsconfigPaths` を使う。

## 理由
- 最新を使う方針（Issue #17）。scratchpad で `next build`（型チェック込み）と Vitest が通り、型エラーを置くと `next build` が exit 1 になることを確かめた（2026-09-28 の work-logs「TypeScript を 7.0.2 に更新（Issue #17）」）。
- `vite-tsconfig-paths` の依存 tsconfck が TS 7 で unmet peer になった（2026-09-28 の work-logs「`vite-tsconfig-paths` を削除し Vite 8 標準の `resolve.tsconfigPaths: true` に置換」）。

## 採用しなかった案
- 5 系のまま固定する: 7.0.2 が Next.js 16 と Vitest で動いたので採らなかった。

## 影響
- 良い点: 依存の版を「最新」の方針にそろえられる。
- 悪い点: TypeScript の JS API に依存するツールが使えない。ESLint（typescript-eslint）の代わりに Biome（20260928-biome-instead-of-eslint.md）、dependency-cruiser の代わりに自前のテスト（20260928-dependency-direction-checked-by-own-test.md）、Stryker の typescript-checker は入れない（20260928-mutation-testing-daily-with-score-100.md）。
- 見直す条件: 上のツールが TS 7 に対応したとき（それぞれの ADR の見直す条件）。

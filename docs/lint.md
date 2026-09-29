# Lint / Format の実測と経緯

規則は `.claude/rules/lint.md`。ここは読み込まれない記録（Issue #64 で旧ルールファイルから移した）。

## ESLint を使わない理由の実測（2026-09-28）
- `@typescript-eslint/parser@8.70.0` + `typescript@7.0.2` で `require('@typescript-eslint/parser')` を実行すると、`typescript-eslint does not support TS 7.0.` を出して例外になった。peerDependencies も `typescript: >=4.8.4 <6.1.0`。
- 再検討の条件: typescript-eslint が TS 7.1 以降に対応したら（https://github.com/typescript-eslint/typescript-eslint/issues/10940 ）。

## Biome 2.5.13 の実測
- recommended の JS ルール 178 件のうち、既定 severity が warn 50 件・info 26 件（`biome explain <rule>` の Default severity で確認）。
- テンプレートの `"recommended": true` は非推奨（`biome rage --linter` が「deprecated ... Use preset instead」と出す）。
- 制限したパスへの `import type` も `noRestrictedImports` の違反になる（Issue #47）。
- `noProcessEnv` の検出範囲（分割代入などを拾わない）は `docs/env.md`。

## lefthook
- 環境変数 `CI` が有効（`"0"` / `"false"` 以外）なときは postinstall がフックを入れない（lefthook@2.1.12 の `postinstall.js` で確認）。
- worktree で `pnpm install` や `lefthook run` を実行すると、本体と共有の `.git/hooks/pre-commit` が worktree のパスに書き換わった（Issue #26 / #34 / #50。LEARNINGS.md）。

# linter / formatter は Biome を使い、ESLint は使わない。pre-commit は lefthook で止める

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #26 / PR #33 / `.claude/rules/lint.md` / `biome.json` / `lefthook.yml` / `rule-tests/lint.test.ts`

## 背景
linter / formatter を入れて品質を機械的に担保し、違反をコミット前に止めたかった（ユーザーの要望は「ベストプラクティス設定、カスタムルールを入れやすい方」）。TypeScript は 7.0.2（20260928-typescript-7.md）。

## 決定
- Biome を使う。create-next-app@16.3.6 の `--biome` テンプレートを土台に、preset recommended と next / react / test の domain を有効にし、既定の severity が warn / info のルールも失敗にする（`--error-on-warnings` と個別の error 指定）。
- pre-commit は lefthook で、ステージしたファイルに `biome check` を実行する。

## 理由
- typescript-eslint は TS 7 に対応していない。`@typescript-eslint/parser` と typescript 7.0.2 の組み合わせは読み込み時に失敗し、peer も 6.1 未満（2026-09-28 の work-logs「linter の選定調査: ESLint は TypeScript 7 で動かず、Biome を採用（Issue #26）」。https://typescript-eslint.io/users/dependency-versions 、https://github.com/typescript-eslint/typescript-eslint/issues/10940 ）。`eslint-config-next` も typescript-eslint に依存する。
- Biome は typescript パッケージに依存せず TS 7 で動き、next / react の domain がある（https://biomejs.dev/linter/domains/ ）。
- recommended のままでは warn / info のルールに違反してもコマンドが失敗しない（2026-09-28 の work-logs「Biome と Lefthook を導入し、ベストプラクティスのルールを設定（Issue #26）」）。
- lefthook は Biome 公式の Git hooks のレシピで案内されている（https://biomejs.dev/recipes/git-hooks/ ）。

## 採用しなかった案
- ESLint（typescript-eslint）: TS 7 で動かない。カスタムルールは ESLint の方が書きやすい（JS で定義できる。Biome のプラグインは GritQL のパターンだけ。https://biomejs.dev/linter/plugins/ ）が、動かない以上は採れない。
- TS 6 を並べて入れて ESLint を動かす: 未検証のまま採らなかった。

## 影響
- 良い点: TS 7 のまま lint と format を 1 つのツールで回せる。
- 悪い点: カスタムルールを JS で書けない。依存の向きのような検査は自前のテストで補う（20260928-dependency-direction-checked-by-own-test.md）。
- 見直す条件: typescript-eslint が TS 7.1 以降に対応したら再検討する（Issue #26）。

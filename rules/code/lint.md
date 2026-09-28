# Lint / Format ルール

コードの lint と format は **Biome**（`biome.json`）で行い、**Lefthook**（`lefthook.yml`）の pre-commit でコミット前に違反を検知する。

## ツールの選定
- Biome を使う。ESLint（+ typescript-eslint）は使わない。
- 理由: typescript-eslint が TypeScript 7 に未対応で、読み込み時点で失敗する。2026-09-28 に `@typescript-eslint/parser@8.70.0` + `typescript@7.0.2` で `require('@typescript-eslint/parser')` を実行すると、`typescript-eslint does not support TS 7.0.` を出して例外になった（peerDependencies も `typescript: >=4.8.4 <6.1.0`）。本リポジトリは TypeScript 7 を使うため（`rules/code/dependencies.md`）、TS の型情報を使う ESLint ルールは動かせない。
- トレードオフ: プロジェクト固有のカスタムルールは ESLint の方が書きやすい（Biome は GritQL プラグインのみ）が、上記の理由で使えない。
- 再検討の条件: typescript-eslint が TS 7.1 以降に対応したら（追跡 Issue: https://github.com/typescript-eslint/typescript-eslint/issues/10940 ）、ESLint への移行・併用を Issue で検討する。

## コマンド
```sh
pnpm lint     # biome check --error-on-warnings .       … lint + format + import 整列の違反を検査（変更しない）
pnpm check    # biome check --write --error-on-warnings . … 上記の安全な自動修正（safe fix）を適用して再検査
pnpm format   # biome format --write .                  … format だけを適用
```
- 違反が出たら、まず `pnpm check` で自動修正し、残ったものを手で直す。`--unsafe` の修正は挙動が変わりうるため、差分を読んで個別に判断する。
- ルールを無効化するコメント（`// biome-ignore lint/<group>/<rule>: <理由>`）は、理由を必ず書き、やむを得ない場合だけ使う。

## severity の方針: すべて error
- 有効なルールはすべて「違反があればコマンドが失敗する」状態にする。warn / info は終了コードに影響せず、放置されるため。
- Biome の recommended には既定 severity が warn / info のルールが多い（2.5.13 では recommended の JS ルール 178 件のうち warn 50 件・info 26 件。`biome explain <rule>` の Default severity で確認）。次の 2 段で error 扱いにしている。
  - warn: `pnpm lint` / `pnpm check` / pre-commit のすべてで `--error-on-warnings` を付け、warn でも失敗させる。ルールを列挙しないため、Biome の更新で warn のルールが増えても自動で対象になる。
  - info: `--error-on-warnings` では失敗しないため、`biome.json` で個別に `"error"` を指定している（下の「recommended のうち info から error に上げたルール」）。Biome を更新したら、recommended に info のルールが増えていないか確認する。
- 担保: `lint.test.ts` が、warn（noUnusedVariables）・info（useTemplate）・追加ルール（noConsole）の**代表 1 ルールずつ**について、違反単独で `biome check --error-on-warnings` が失敗すること、`pnpm lint` / `pnpm check` / pre-commit が `--error-on-warnings` 付きであることを検査する。個々のルールの有無までは検査しないので、`biome.json` を変えるときは下の一覧と `biome explain` で確認する。

## pre-commit（Lefthook）
- 仕組み: `pnpm install` すると lefthook パッケージの postinstall が `lefthook install -f` を実行し、`.git/hooks/pre-commit` を Lefthook のスクリプトに置き換える（`pnpm-workspace.yaml` の `allowBuilds` で `lefthook: true` にして許可している。postinstall の中身とその判断は同ファイルのコメント）。以後 `git commit` のたびに `lefthook.yml` の pre-commit が実行される。
- 検査内容: ステージ済みファイルだけを `pnpm exec biome check --error-on-warnings ...` で検査し、違反があればコミットを中止する。自動修正はしない（`pnpm check` で直してステージし直す）。
- 環境変数 `CI` が有効（`"0"` / `"false"` 以外）なときは postinstall がフックを入れない（lefthook@2.1.12 の `postinstall.js` で確認）。CI ではフックは不要で、`pnpm lint` を直接実行する。
- フックが入っているかの確認: `git rev-parse --git-path hooks` の場所にある `pre-commit` が Lefthook のスクリプト（`call_lefthook run "pre-commit"` を含む）になっていること。入っていなければ `pnpm exec lefthook install` を実行する。
- git worktree の注意: フックのディレクトリ（`.git/hooks`）はメインの作業ツリーと全 worktree で共有される。worktree で `pnpm install` や `lefthook run`（設定が変わっていると自動で `lefthook install` する）を実行すると、共有のフックが書き換わる。
- フックを一時的に飛ばす: `LEFTHOOK=0 git commit ...`。**緊急時のみ**使い、使ったら理由を PR に書き、直後に `pnpm lint` を通す。`git commit --no-verify` も同様に緊急時のみ。

## biome.json の設定の WHY
JSON にはコメントを書けないため、ここに書く。ベースは create-next-app@16.3.6 の `--biome` テンプレート（`biome.json`、Biome 2.4.2 向け）。

| 設定 | 値 | WHY |
| --- | --- | --- |
| `$schema` | `./node_modules/@biomejs/biome/configuration_schema.json` | テンプレートはバージョン付き URL（2.4.2）だが、インストール済みの Biome と版がずれるとエディタの補完・検証が実際の挙動と食い違う。Biome を上げるたびに URL を直す手間もなくす |
| `vcs.enabled` / `clientKind: git` / `useIgnoreFile: true` | テンプレートのまま | `.gitignore` に書いたもの（`.next/` `node_modules` `next-env.d.ts` など生成物）を検査対象から外す。無視設定を `.gitignore` と二重管理しない |
| `files.ignoreUnknown` | `true`（テンプレートのまま） | Biome が扱えない拡張子（`.md` `.yml` など）を `biome check .` の対象にしてもエラーにしない |
| `files.includes` | `["**", "!node_modules", "!.next", "!dist", "!build"]`（テンプレートのまま） | 生成物を明示的に除外する。`.gitignore` と重複するが、`.gitignore` の書き換えで生成物が検査対象に入るのを防ぐ保険 |
| `formatter.indentStyle` / `indentWidth` | `space` / `2`（テンプレートのまま） | create-next-app が生成した既存コードと同じ。その他（行幅 80、ダブルクォート、セミコロンあり、末尾カンマ all）も Biome の既定のままで既存コードと一致するため変えていない |
| `linter.rules.preset` | `recommended` | テンプレートは `"recommended": true` だが、Biome 2.5.13 では非推奨（`biome rage --linter` が「deprecated ... Use preset instead」と出す）のため、後継の `preset` を使う |
| `linter.rules.<group>.<rule>` | 下の一覧 | recommended 外のルールの追加と、info のルールを error に上げるため |
| `linter.domains` | `next` / `react` / `test` を `recommended` | Next.js・React・Vitest 固有のルールを有効にする。テンプレートは next / react のみ。test（Vitest）は `vitest` が依存にあれば自動で有効になるが、依存の検出に頼らず明示する |
| `assist.actions.source.organizeImports` | `on`（テンプレートのまま） | import の並び順を統一し、差分のノイズとマージ時の競合を減らす |

## 有効化したルール一覧
すべて error 扱い（上の「severity の方針」）。一次情報: https://biomejs.dev/linter/javascript/rules/ 、https://biomejs.dev/linter/domains/ 、各ルールは `pnpm exec biome explain <rule>`。

### recommended（`preset: recommended`）
Biome の recommended 全体を有効にする（個別に列挙しない）。とくに次は既定 severity が warn のため、`--error-on-warnings` で error 扱いにしている。
- `correctness/noUnusedImports` / `noUnusedVariables` / `noUnusedFunctionParameters`: 消し忘れ・リファクタ漏れのコードを残さない。
- `suspicious/noExplicitAny`: `any` で型検査をすり抜けるのを防ぐ。
- `style/useImportType` / `useExportType`: 型だけの import / export を明示し、実行時に不要な import が残らないようにする。
- `style/noNonNullAssertion`: `!` で null チェックを握りつぶすのを防ぐ。
- `style/useConst`: 再代入しない変数を `const` にし、意図しない再代入を防ぐ。

### domains（`next` / `react` / `test` の recommended）
各 domain の recommended を有効にする（`useExhaustiveDependencies` / `useHookAtTopLevel` / `noImgElement` / `noFocusedTests` など）。domain で有効になるルールは `rules` に重複して書かない（ただし info のものは error に上げるため書く）。

### recommended のうち info から error に上げたルール
既定 severity が info のため `--error-on-warnings` でも失敗しないもの。書き方の統一と、無意味なコードの除去が目的。
- `complexity/noExtraBooleanCast` / `noUselessCatch` / `noUselessConstructor` / `noUselessContinue` / `noUselessEmptyExport` / `noUselessEscapeInRegex` / `noUselessFragments` / `noUselessLabel` / `noUselessLoneBlockStatements` / `noUselessRename` / `noUselessStringRaw` / `noUselessSwitchCase` / `noUselessTernary` / `noUselessThisAlias` / `noUselessTypeConstraint` / `noUselessUndefinedInitialization`: 動作に影響しない冗長なコードを残さない。
- `complexity/noFlatMapIdentity` / `useFlatMap` / `useIndexOf` / `useLiteralKeys`: 同じ処理をより直接的な書き方に揃える。
- `correctness/useParseIntRadix`: `parseInt` の基数省略による解釈の揺れを防ぐ。
- `style/useArrayLiterals` / `useExponentiationOperator` / `useShorthandFunctionType` / `useTemplate`: 書き方を 1 通りに揃える。
- `style/useNodejsImportProtocol`: Node.js 組み込みモジュールを `node:` 付きで import し、npm パッケージと区別する。
- `performance/useGoogleFontPreconnect`（next domain）: Google Fonts 読み込み時の preconnect 漏れを防ぐ。
- `suspicious/noQuickfixBiome`（JSON）: エディタ設定の `quickfix.biome` による暗黙の一括修正を防ぐ。`suspicious/noDuplicateFields`（GraphQL）: 重複フィールドを防ぐ。JS 以外の言語の info ルールで、reviewer の指摘で追加。

### recommended 外で追加したルール
- `correctness/noNestedComponentDefinitions`（react domain・recommended 外）: コンポーネント内でコンポーネントを定義すると、描画のたびに別コンポーネントとして作り直され state が消える。
- `correctness/noNextAsyncClientComponent`（next domain・recommended 外）: `"use client"` のコンポーネントを async にする誤りを防ぐ（クライアントコンポーネントは async にできない）。
- `correctness/useUniqueElementIds`（react domain・recommended 外）: 固定文字列の `id` はコンポーネントを複数回使うと DOM 上で重複する。`useId` を使わせる。
- `complexity/noExcessiveCognitiveComplexity`: 認知的複雑度が既定の上限（15）を超える関数を防ぎ、分割を促す。
- `style/noParameterAssign`: 引数への再代入で、呼び出し元の値と関数内の値の対応が追いにくくなるのを防ぐ。
- `style/useThrowOnlyError`: `Error` 以外を throw するとスタックトレースが失われる（ESLint の no-throw-literal 相当）。
- `suspicious/noConsole`（`console.error` / `console.warn` は許可）: デバッグ用の `console.log` の消し忘れを防ぐ。エラー・警告の出力は正当な用途があるため許可する。
- `suspicious/noConstantBinaryExpressions`: 常に同じ結果になる比較・論理式（書き間違い）を検出する（ESLint の recommended にある no-constant-binary-expression 相当）。
- `suspicious/noEmptyBlockStatements`: 空のブロック（握りつぶした catch、書きかけの関数など）を防ぐ。意図的に空にする場合はブロック内にコメントで理由を書く（ESLint の recommended にある no-empty 相当）。
- `suspicious/noLeakedRender`（react domain・recommended 外）: `{count && <X />}` のように `0` などが意図せず描画されるのを防ぐ。
- `suspicious/noSkippedTests`（test domain・recommended 外）: `it.skip` などで無効にしたテストのコミットを防ぐ（テスト = 仕様のため、仕様が黙って外れるのを防ぐ）。
- `suspicious/noVar`: 関数スコープの `var` による巻き上げの混乱を防ぐ。

### 採用しなかった主なルール
- `nursery` グループ（例: `noFloatingPromises` / `noMisusedPromises`）: 不安定で、semver の対象外（Biome 公式の設定リファレンス）。安定グループに昇格したら再検討する。
- `correctness/noUndeclaredDependencies`（project domain）: pnpm の既定の node_modules はルート直下に直接の依存だけを置く（推移的依存は `.pnpm` 配下）ため、未宣言の import は原則として型チェック・実行時に解決できず失敗する。project domain はスキャナを有効にするコストもある。
- `suspicious/noImportCycles`（project domain）: 現状の規模では循環が生じる構造がない。スキャナのコストに見合わないため、モジュールが増えたら再検討する。
- `suspicious/useAwait`: Next.js の Server Functions（Server Actions）は await がなくても async で定義する必要があり（Next.js 16.3.6 同梱ドキュメント `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`）、誤検知になる。
- `style/noDefaultExport`: Next.js の page / layout は default export が必須。
- `style/useBlockStatements` / `noNestedTernary` / `noMagicNumbers` など: バグ防止より好みの要素が強く、最小構成の段階では入れない。
- `security/noSecrets`: エントロピーによる推定で誤検知が出やすい。秘密情報は `.env*` を `.gitignore` 済み。

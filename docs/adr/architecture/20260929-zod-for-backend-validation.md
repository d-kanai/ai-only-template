# backend の入力検証と不変条件は zod で書く（presentation は形、domain は値の規則）

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #88 / PR #93 / `.claude/rules/backend.md` / `.claude/rules/dependencies.md`

## 背景
Issue #39 から「入力検証は手書き（ライブラリは入れない。規模が大きくなったら Issue で検討）」の方針で、presentation が `typeof` で項目の型を、domain（`Todo`）が `if` でタイトルの規則を確かめていた。規則の宣言と型が別々で、項目ごとの誤りをレスポンスに出せなかった。

## 決定
- 手書きの方針を撤回し、`apps/backend` の依存に zod（4.6.5）を入れる。
- presentation は「形」: 各 api ファイルにリクエストの zod スキーマ（`z.strictObject` で未知の項目を拒否）を置き、型は `z.infer` で導く。誤りは 400 と、`ErrorResponse` の `issues`（`{ path, message }` の一覧）。動的セグメントの id は `z.uuid()` で確かめ、形が違えば 404。
- domain は「値の規則」: `Todo` の不変条件を zod のスキーマで書き、コンストラクタは検証済みの値だけを受け取る（完全コンストラクタ）。
- branded 型は使わない。スキーマは関数の中で作る（Stryker の `ignoreStatic` で検査から外れないように）。
- どの口で検証するかは architecture/20260929-todo-restore-skips-validation.md で決めた（のちに architecture/20260929-todo-invariants-always-validated.md で置き換え）。

## 理由
- ユーザーの指示（2026-09-29 の work-logs「zod の導入指示（presentation の入力・domain の不変条件・完全コンストラクタの検証を zod で統一）→ Issue #88」）。規則の宣言と型の導出を 1 か所にし、項目ごとの誤りをレスポンスに出せる。
- 未知の項目を拒否しないと、打ち間違い（`{ complete: true }`）が「何も変えない」200 に化ける（2026-09-29 の work-logs「Issue #88: zod で presentation の入力・domain の不変条件・完全コンストラクタの検証を統一した」）。
- zod の `.min` / `.max` は `String#length` で数えるので、タイトルの文字数（コードポイント数）は `refine` で数える。`z.uuid()` は Postgres の uuid 型より狭いが、id は `randomUUID`（v4）で作るので実害は無い（同じ項目）。

## 採用しなかった案
- valibot: 主な利点は関数単位の import によるバンドルの小ささで、サーバ側だけで使う今は効かない。宣言の読みやすさで zod にした（公式の説明による比較。性能・サイズは未実測）。
- ArkType: 型に似た文字列の DSL で書く独自の構文で、学習が要る。issue の形の制御でも zod にした（同上）。
- 手書きのまま（Issue #39 の方針）: 規則と型が別々で、項目ごとの誤りを出せない。
- branded 型（`TodoTitle`）: 当時は DB の行から組み立てる口が検証しなかったので、brand を付けるには `as` で偽ることになる。

## 影響
- 良い点: リクエストの型と規則が 1 か所にまとまり、`issues` で項目ごとに誤りを返せる。
- 悪い点: PUT は id を本文より先に確かめるので、「uuid でない id + 不正な本文」は 400 から 404 に変わった。frontend でのレスポンスの実行時検証には使っていない（Issue #88 の範囲外）。
- 見直す条件: 記録に無い。

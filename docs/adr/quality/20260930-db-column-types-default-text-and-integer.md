# DB の列の型は text / integer / timestamptz などの既定に従い、長さ・精度は意味があるときだけ書き、既定から外れる列はテストで止める

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #145 / `.claude/rules/backend.md`（「列の型」） / `.claude/skills/db-migration/SKILL.md` / `rule-tests/schema.test.ts` / `apps/backend/features/todo/infra/schema.ts`

## 背景
列の型と長さの決め方が文書に無く、列を足すたびに `varchar(255)` にするか `text` にするかを判断していた。`todos.title` は `text` で、長さの上限（100 文字）は domain の不変条件が持っているが、その理由は `schema.ts` のコメントにしか無かった。Issue #144 で文字数の上限は domain（zod）の定数 1 か所に置き、presentation が参照して項目ごとの 400（`errors[]`）を返す形にした（architecture/20260930-presentation-overlaps-domain-validation.md）。ユーザー判断（2026-09-30）: 「DB の列の長さは基本ざっくりでよい。基本ルールにしてしまって。varchar(255) / int / text のように。特別に意味があるときだけ長さを指定する。多めに取っても性能は変わらないよね」。

## 決定
- 既定の型: 文字列は `text`（長さ無し）、整数は `integer`（連番の id・件数・金額の最小単位など 21 億を超えうるものは `bigint`）、小数・金額は `numeric(p, s)`（精度は常に書く）、真偽は `boolean`、日時は `timestamp` の `withTimezone: true`（timestamptz）、id は `uuid`、JSON は `jsonb`。表は `.claude/rules/backend.md` の「列の型」。
- 長さは domain が持ち、DB は型だけにする。長さそのものを DB で保証する必要があるとき（外部システムの固定長コード、CHECK で守りたい不変条件）だけ `varchar(n)` / `char(n)` か CHECK を使う。
- `rule-tests/schema.test.ts` が `apps/backend/**/infra/schema.ts` の `varchar(` / `char(`・`withTimezone: true` の無い `timestamp(`・`serial(` / `bigserial(` / `smallserial(`・`json(` を違反にする。既定から外れる列は、直前の行に規則ごとの見出しの WHY（`// WHY 長さ:`・`// WHY タイムゾーン:`・`// WHY 連番:`・`// WHY json:`）と理由を書けば通る。

## 理由
- Postgres では `text` / `varchar(n)` / `char(n)` に性能の差は無く、長さ制約は保存時の検査だけ（https://www.postgresql.org/docs/current/datatype-character.html 「There is no performance difference among these three types, apart from increased storage space when using the blank-padded type, and a few extra CPU cycles to check the length when storing into a length-constrained column. ... In most situations text or character varying should be used instead.」）。多めに取る・取らないで性能は変わらない。
- 上限を domain と DB の 2 か所に書くと、片方だけ直してずれる。上限を変えるたびにマイグレーションも要る。DB の制約違反は 500 になり、domain の 400（`errors[]` 付き）の方が利用者に直し方を伝えられる。
- 整数の `int(10)` の `(10)` は MySQL の表示幅で、Postgres の整数型に長さは無い（`integer` / `bigint` の範囲だけが意味を持つ）。
- 精度（`numeric(p, s)`）は金額の小数の桁などの意味そのものなので、既定を置かずに常に書く。
- timezone 無しの `timestamp` はサーバ・DB のタイムゾーン設定で時刻の意味が変わる（サーバは TZ=UTC 前提。Issue #116）。`json` は入力の文字列をそのまま保持して処理のたびに解析し直し、`jsonb` は処理が速くインデックスも張れる（https://www.postgresql.org/docs/current/datatype-json.html ）。id はアプリが作る `uuid` で、`serial` の連番は使わない。
- 文章の規則だけだと、`varchar(255)` を書き慣れた人や AI が既定のように書く。テストで止め、例外は WHY を書かせて理由をレビューに出す（CLAUDE.md の原則 7）。

## 採用しなかった案
- `varchar(255)` を既定にする: Postgres では性能が変わらず（上の公式の記述）、上限の意味も無い数字が DB に残るだけ。
- DB でも長さを CHECK や `varchar(n)` で二重に守る: 違反は 500 になり、domain の 400 と上限の 2 か所の管理が増えるだけ。domain を通らずに書く経路（手で入れた行）は Repository の `Todo.reconstruct` が 500 にして気づける（`.claude/rules/backend.md` の「永続化」）。
- 規則を文書だけにし、検査を持たない: 読み落とし・解釈のずれで効かなくなる（CLAUDE.md の原則 7）。
- 検査を TypeScript の AST（architecture.test.ts と同じ API）で行う: 対象は pg-core の呼び出しだけで、コメントと文字列を潰した文字列の照合で足りる。AST は重く、検査のコードが大きくなる。

## 影響
- 良い点: 列を足すときに型で迷わない。上限は domain の定数 1 か所で、変えてもマイグレーションが要らない。既定から外れる列には理由が残る。
- 悪い点: 外部の固定長コードのように長さに意味がある列にも、WHY のコメントを書く手間がかかる。検査は文字列の照合なので、pg-core の関数を変数に入れ直して呼ぶ書き方や、options を変数で渡す書き方は見えない（後者は timezone 無しとして違反になる）。
- 既存の schema は変更なし（`todos` は `uuid` / `text` / `boolean` / timestamptz で既定どおり）。
- 将来 `numeric` などを足すとき: `numeric("price", { precision: 12, scale: 2 })` のように精度を書く（検査は `numeric` の精度の有無を見ない）。インデックスは検索するクエリが決まってから足す。
- 見直す条件: DB を Postgres 以外に移すとき（長さで性能やインデックスの制約が変わる DB がある）。

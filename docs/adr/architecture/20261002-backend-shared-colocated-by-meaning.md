# backend/shared は層ではなく意味の単位（error / transaction / http / drizzle / change-log）で置き、feature からの参照を縛らない

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #310 / `.claude/rules/code/backend.md` / `.claude/rules/code/architecture-check.md` / スキル `db-migration`

## 背景
`apps/backend/shared/` は feature と同じ 4 層（`domain/` `application/` `presentation/` `infra/`）に分け、Drizzle の設定とマイグレーションだけを例外の `shared/drizzle/` に置いていた（architecture/20260929-backend-features-and-shared-directories.md）。shared の中身は feature をまたぐ道具で、1 つの関心が層に散っていた（変更履歴は `domain/change-operation.ts`・`infra/schema.ts`・`infra/change-log.ts`、HTTP のエラー応答は `domain/` と `presentation/`）。feature の層ごとに shared のどの層を使えるかも規則で縛っていた。

## 決定
- `apps/backend/` の直下を `features/` と `shared/`（と `test-support/`・`spec/`）にすることと、feature の `internal/` の 4 層は変えない。
- `apps/backend/shared/` は意味の単位で置く: `error/`（ErrorKey・DomainError・KeyedIssue・DomainValidation）、`transaction/`（Transaction の印と TransactionRunner の port）、`http/`（Problem の応答・リクエストの読み取り）、`drizzle/`（drizzle-kit の設定・接続・トランザクションの実装・Writer・列の分類・差分。生成したマイグレーションは `drizzle/migrations/`）、`change-log/`（変更履歴の表・記録・操作の一覧）。shared のファイルはこの 5 つの単位の下だけに置く。
- feature のどの層からも shared のどの単位も参照してよい（層ごとの許可と、`transaction` を型だけに限る規則を消す）。
- 残す規則: shared は features を参照しない。feature の domain・application は `drizzle-orm`・`pg` を直接 import しない。
- 旧パスの再 export などの下位互換は残さない。

## 理由
- ユーザー判断（2026-10-02 の work-logs「backend/shared を層ではなく意味の単位（error / transaction / http / drizzle / change-log）で置く案を出した」「backend/shared の案を「feature → shared は縛らない」に直した」）。「drizzle みたいに」意味の単位で colocation し、関わるファイルを 1 か所に並べる。
- feature → shared を縛らないのもユーザー判断。shared は feature をまたぐ道具で、層の向きの規則は feature の中で守れば足りる。
- マイグレーションを `drizzle/migrations/` に分けるのは、`drizzle/` に接続・書き込みのソースも並ぶようになり、生成物とソースを見分けるため。

## 採用しなかった案
- shared も 4 層のままにする: 1 つの関心が層に散り、ユーザーが望む colocation にならない。
- `http/` を `problem/` と `request/` に分ける: 今は 4 ファイルで、分けても探しやすさが変わらない（ユーザーが既定の案を承認）。
- feature の層ごとに shared の単位の許可を決める（最初の提案）: ユーザー判断で縛らないことにした。

## 影響
- 良い点: 変更履歴・HTTP の応答・Drizzle などの関心ごとにファイルが 1 か所に並ぶ。feature から shared を使うときに規則を気にしない。
- 悪い点: feature の domain・application から shared の `drizzle/` などを経由して DB に触れる参照は機械では止まらない（パッケージの直接 import だけを止める）。
- 見直す条件: shared の単位を足すとき（置き場所の規則の一覧と、この ADR の単位の一覧を見直す）。shared 経由で domain・application が DB に触れるコードが入ったとき。

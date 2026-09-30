# presentation の入力検証は domain の規則を重ねてよい（presentation ⊆ domain）。domain は常に完全で、presentation は domain より厳しくしない

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #144 / `.claude/rules/backend.md` / `.claude/rules/frontend.md` / `apps/backend/shared/domain/keyed-issue.ts` / `apps/backend/shared/presentation/json-body.ts` / `rule-tests/architecture.test.ts`（規則 `presentation` の定数の緩和）

## 背景
architecture/20260929-zod-for-backend-validation.md で「presentation は形（JSON / オブジェクト / 未知の項目 / 型）、domain は値の規則（必須・長さ）」と役割を分けていた。どちらの違反も `toProblemResponse` で同じ 400 の Problem Details になるが、`errors[]`（項目ごとの pointer 付きの一覧。architecture/20260929-error-response-rfc9457.md）に載るのは presentation の zod が見つけた形の違反だけで、domain は最初の違反で throw するため、必須・長さの誤りは項目に結び付かない 1 件の key になっていた。画面はフォームの項目ごとにエラーを出したい（ユーザー判断 2026-09-30「項目ごとに基本返したいから、全部やるでよい」。2026-09-30 の work-logs「質問への回答: presentation の検証と domain の検証は重なってよいか」「そもそも presentation の検証は要るか」）。

## 決定
- domain は常に完全: presentation が何を検査しても、domain 単体で全不変条件を守る（architecture/20260929-todo-invariants-always-validated.md はそのまま）。
- presentation は形の検査を必ず持つ（HTTP 境界の責務。未知の項目は command の引数に無く domain に届かない）。そのうえで、domain と同じ規則（必須・長さ）を同じ ErrorKey・同じ定数で重ねてよい。zod の issue に key と params を付ける `keyedIssue` / `keyedRefine` は `apps/backend/shared/domain/keyed-issue.ts` に置き、domain と presentation の両方が使う。`json-body.ts` の `toProblemError` は key 付きの issue をそのまま `errors[]` に載せる。
- presentation は domain より厳しくしない（domain が通す値を presentation で落とさない）。数値の上限などは domain の定数（`TODO_TITLE_MAX_LENGTH`）を presentation が参照し、2 か所に書かない。規則 `presentation` は自 feature の domain からの値の import を UPPER_SNAKE_CASE の定数に限って許す。
- 画面は `errors[]` の pointer（`#/title`）を入力に結び付けて表示し、項目に結び付いた誤りはフォーム全体の文言と重ねて出さない。

## 理由
- 項目ごとの `errors[]` は zod の全 issue を一度に集められる presentation でしか作れない。domain は「最初の違反で throw」のままにして完全コンストラクタを保つ。
- 2 か所に同じ規則を書いても、domain の定数を参照し、presentation を domain より厳しくしなければ、ずれは「presentation が緩い」方向にしか起きず、その場合も domain が止める。
- presentation の形の検査を無くすことはできない（JSON として読めるか・未知の項目は domain では判定できない。`CreateTodoRequest` などの型もこのスキーマから導く）。

## 採用しなかった案
- presentation は形だけのまま（architecture/20260929-zod-for-backend-validation.md の役割分担）: 項目ごとの `errors[]` を返せない。
- domain の zod スキーマをそのまま presentation で使う: リクエストの形（未知の項目・optional の項目）と Entity の不変条件は別物で、update の `title?: string` のような形を domain のスキーマで表せない。
- presentation の値の規則を `request.field.tooLong` のような別の key にする: 同じ違反が層によって別の key になり、画面の辞書が 2 倍になる。
- 定数の共有のために domain からの値の import を全面的に許す: presentation が domain のロジックを直接呼べるようになり、application を飛ばす経路が開く。定数（UPPER_SNAKE_CASE）に限る。

## 影響
- 良い点: `POST /api/todos` に空タイトルや 101 文字を送ると `errors[0].pointer = "#/title"` と `todo.title.empty` / `todo.title.tooLong{max}` が返り、画面が入力の直下に出せる。複数の誤り（型違い + 未知の項目）も 1 回の応答にまとまる。
- 悪い点: 必須・長さの規則が create / update の api ファイルと domain の 3 か所に書かれる（定数は 1 か所）。規則を変えるときは 3 か所を直す（domain のテストと api のテストがそれぞれ固定する）。規則 `presentation` の定数の緩和は名前（UPPER_SNAKE_CASE）だけで見るので、大文字の名前で関数を export すれば通る（限界。`.claude/rules/architecture-check.md`）。
- 見直す条件: presentation の規則が domain より厳しくなっていることに気づいたとき（api のテストの「domain が通す境界値は presentation も通す」が落ちる）。

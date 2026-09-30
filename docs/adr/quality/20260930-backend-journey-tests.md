# backend に、実 Postgres で複数の API を業務の流れの順に呼ぶジャーニーテストを足し、単体・ジャーニー・E2E の 3 段にする

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #187 / `.claude/rules/testing.md`（「ジャーニーテスト」） / `.claude/rules/backend.md`（「置き場所」） / `rule-tests/journey.test.ts` / `rule-tests/test-doubles.test.ts`（`db-tests-in-infra-only`） / `apps/backend/journeys/todo-lifecycle.journey.test.ts`

## 背景
backend のテストは層ごとの単体テストで、application と presentation は InMemory の Repository で組み立てる（Issue #123）。実 Postgres を使うのは infra の Repository のテストだけ（`db-tests-in-infra-only`。ユーザー判断 2026-09-30）。そのため「Postgres の Repository を通したとき、作った Todo が一覧・詳細・改名・削除の API で同じものとして扱われるか」は、画面とビルドを通す E2E（Playwright）でしか確かめていなかった。ユーザー指示（Issue #187）: 「Backend ジャーニーテストという存在を作る。複数 API の presentation を連続で実際の業務ユースケースに沿って実行する。リアル DB」。

## 決定
- テストを 3 段にする。
  - 単体（層ごと・InMemory）: 分岐・入力の誤り・失敗の経路を網羅する。infra の Postgres の実装だけ実 Postgres。
  - ジャーニー（`apps/backend/journeys/<ユースケース>.journey.test.ts`）: 実 Postgres（`createTestDatabase()` のテスト用スキーマ）の db で、本番の api ファイルと同じ組み立て（Postgres の Repository → command / query → `XxxApi`）の handler を、業務の流れの順に `new Request()` で呼ぶ。1 ファイル = 1 業務ユースケース、1 テスト = 1 つの流れ。確かめるのは応答（status と本文）だけで、SQL で DB を覗かない。テストダブル（`vi.mock`・InMemory）は使わない。
  - E2E（`apps/e2e/`）: 画面・本番ビルド・ルーティングを通した利用者の操作。
- 置き場所と形は `rule-tests/journey.test.ts` で止める（`journeys/` の直下は `*.journey.test.ts` だけ・InMemory と `vi.mock` の禁止・異なる api を 2 つ以上・`test-support/database` の import）。`db-tests-in-infra-only` にジャーニーの例外を足す。
- 実行は `pnpm test:journey`。`pnpm test`（カバレッジ込み）と Stryker にも含まれる。
- 補足（同日）: 「確かめるのは応答だけで、SQL で DB を覗かない」をユーザー判断で改め、変更系の API（POST / PUT / PATCH / DELETE）の後は応答に加えて DB の行も `db.select()` で読み、期待の行全体と比べる（GET の後は不要）。WHY: 応答が正しくても永続化がずれる誤り（差分 UPDATE の漏れ・`where` の欠落・削除の取り違え）は、次の API の応答だけでは見逃しうる。
- 補足（同日）: テストダブルの禁止は `vi.mock` の呼び出しではなく `vitest` から `vi` を import しないことで止める（`vi.spyOn`・`vi.useFakeTimers` などが通ったため。reviewer の指摘）。変更系の見分けのため handler の名前を HTTP メソッドで始める。検査は `rule-tests/journey.test.ts`（規則と限界は `.claude/rules/testing.md` の「ジャーニーテスト」）。

## 理由
- 単体テストは層を InMemory でつなぐので、Postgres の Repository と API の組み合わせ（行と Entity の変換・並び順・変わった列だけの更新・無い id の 404）が流れの中で正しいかは見ない。E2E は本番ビルドとブラウザを起動するので遅く、失敗したときに画面・API・DB のどこが原因かを切り分けにくい。ジャーニーは画面を通さずに API の流れだけを実 DB で見るので、その間を速く埋められる。
- 本番と同じ組み立てにし、テストダブルを使わないのは、つながりを確かめるのが目的だから。差し替えた部分のつながりは確かめられない。
- 形を文書だけにすると、InMemory で組んだり api を 1 つだけ呼んだりして単体テストと同じものになる。機械で止める（CLAUDE.md の原則 7）。

## 採用しなかった案
- 本番の `export const GET` / `POST` などをそのまま呼ぶ: `getDatabase()` の DB（`.env` の `DATABASE_URL` の public スキーマ）に固定され、テストファイルごとの別スキーマに向けられない。並列の実行・Stryker・`pnpm dev`・E2E の表と干渉する。
- `apps/backend/features/<f>/journeys/` に置く: 業務の流れは feature をまたぐことがあり、feature の下には置けない。置き場所が feature の数だけ増え、`db-tests-in-infra-only` の例外も広がる。
- presentation の単体テストを実 Postgres にする: 層ごとの網羅と実 DB の流れが 1 つのテストに混ざり、遅くなる。単体を InMemory にした判断（Issue #123）を崩す。
- E2E だけで流れを確かめる（今のまま）: 上の理由のとおり遅く、原因の切り分けが難しい。

## 影響
- 良い点: Postgres の Repository を通した API の流れの誤りを、E2E より前に速く見つけられる。ジャーニーは Stryker でも変異を殺すテストに数えられる。
- 悪い点: 実 Postgres を使うテストが増え、`pnpm test` と Stryker の時間が延びる（どれだけ延びるかは未計測）。時計を差し替えないので、作成順のような時刻に依存する流れは実時計が進むのを待って作る。
- 見直す条件: ジャーニーが増えて準備（`createTestDatabase`・組み立て）が重なったら `apps/backend/test-support/` に補助を切り出す。feature が増えて流れが feature をまたぐようになったら、ファイルの分け方（ユースケースの単位）を決め直す。

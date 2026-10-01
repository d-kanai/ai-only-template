# API 1 つごとの仕様を Gherkin の .feature に業務の言葉で書き、実 DB で本番の組み立てを通して確かめる（API 仕様。apps/backend/api-specs/）

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #219 / `.claude/rules/testing.md`（「API 仕様テスト（api-specs）」） / `rule-tests/api-spec.test.ts` / `rule-tests/feature-business-language.ts` / `rule-tests/test-doubles.test.ts`（`db-tests-in-infra-only`） / `rule-tests/architecture.test.ts`（`backend-placement`） / quality/20260930-gherkin-journeys-with-vitest-cucumber.md

## 背景
コードは AI が書く前提で、人が読むのは自然言語の仕様だけにしていきたい。その仕様を API 仕様（API 1 つ）・画面仕様（画面 1 つ）・API ジャーニー（業務の流れ）・E2E（画面込み）の 4 つにする（ユーザー判断、2026-09-30 の work-logs）。API ジャーニー（quality/20260930-gherkin-journeys-with-vitest-cucumber.md）は複数の API をまたぐ流れを書く場所で、API 1 つの振る舞い（応答の形・並び順・絞り込み・記録・失敗）を網羅して読める場所が無かった。API 1 つの振る舞いは presentation の単体テスト（InMemory の Repository で組み立てる TypeScript）にしか無く、人が読む仕様になっていない。

## 決定
- API 1 つ（`apps/backend/features/<feature>/internal/presentation/<api>.api.ts`）ごとに、仕様を `apps/backend/api-specs/<feature>/<api>.feature` に、step の実装を同じ場所の `<api>.api-spec.test.ts` に置く。step が共有する補助は同じ場所の `support.ts` だけ。api ファイルごとに両方を必須にする。
- `.feature` は `Feature:` の下に固定の見出しの `Scenario:` を並べる。見出しは `レスポンス` / `ソート` / `検索` / `記録` / `副作用` / `異常系`（読み取りはレスポンス / ソート / 検索 / 異常系、書き込みはレスポンス / 記録 / 副作用 / 異常系。該当の無い見出しは省く）。`Scenario Outline` / `Rule` / `Background` / `Example` は使わない。
- step は `*` だけにし、`*` の 1 行 = 1 つの振る舞い = 1 つのテストにする。Given / When / Then は step の実装の中で完結させる。
- `.feature` の言葉は API ジャーニーと同じ禁止語の一覧（`rule-tests/feature-business-language.ts`）で業務の言葉に限る（固定の見出しの行は除く）。
- step の実装は実 Postgres（`apps/backend/test-support/database`）で、本番の組み立て（api ファイルの Api のクラス）を通して API を呼び、応答と DB の行を確かめる。テストダブル（`vi`）と InMemory の Repository は使わない。組み立ては同じディレクトリの `support.ts` に共有してよく、step のファイルは対の api を import で参照し（型だけでもよい）、`support.ts` が自 feature の api を値で import する。
- step の実装は対の `.feature` を `loadFeature("./<api>.feature")`（第 2 引数なし）でだけ読み、言語・タグの設定（`setVitestCucumberConfiguration`・`loadFeature` の第 2 引数）、`.feature` の `@` のタグ、`Scenario.skip` / `.only` を使わない。WHY: vitest-cucumber 8.0.0 では言語の設定で別の言語のキーワード（`機能:` / `シナリオ:` / `前提`）が通って形の検査をすり抜け、タグと skip は Scenario を skipped にしたまま成功で終わる（Issue #219 の reviewer の実測）。
- presentation の単体テスト（InMemory）は残す。
- 置き場所・対・見出し・step・禁止語・step の実装の import は `rule-tests/api-spec.test.ts` で止める（規則の本文は `.claude/rules/testing.md`）。

## 理由
- 人が読む仕様を API ごとに同じ形・同じ観点の見出しでそろえると、どの API でも同じ場所を拾い読みでき、観点の抜けも見出しで分かる。形を検査で固定すれば、AI が書いても形が崩れない。
- `*` の 1 行を 1 つの振る舞いにすると、仕様の読み手には振る舞いの一覧だけが見え、手順は実装に閉じる。vitest-cucumber は step 1 つを Vitest の test 1 つにするので（quality/20260930-gherkin-journeys-with-vitest-cucumber.md）、`*` の 1 行が 1 つのテストの結果として見える。
- 実 DB で本番の組み立てを通すと、InMemory では確かめられない永続化（変更の記録・行の形）まで仕様として確かめられる。仕様が本番と違う部品で成り立つと、仕様が通っても本番が壊れうる。
- 禁止語の一覧を API ジャーニーと共有し、2 つの `.feature` の言葉の規則がずれないようにする。一覧はテストでないモジュール（`rule-tests/feature-business-language.ts`）に置く（テストファイルから export すると、import した側で元のテストがもう一度登録されて実行され、Biome の `lint/suspicious/noExportsInTest` にも当たる。Issue #219 で実測）。

## 採用しなかった案
- presentation の単体テストを `.feature` の API 仕様で置き換える: 単体テストは実装の検証（分岐の網羅）と mutation を殺す担い手で、InMemory で速く回る。仕様が単体テストの検証を十分に覆ったら単体テストを減らす判断を後で行える（逆は難しい）。同じ振る舞いを 2 か所で確かめる重複は、役割（実装の検証 / 人が読む契約）が違うので許す。
- `.feature` を presentation の api ファイルの隣（`internal/presentation/<api>.feature`）に置く: 人が読む仕様を feature ごとに 1 か所で一覧できず、実 DB の import の例外（`db-tests-in-infra-only`）を presentation に広げることになる。
- step に Given / When / Then を使う: 振る舞い 1 つを複数の step（複数のテスト）に分け、step が前の step に依存する。読み手に手順が見え、Stryker が変異を通る test だけに絞ると前提の step が飛ばされうる（API ジャーニーを Stryker から外した理由）。

## 影響
- 良い点: API ごとの振る舞いを業務の言葉の一覧で読める。API を足したのに仕様が無い・消した API の仕様が残るのを検査で止める。永続化まで実 DB で確かめる。
- 悪い点: 同じ振る舞いを単体テストと API 仕様の 2 か所に書く（組み立て・DB の読み出しは `support.ts` に寄せて重複を薄くする）。実 DB のテストが API の数だけ増え、`pnpm test` が長くなる。
- Stryker: `vitest.stryker.config.mts` が除くのは API ジャーニーだけなので、API 仕様は Stryker の実行に含まれる。step が自己完結していれば変異を殺すテストに数えられる見込みだが、実測は別途（未確認）。
- 見直す条件: API 仕様が単体テストの検証を十分に覆ったら、単体テストを減らす。Stryker の実測で API 仕様が変異を誤って killed と数えるなら、API ジャーニーと同じく Stryker から外す。見出しの一覧に無い観点が要るようになったら、一覧（`rule-tests/api-spec.test.ts` の `SCENARIO_HEADINGS`）と `.claude/rules/testing.md` を同時に直す。

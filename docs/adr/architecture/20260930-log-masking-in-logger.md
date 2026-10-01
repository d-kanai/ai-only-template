# 個人情報のマスクは logger の中で 3 段構え（種類ごとの zod スキーマ・sensitive の印と列の分類表・自由文の正規表現）で行い、口は logger.emit の 1 つにする

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #216 / `.claude/rules/backend.md` / `.claude/rules/shared.md` / `.claude/rules/frontend.md` / `.claude/rules/dependencies.md` / `.claude/rules/testing.md` / `apps/shared/log-event.ts` / `apps/shared/logger.ts` / `apps/frontend_customer/shared/request-log/request-log.ts` / `apps/backend/shared/infra/writer.ts` / `rule-tests/schema.test.ts` / `rule-tests/architecture.test.ts` / ADR `architecture/20260930-log-format-cloud-logging-otel.md` / ADR `architecture/20260929-logger-single-exit.md` / ADR `architecture/20260929-apps-shared-package.md`

## 背景
ログの 1 行の形（ADR `architecture/20260930-log-format-cloud-logging-otel.md`）は `message` と `event.name` だけを型で縛り、種類ごとの項目は `[key: string]: unknown` で自由だった（形は呼び出し側のテストが固定するだけ）。個人情報のマスクは無く、「値を出さない」方針で避けていた（リクエストのクエリはキーだけ、`db_write` の `changes` は表・id・操作だけ、DB のエラーは `{ type }` だけ）。
ユーザーの判断（2026-09-30 の work-logs「ユーザーの要望「個人情報は logger でマスクし…」」「ユーザー判断: マスクは全部 `***`…」）: 必ず logger を使い、logger を通ったものは必ずマスクされる形にして、リクエストのパラメータや change_logs の before / after など今は出していない値もできるだけ出す。マスクは全部 `***`。対象は明示の一覧でよいが、正規表現などの検出の組み合わせはベストプラクティスに従う。種類ごとの形は zod のスキーマで縛る。

## 決定
- マスクは logger（`apps/shared/logger.ts`）の中で行う（DB の行の値だけは、表を知っている書き込みの口 Writer が分類表で行う）。呼び出し側は生の値を渡すだけで、マスクの判断をしない。3 段構え:
  1. 種類ごとの zod スキーマ（allowlist）: `apps/shared/log-event.ts` の `LOG_EVENT_SCHEMAS`（`event.name` の 8 種類ごとに `z.object`）。logger は `event.name` でスキーマを選んで `safeParse` し、その結果だけを出す。一覧に無いキーは落ちる（fail closed）。parse に失敗したら生の event は出さず、固定の項目だけの `logger_error` の 1 行にする。
  2. 印: `sensitive(schema)`（`transform` で値を常に `***`。`url.query` の値・`referer`・`client.address` など）と、DB の列の分類表（各 `schema.ts` で表の隣に `<表名>Columns = classifyColumns(<表>, { ... })`。列ごとに `"public"` / `"sensitive"`。全列の網羅を型で強制し、`rule-tests/schema.test.ts` の規則 `column-classification` が分類表の無い表を止める）。`db_write` の `changes` の before / after は、書き込みの唯一の口 Writer がこの表で public でない列の値を `***` にしてから logger に渡す（表が無い・列が表に無いときも `***` に倒す。`apps/shared` の logger は DB の表を参照できないので、表を知っている Writer が行う）。DB のエラーの `params` は sensitive（値を `***`）として出す。
  3. 自由文の正規表現（最後の網）: `freeText()` の印を付けた項目（`message`・`url.path`・`error.message` など）だけに、メール・JWT・Bearer・Luhn に合う 13〜19 桁の番号を `***` にする線形の正規表現をかける（入れ子の量指定子を使わない。長さの上限で切る）。
- 口は `logger.emit(event)` の 1 つにし、`logger.info / warn / error` は廃止する。重大度は種類（と `event.phase`）が決める（`severityOf`）。`LogEvent` は種類ごとのスキーマの入力の型の union（`event.name` で判別）で、種類ごとの必須項目が無い・一覧に無い名前の呼び出しは型チェックで落ちる。
- `change_logs` の表には生の値を残す（監査の用途）。マスクするのはログに出すときだけ。
- `apps/shared` に依存 `zod` だけを許す（`rule-tests/architecture.test.ts` の `SHARED_ALLOWED_PACKAGES`。版は backend と同じ）。
- 置き換える決定: ADR `architecture/20260930-log-format-cloud-logging-otel.md` の「値を出さない」部分（`url.query_keys`、`db_write` の `changes` に値を出さないこと）・`severity` を呼び出しのメソッド（info / warn / error）で決めること・「依存は足さない」。行の先頭の並び・Cloud Logging の特別フィールド・OTel semconv の入れ子の名前・`event.name` の固定の一覧は引き継ぐ（キーの一覧は、`url.query_keys` が `url.query` に変わった以外はその ADR の表のまま）。ADR `architecture/20260929-logger-single-exit.md` の「`logger.info / warn / error` を通す」も `logger.emit` に置き換える（logger を唯一の出口にする決定そのものは変えないので、その ADR は「採用」のまま）。

## 理由
- allowlist（既定で出さない）が推奨: OWASP Logging Cheat Sheet は法的な根拠の無いデータを記録せず、機微な PII・トークン・パスワードは removed / masked / hashed にするとしている（https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html ）。OTel Collector の redaction processor も `allowed_keys` の allowlist で、空なら全部消す fail closed（https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/processor/redactionprocessor ）。denylist は項目を足したときに漏れる。zod の `z.object` は一覧に無いキーを既定で落とすので、スキーマがそのまま allowlist になる（2026-09-30 の work-logs「ログのマスクのベストプラクティス」の実測）。
- 正規表現を主にしない: 値の正規表現はパス指定より高くつく（logstash-logback-encoder の公式の注意、OTel の redaction processor も同じ）。自由文の住所・氏名は見逃し、電話番号は日付・id・件数と誤検知し、入れ子の量指定子は ReDoS になる（同日の work-logs の実測）。そこで値を出すかの主な判断はスキーマと印で行い、正規表現は形の決まらない自由文にだけ、線形のパターンでかける。
- 印を `transform` にする: zod の `.meta()` の印は `.optional()` などで包むと外側に引き継がれず logger から見えなくなる（同日の work-logs）。`transform` なら、どう包んでも parse の結果が必ず `***` になる。
- 列の分類表を Drizzle の列に付けない: Drizzle 0.45.3 に列へ任意のメタデータを持たせる公式の手段が無い（drizzle-orm の issue #886 が Open。同日の work-logs）。分類を `keyof $inferSelect` の全キーを要求する型で書かせれば、列を足して分類し忘れると型エラーになる。
- 口を 1 つにする: 呼び出し側が重大度を選べると、同じ種類の行が呼び出し側ごとに違う重大度になり、重大度で絞ったアラートが一部の行を拾わない。種類の登録が 1 か所（`LOG_EVENT_SCHEMAS`）なら、種類を足すときの変更も 1 か所で済む。
- マスクを `***` にする（ハッシュにしない）: 突き合わせの用途が今は無く、仮名化（ハッシュ）したデータも GDPR 上は個人データのまま（https://gdpr-info.eu/art-4-gdpr/ 、Recital 26）。
- 性能: zod の parse + stringify の 1 行あたりの時間は、素の stringify との差が要求の処理に比べて小さい（同日の work-logs の実測）。

## 採用しなかった案
- pino（`redact`）/ `@pinojs/redact` を入れる: 依存が増え、マスクするパスの指定が zod のスキーマと二重管理になる。
- 正規表現を主にする（全項目に検出をかける）: 見逃し・誤検知・ReDoS・費用（上の理由）。
- Cloud DLP（Sensitive Data Protection）でログ基盤の側でマスクする: GB あたりの課金と、Log Router → Pub/Sub → Dataflow の構築が要り、生のログが一度アプリの外に出る。多層防御の将来の選択肢として残す。
- 種類ごとにメソッドを置く（`logger.dbWrite(...)` など）: 登録 1 か所の union の方が、種類を足すときの変更が少ない。
- マスクをハッシュ / HMAC にする: 突き合わせが要るようになったら `sensitive()` の置換を差し替える。仮名化しても個人データのまま。

## 影響
- 良い点: 呼び出し側がマスクを忘れても、スキーマに無い項目は出ず、sensitive の項目は `***` になる。リクエストのクエリ（値は `***`）、`db_write` の `changes` の before / after（分類表で public の列だけ値）、DB のエラーの `params`（値は `***`）を出せるようになる。種類ごとの形の違反は型チェックと実行時（`logger_error`）の両方で止まる。
- 悪い点・制約:
  - `LogEvent` は `z.input` の union にする（`z.infer` = 出力の型だと sensitive の項目が `"***"` 型になり、生の値を渡せない）。
  - `http.request.id` と `server.address` には `freeText` をかけない（E2E の `e2e-<Date.now()>` の 13 桁が Luhn に合うことがあり、id が `***` になって E2E が不安定になる）。
  - 電話番号は正規表現に入れない（誤検知が多い）。自由文の電話番号・住所・氏名は見逃す。
  - `client.address`（接続元の IP）は sensitive（GDPR の online identifier。fail closed に倒す）。IP で絞る調査はログではできない。
  - Error でない値の throw は `{ type: typeof 値 }` にする（中身が分からず利用者の入力を含みうるので値を出さない）。
  - `LOG_EVENT_SCHEMAS` は最上位の値なので Stryker の static な変異になり、ignoreStatic で検査から外れる。項目と印は `logger.test.ts` の種類ごとの行の丸ごとの比較（番兵の値を含む）で固定する。
  - `null` はそのまま出す（値が無いことは個人情報ではない）。
- 見直す条件: 突き合わせのためにハッシュが要るとき、自由文の見逃しが問題になったとき（Cloud DLP を重ねる）、リクエストの本文（JSON）をログに出すとき（別 Issue）、ログの量・費用が問題になったとき。

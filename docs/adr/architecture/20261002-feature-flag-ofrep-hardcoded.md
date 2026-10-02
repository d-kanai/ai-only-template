# フィーチャーフラグは backend の 1 feature とし、一覧をコードにハードコードして boolean だけを OFREP の形で返す

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #156 / Issue #127 / `apps/backend/features/feature-flag/` / `apps/backend/shared/http/ofrep.ts` / ADR `architecture/20260929-error-response-rfc9457.md`（エラー応答を Problem Details にする決定。OFREP の 2 本だけをこの ADR で例外にする）

## 背景
機能を出す前にフラグで隠し、問題があれば戻す仕組み（フィーチャーフラグ）が無かった（Issue #127 で方式を検討中のまま）。
ユーザーの判断（2026-09-30、Issue #156）は「backend の 1 feature として持ち、その API を frontend から叩く。OpenFeature 準拠。管理はハードコード（DB なし）、値は on / off（boolean）だけ」、コメントで「規格準拠しておいてね」。
OpenFeature の画面側の SDK（`@openfeature/ofrep-web-provider`）は、OFREP（OpenFeature Remote Evaluation Protocol。https://github.com/open-feature/protocol の `service/openapi.yaml`、info.version 0.4.0）を話すサーバからフラグを読む。

## 決定
- backend に feature `features/feature-flag/` を置く。domain はフラグの一覧（`FEATURE_FLAGS`。key → boolean）と評価（`FeatureFlags.evaluate(key, context)`。無い key は `DomainError("not_found", "featureFlag.notFound", { key })`）、application は 1 件と一括の query、presentation は OFREP の 2 本の API。infra（Repository）は持たない。
- API は OFREP の Core の 2 本（`POST /api/ofrep/v1/evaluate/flags/{key}` と `POST /api/ofrep/v1/evaluate/flags`）を、仕様の形のまま自前で返す（backend に npm の依存を足さない）。評価の reason は `STATIC`、一括の評価は評価の結果のハッシュを ETag にして `If-None-Match` が一致すれば 304。
- 失敗の応答は Problem Details ではなく OFREP の `{ key?, errorCode, errorDetails }`（400 `PARSE_ERROR` / `INVALID_CONTEXT`、404 `FLAG_NOT_FOUND`、500 `GENERAL`）にする。この 2 本だけの例外で、handle は `ProblemResponse.wrap` ではなく `OfrepResponse.wrap`（`shared/http/ofrep.ts`）で包む。
- 要求の本文も Problem Details の API と読み方を変える: `RequestBody.parse` ではなく `OfrepRequest.parse`（誤りを OFREP の 400 にする）で読み、本文は `z.object`（未知の項目を捨てる）、context は `z.looseObject`（属性は任意の項目）にする（`z.strictObject` にしない）。WHY: OFREP の openapi.yaml は本文・context の additionalProperties を閉じておらず、相手は同時に変えられない外の provider なので、知らない項目で 400 にすると provider の版が上がっただけで評価が失敗する。
- 評価の文脈（context）は今は値を変えないが、`evaluate(key, context)` の形で受け取って渡す。本文の `context` は無くてもよい。
- 規則の例外は機械で場所を限る: `rule-tests/architecture.test.ts` の `presentation-with-problem-response`（`OfrepResponse.wrap` は feature-flag の presentation だけ）、`rule-tests/api-spec.test.ts` の `api-spec-uses-real-database`（DB を持たない feature の一覧 `FEATURES_WITHOUT_DATABASE`）、`apps/backend/shared/http/route-handlers-share-database.test.ts`（Repository を持たない feature の api を数えない）。

## 理由
- ユーザー判断（Issue #156）: backend の feature・ハードコード・boolean・OpenFeature 準拠。
- ハードコードなら、フラグの追加・切り替えがコードの変更と同じ PR でレビューでき、環境ごとの値のずれも起きない。一覧は query がコンストラクタで受け取るので、DB に移すときは Repository を足すだけで評価の規則は変わらない。
- OFREP の形にすれば、画面は OpenFeature の公式の provider をそのまま使え、将来フラグの管理を外のサービス（flagd・ベンダーの製品）に移しても、画面の側は provider の向き先を変えるだけで済む。
- Problem Details にしない理由: `@openfeature/ofrep-core` 2.3.0（`@openfeature/ofrep-web-provider` 0.4.3 の依存）は、失敗の本文の `errorCode` を読んで OpenFeature のエラーに変え、本文に `key` と `errorCode` が無い 1 件の評価の 400 / 404 / 500 を「形の違う応答」として扱う（npm の tarball の `index.esm.js` の `isEvaluationFailureResponse`。2026-10-02 の work-logs）。

## 採用しなかった案
- flagd（OpenFeature のフラグのサーバ）を別のサービスとして立てる: プロセス・デプロイ・設定ファイルが増える。今のフラグは on / off の数個で、ハードコードで足りる。
- DB の表にフラグを持つ: 実行時に切り替えられるが、管理画面とマイグレーションが要り、今は切り替えの運用が無い。Repository を足せば後から移せる。
- frontend 側にハードコードする: サーバ側（Route Handler・ほかの API）から同じ値を見られず、OpenFeature の provider の形にもならない。
- 環境変数 `FEATURE_*`（Issue #127 の最小案）: 再デプロイで切り替えられるが、環境ごとに値がずれうり、画面に渡すには `NEXT_PUBLIC_*` か Provider の受け渡しが要る。OpenFeature の provider の形にもならない。
- 失敗の応答も Problem Details にそろえる: OFREP の provider が `errorCode` を読めず、フラグが無い・文脈が誤りのときの扱い（既定値と理由）が OpenFeature の仕様どおりにならない。

## 影響
- 良い点: 画面は OpenFeature の標準の SDK でフラグを読める。フラグの key は `FeatureFlagKey` の型で閉じた集合になり、打ち間違いは型エラーになる。一覧の変更はレビューで見える。
- 悪い点: フラグの切り替えにはデプロイが要る。エラー応答の形が API によって 2 種類（Problem Details と OFREP）になる（OFREP の 2 本だけ）。OFREP の仕様の版が上がったら追従が要る（今は info.version 0.4.0。`variant`・`metadata`・`eventStreams` は返さない）。
- 見直す条件: 本番で再デプロイせずに切り替えたくなったとき（DB か外のサービスへ）、利用者の属性で出し分けるとき（ログインが入ったら、属性はクライアントの context ではなく backend が認証情報から決める。クライアントの context は偽れる）、OFREP の仕様が非互換に変わったとき。

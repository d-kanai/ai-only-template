# API のエラー応答は RFC 9457（Problem Details）の形にし、key と params を拡張メンバーに、開発者向けの英語を detail に入れる

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #126 / `.claude/rules/backend.md` / `.claude/rules/frontend.md` / `apps/backend/shared/presentation/problem.ts` / `apps/backend/shared/presentation/problem-detail.en.ts` / `apps/frontend/features/todo/api/todo-api.ts`

## 背景
エラー応答は独自の形 `{ error: { code, key, params?, issues? } }` で、文言を一切返さなかった（Issue #116。画面が key と params を辞書で翻訳する）。世の中の API の管理のしかたを調べると、コード + 開発者向けの英語の message（翻訳しない）が大手 API で最多で、HTTP API のエラー本文には標準（RFC 9457）がある（2026-09-29 の work-logs「調査結果: backend のエラーメッセージの翻訳を世の中はどう管理しているか」）。curl やログで API を読む開発者には、キーだけでは何が起きたかが読みにくい。

## 決定
- エラー応答は RFC 9457 の Problem Details にする（`Content-Type: application/problem+json`）。今までの形は前提にしない（ユーザー判断）。
- 標準のメンバー: `type`（`/problems/validation-error` / `not-found` / `internal-error`。相対参照）、`title`（種類ごとに固定の英語）、`status`、`detail`（この発生に固有の英語）、`instance`（リクエストのパス）。
- 拡張メンバー: `key`（辞書のキー。画面の翻訳と分岐に使う）、`params`、`errors[]`（形の誤りのときだけ。`pointer` は JSON Pointer（RFC 6901）、各要素に `key` / `params` / `detail`）。
- `detail` は翻訳しない開発者向けの英語で、契約に含めない（画面は読まない）。文は `problem-detail.en.ts` の 1 か所に `ErrorKey` ごとに書き、型で網羅する。
- ADR `architecture/20260929-i18n-without-library.md` の設計 (a)（API は画面の文言を返さず、画面が key と params を翻訳する）は変えない。ここで補足するのは「backend は日本語（画面の文言）を持たない。英語の開発者向けの detail は持つ」こと。

## 理由
- 主要なフレームワークが RFC 9457（とその前身 RFC 7807）を実装している: Spring の `ProblemDetail`（RFC 9457 を明記）、ASP.NET Core の `ProblemDetails`、Zalando の API ガイドライン（problem+json が MUST）（ユーザー判断の根拠。確認は 2026-09-29 の work-logs）。標準の形なら、汎用のクライアント・ツールが形を個別に知らずに読める。
- RFC 9457: https://www.rfc-editor.org/rfc/rfc9457.html 。`type` は問題の種類の URI 参照（3.1.1 節。相対参照も可で、そのときは完全なパスを含めることが推奨されるので `/problems/...` にした。絶対 URI の推奨は、環境ごとにドメインが変わるので採らなかった）。`about:blank` は HTTP ステータス以外に意味が無いことを表す（4.2.1 節）ので、種類で分岐できるよう使わない。未知の拡張メンバーはクライアントが無視する（3.2 節）ので、`key` / `params` / `errors` を足しても標準のクライアントを壊さない。`errors` と `pointer` の形は RFC の例（3 節）に合わせた。
- key を残す: `type` は大分類で、画面の文言は細かいキー（`todo.title.tooLong`）と params で決まる。画面の辞書と backend の `ErrorKey` の型の突き合わせ（Issue #116）をそのまま使える。
- 英語の detail を 1 か所に置く: 大手 API の多く（Google AIP-193、Microsoft Graph、Stripe など）と同じく、開発者向けの message は英語で翻訳しない（2026-09-29 の work-logs の調査結果）。`Record` の型でキーの追加に追従させ、ほかの場所に英語の文言を散らさない。

## 採用しなかった案
- 今の独自形式（`{ error: { code, key, params, issues } }`）に `message` を足すだけ: 標準の形ではなく、クライアントやツールが形を個別に知る必要が残る。
- C2（サーバが Accept-Language で翻訳した `detail` を返す。Spring の `MessageSource` など）: backend に ja / en の辞書を持つことになり、画面の辞書と二重管理になる。API の契約が言語に依存する。
- Google AIP-193 の形（`error.details[]` の `ErrorInfo` / `BadRequest`）: `details[]` の `@type` は protobuf の `google.protobuf.Any` を JSON に直すための仕組みで、protobuf を使わないこのリポジトリには不要。
- `type` に `about:blank` を使う: 種類で分岐できない。
- `errors[]` の位置を `path`（`.` 区切りの文字列）のままにする: RFC 9457 の例と JSON Pointer の標準から外れる（人が読む `tags.1` は `params.path` に残した）。

## 影響
- 良い点: エラー応答が標準の形になり、curl・ログで何が起きたかを英語で読める。画面の翻訳と分岐（key と params）は変わらない。種類・文の書き忘れはコンパイルで止まる。
- 悪い点: `detail` の英語の文を backend に持つ（キーを足すたびに書く）。`type` の URI の先に文書は置いていない（3.1.1 節: 解決できない URI でもよい）。RFC が推奨する絶対 URI ではない。項目名に記号を使う API を足すと、`pointer` のパーセントエンコード（RFC 6901 の 6 節）が要る（今はしない）。
- 見直す条件: 画面以外のクライアント（外部公開・モバイル）が増えて `type` の文書が要る、利用者向けの文言をサーバが返す要件が出る。

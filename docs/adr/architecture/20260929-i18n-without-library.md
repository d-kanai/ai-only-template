# 画面の i18n はライブラリを使わずに自前の型付き辞書で行い、URL は変えずに Proxy と root layout でロケールを決め、API のエラーは key と params で返す

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #116 / `.claude/rules/frontend.md` / `apps/frontend/shared/i18n/` / `apps/frontend/proxy.ts` / `apps/frontend/app/layout.tsx` / `apps/backend/shared/presentation/http-error.ts`

## 背景
画面の文言とサーバのエラーの文言が日本語で直書きされていた。日本語と英語（ja / en）で表示したい、文言のキーと params はできるだけ型で縛りたい、画面にハードコードの文言が無いことを機械で検査したい（ユーザーの依頼）。日付は画面にまだ出しておらず、サーバのタイムゾーンも決めていなかった。

## 決定
- ライブラリを使わない。辞書は `apps/frontend/shared/i18n/messages/ja.ts`（`as const`。キーと placeholder の正）と `en.ts`（`satisfies Dictionary`）。`t(key, params)` の params の型は ja の文言の `{name}` から template literal 型で導く。
- URL のパスは変えない（`app/[lang]` にしない）。Proxy（`proxy.ts`）が Cookie `NEXT_LOCALE` → Accept-Language（q 値の順）→ 既定の ja でロケールを決め、リクエストヘッダ `x-locale` に載せる。root layout が `headers()` で読み、`<html lang>` と `LocaleProvider`（Client Component の context）に渡す。
- 設計 (a): API は文言を返さず、エラーを安定したキーと params（`ErrorResponse` の `key` / `params`）で返し、画面が辞書で翻訳する。backend の zod は項目の `error` にキーを持たせる（文言を持たせない）。
- 日時は `Intl.DateTimeFormat`（ロケールとブラウザのタイムゾーン）で出す。サーバは UTC で動かす（`TZ=UTC`、起動時に UTC でなければ止める）。

## 理由
- 対応言語は 2 つで、文言は単純な差し込みだけ（複数形・選択の構文が要らない）。Next 16 の公式の例も、ライブラリを使わない自前の辞書（2026-09-29 の work-logs「Issue #116: i18n と日付・タイムゾーンに着手」の researcher の結果）。
- 型: 存在しないキー、params の渡し忘れ・余分・名前の違い、en のキーの過不足をコンパイルエラーにでき、型で表せない en の placeholder の集合は単体テストで検査できる（`messages.test.ts`）。backend の `ErrorKey` が辞書にあることと、params の名前が placeholder と一致することも型で突き合わせる（`features/todo/api/api-error.ts` と `api-error.test.ts`）。
- パスを変えない: 「app はルーティングだけ」「SSR を前提にしない」（`.claude/rules/frontend.md`）と衝突せず、既存の URL・リンク・E2E を変えずに済む。
- (a): 言語や言い回しを変えるたびに API を変えずに済み、API の契約が言語に依存しない（2026-09-29 の work-logs のユーザー判断）。
- zod 4 のエラーの優先順位は、項目の `error` がグローバルの `z.config(z.locales.ja())` より先（2026-09-29 の work-logs の実測）なので、項目の `error` をキーにすれば全体の設定に左右されない。
- 日時: DB は timestamptz（UTC）で、API は ISO 8601 で返す。サーバのローカル時刻に依存させず、表示だけを利用者のタイムゾーンで行う。

## 採用しなかった案
- next-intl: peer に next 16 を持ち型安全だが、ネイティブ依存（@swc/core・@parcel/watcher）が増える。minimumReleaseAge の 5 日で使えるのは 4.14.6 まで（2026-09-29 の work-logs）。
- react-i18next / i18next: 型付けに設定の宣言が要り、2 言語・単純な差し込みには大きい。
- Lingui: Next で使う swc-plugin が experimental。
- paraglide: Next 16 での例が無い。
- `app/[lang]`（Next 公式の方式。Proxy で Accept-Language からリダイレクト）: 全 URL が変わり、`app/` の構成・リンク・E2E を作り直すことになる。対応言語が少なく、URL で言語を分ける要件（検索エンジン向けの言語別ページなど）が無い。
- 設計 (b) API が Accept-Language で翻訳する / (c) 両方: API の契約が言語に依存し、辞書が backend と frontend に分かれる。
- Temporal: Node 24 で未実装、Safari が未対応。
- `z.config(z.locales.ja())`: グローバルな設定で、項目の `error` が優先されるので、項目ごとのキーと両立しない。
- クライアント側で `navigator.language` から決める: prerender は残るが、サーバの HTML は ja で hydration 後に切り替わってちらつき、`<html lang>` も誤る。

## 影響
- 良い点: 文言の追加・変更は辞書だけで済み、キーと params の誤りはコンパイルで止まる。画面のハードコードは `rule-tests/architecture.test.ts` の `frontend-hardcoded-text` で止まる。
- 悪い点: root layout で `headers()` を読むので、全画面が動的レンダリングになり、ビルド時の静的な prerender が無くなる（`next build` の表示が `ƒ`）。Proxy の matcher が除くリクエスト（`next/link` のプリフェッチ）には `x-locale` が付かない（root layout はクライアント遷移で描き直されないので、表示が英語のまま遷移することを E2E で確認した）。
- 見直す条件: 対応言語が増えて複数形・選択の構文が要る、URL で言語を分ける要件が出る、静的な prerender が要る。

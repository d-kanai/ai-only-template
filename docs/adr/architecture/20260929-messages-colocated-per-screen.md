# 画面の文言の辞書は画面・部品ごとに隣の *.messages.ts に置き、共通の辞書は API のエラーだけにし、自前の i18n を 3 ファイルにまとめる

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #125 / `.claude/rules/frontend.md` / `.claude/rules/architecture-check.md` / `apps/frontend/shared/i18n/` / architecture/20260929-i18n-without-library.md

## 背景
Issue #116 で入れた自前の i18n（architecture/20260929-i18n-without-library.md）は、すべての画面の文言を 1 つの辞書（`shared/i18n/messages/ja.ts`・`en.ts`）に置き、仕組みを 5 ファイル（型と置換・hook・Provider・ロケール・日時）に分けていた。`shared/i18n/` が複雑に見える（本体 5 ファイル 238 行とテスト 571 行）、画面の文言はその画面の隣で管理したい、とユーザーが指摘した（2026-09-29 の work-logs「ユーザー指摘: shared/i18n が複雑すぎないか」）。

## 決定
- ライブラリは入れず、自前のまま `shared/i18n/` を `i18n.tsx`（`defineMessages`・`useT(messages)`・`useLocale`・`LocaleProvider`・`formatMessage`・`isMessageKey`・型）、`locale.ts`、`format.ts` の 3 ファイルと共通の辞書 `common.messages.ts` にまとめる。
- 画面・部品の文言は、その隣の `<name>.messages.ts` に `defineMessages({ ja, en })` で置く。キーは画面の中で短く付ける。`useT(messages)` はその辞書のキーだけを受け付ける。
- 共通の辞書に置くのは、API から返る `ErrorKey` の文言と画面側だけのエラー `error.*` だけ。
- `*.messages.ts` を import してよいのは同じディレクトリのファイルだけ（共通の辞書は `apps/frontend/` のどこからでも可）。`rule-tests/architecture.test.ts` の規則 `messages-colocation` で止める。

## 理由
- ユーザー判断（2026-09-29 の work-logs「ユーザー判断: 案 1（自前を 3 ファイルに整理）」と「Issue #125」）。
- 画面を消す・言い回しを変えるときに、画面のディレクトリだけで完結する（`screens/<name>-screen/` を 1 画面 = 1 ディレクトリにした方針と同じ）。
- 型: `defineMessages` が ja を正にし、en のキーの過不足と placeholder の名前の集合の違いを型で止める（以前は en の placeholder を単体テストで見ていた）。`useT(messages)` で別の画面の辞書のキーもコンパイルエラーになる。
- API のエラーは、どの画面の操作でも同じキーで返り、`toErrorMessage` が 1 か所で翻訳するので、共通の辞書に置く。

## 採用しなかった案
- next-intl 4.14.6 に置き換える: npm registry の実物の依存に @swc/core・@parcel/watcher などネイティブを含む 10 個が入る（2026-09-29 の work-logs）。en のキーの欠けはコンパイルでは止まらない（Issue #125 の依頼の前提。実物での確認は未確認）。
- 1 つの辞書のまま（仕組みのファイルだけをまとめる）: 画面固有の文言がどの画面のものかを、キーの接頭辞と辞書を読んで探すことになり、ユーザーの「画面の隣で管理したい」を満たさない。
- feature 単位の辞書（`features/todo/todo.messages.ts`）: 画面をまたいで同じ辞書を使うので、画面を消すときに要らないキーが残り、キーにまた画面の名前が要る。

## 影響
- 良い点: 画面の文言は隣のファイルだけを見ればよく、キーが短い。別の画面の辞書のキー・en の欠け・placeholder の違いはコンパイルで止まる。`shared/i18n/` の本体は 4 ファイル。
- 悪い点: 同じ言い回し（「読み込み中…」）を画面ごとに書く（重複を許す）。`*.messages.ts` の名前なら中身が辞書でなくてもハードコードの文言の検査の例外になる（中身は見ない）。
- 見直す条件: 画面をまたいで同じ文言が大量に要る、翻訳を外部の翻訳者・サービスに渡す（JSON の辞書が要る）、対応言語が増えて複数形・選択の構文が要る。

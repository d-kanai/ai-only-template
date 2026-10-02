# クラスベースの対象を frontend の React 以外のモジュールに広げる

- 日付: 2026-10-02
- 状態: 採用
- 関連: ADR `architecture/20261002-class-based-backend.md`（元の決定） / ADR `architecture/20261002-class-based-shared-and-test-support.md`（apps/shared とテストの補助に広げた決定） / `.claude/rules/frontend.md` の「クラスと関数」 / `.claude/rules/architecture-check.md` の `class-based`

## 背景
ADR `architecture/20261002-class-based-backend.md` と `architecture/20261002-class-based-shared-and-test-support.md` で、apps/backend・apps/shared・テストの補助は最上位に関数を置かず、クラスを基本にすると決め、規則 `class-based`（`rule-tests/architecture.test.ts`）と `biome.json` の `noStaticOnlyClass` の override で強制した。frontend（`apps/frontend_customer`）は「React の component / hook と Next の規約が関数を求める」として、ファイルごと対象外にしていた。
その結果、frontend の React 以外のモジュール（`features/todo/api/todo-api.ts`・`api-error.ts`、`shared/i18n/locale.ts`・`format.ts`、`shared/request-log/request-log.ts`）には最上位の関数（`listTodos`・`toErrorMessages`・`negotiateLocale`・`formatDateTime`・`buildRequestLog` など）が残っていた。daiki が「クラス必須でルールにして」と判断した（2026-10-02）。

## 決定
- 規則 `class-based` の対象に、`apps/frontend_customer/` の `features/`・`shared/`・`test-support/` の下の React 以外のモジュール（`*.tsx`・`*.jsx`・`*.hook.*` を除く。テストも除く）を足す。
- `biome.json` の `noStaticOnlyClass` の override に同じ範囲を足す（frontend は別の override にし、`!**/*.tsx`・`!**/*.jsx`・`!**/*.hook.*`・`!**/*.test.*` で除く。テストは規則 `class-based` の対象外なので、Biome の推奨の警告を残す）。
- 名前: `TodoApi`（`list`・`get`・`create`・`rename`・`changeCompletion`・`delete`。補助は `private static`）、`ApiErrorMessage`（`toMessage`・`toMessages`）、`Locales`（`is`・`negotiate`・`fromHeader`）、`DateTimeFormatter`（`format`）、`RequestLogBuilder`（`build`）。どれも状態を持たないので static メソッド。定数（`SUPPORTED_LOCALES`・`DEFAULT_LOCALE`・`LOCALE_HEADER`・`LOCALE_COOKIE`）と型（`Locale`・`ErrorMessages` など）は名前を変えずにクラスの外に置く。
- 画面のテストは `vi.mock("@/features/todo/api/todo-api")` の自動モックのまま、`vi.mocked(TodoApi.list)` で戻り値を決める。
- 対象外（関数のまま）:
  - React の component（`*.tsx`・`*.jsx`）。JSX を含むファイルの補助（`shared/i18n/i18n.tsx` の `defineMessages`・`formatMessage`・`createTranslator`・`isMessageKey`、`test-support/i18n.tsx` の `tJa`）もファイルごと外す。
  - hook（`*.hook.*`）。
  - `app/` の下（`page.tsx`・`layout.tsx`・`app/api/**/route.ts` など Next の規約のファイル）。
  - `apps/frontend_customer/` 直下のファイル（`proxy.ts`・`instrumentation.ts`・`instrumentation-node.ts`・`next.config.ts`）。

## 理由
- ユーザー判断（2026-10-02）: 「クラス必須でルールにして」。
- API の呼び出し・ロケールの判定・日時の表示・リクエストログの組み立ては、React も Next も関数の形を求めない。backend・apps/shared と同じ書き方（クラスの static メソッド）にそろい、テストの差し替えも `vi.mocked(Clock.now)` と同じ `vi.mocked(TodoApi.list)` の形になる。
- component をファイルごと外す: 同じファイルの中で component と補助を見分けるには「JSX を返すか」を型で見る必要があり、今の判定（構文だけ）では決まらない。クラスの component は React の公式で非推奨の書き方。
- hook を外す: hook は `use` で始まる関数として呼ぶ（Rules of Hooks）。
- `app/` と直下のファイルを外す: `page` の default export、`proxy`、`register` は Next が関数の export を求める。`instrumentation-node.ts` は規約のファイルではないが、`register` が Node.js runtime でだけ dynamic import する本体で、Vitest のカバレッジの対象外（`vitest.config.mts`）。形を変えても単体テストで確かめられないので、規約のファイルとまとめて外す。`next.config.ts` は規約の設定ファイルで、今は関数を持たない。
- `ApiErrorMessage` を `ApiError` の static にしない: `ApiError` は例外の値で、文言にするのは画面の都合（ロケール）。`ApiError` 以外の失敗（fetch の TypeError）も受ける。

## 採用しなかった案
- frontend をファイルごと対象外のまま残す: ユーザー判断で採らない。
- frontend 全体を対象にし、component / hook / 規約の関数を行ごとの例外にする: 例外が component と hook の数だけ増え、規則の意味が薄れる。
- `i18n.tsx` を `.ts`（`defineMessages` など）と `.tsx`（`LocaleProvider`・`useT`）に分けて対象に入れる: `defineMessages(...)` の呼び出しの名前を規則 `frontend-hardcoded-text` が見ており、辞書のすべての `*.messages.ts` の書き方が変わる。今回の範囲を超えるので見送る（未確認: 分ける価値があるかは daiki に確認する）。
- `instrumentation-node.ts` もクラスにする: 単体テストが無く、`next start` での実測が要る。得るものが小さいので見送る。

## 影響
- 良い点: frontend の React 以外のモジュールにも最上位の関数が無くなり、規則 `class-based` が backend・apps/shared と同じ判定で止める。
- 悪い点: 呼び出しにクラス名が付き記述が増える（`TodoApi.list()`、`Locales.negotiate(...)`）。
- 見直す条件: frontend に React 以外のモジュールで、外の仕様（ライブラリ・Next）が関数の形を求めるものが増えたとき。

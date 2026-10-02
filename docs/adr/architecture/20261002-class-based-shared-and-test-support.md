# クラスベースの対象を apps/shared とテストの補助（test-support・e2e の補助・spec の support.ts）に広げる

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #262 / ADR `architecture/20261002-class-based-backend.md`（対象を広げる元の決定） / ADR `architecture/20260930-now-single-source.md`（`now()` を `Clock.now()` に変える） / `.claude/rules/shared.md` / `.claude/rules/architecture-check.md` の `class-based`

## 背景
ADR `architecture/20261002-class-based-backend.md` で、apps/backend の本番コードは最上位に関数を置かず、クラスを基本にすると決めた（daiki の判断 2026-10-02）。そこでは対象を backend の本番コードに限り、`apps/shared`（env / logger / now / log-event）とテストのコードは「対象の範囲はユーザーと確認中」として外していた。backend の移行と規則（`rule-tests/architecture.test.ts` の `backend-class-based`、`biome.json` の `noStaticOnlyClass` の override）が済んだ後、daiki が対象の範囲を「すべて」と答えた（2026-10-02）。
apps/shared は backend と frontend 直下（`proxy.ts`・`instrumentation-node.ts`）が import する基盤で、関数（`now`・`readEnv`・`sensitive`・`severityOf` など）が残ると、backend の呼び出し側に関数の import が残る（`Todo.create` の `now()` など）。

## 決定
- 対象を apps/shared の本番コード（テスト以外）と、テストの補助に広げる。テストの補助は、`apps/backend/test-support/`、`apps/e2e/` の補助（`database.ts` など spec 以外のファイル）、`apps/backend/spec/` の `support.ts`。
- 移行は PR に分ける: (1) apps/shared（この ADR と同じ PR。規則 `backend-class-based` を `class-based` に改名して apps/shared に広げ、`noStaticOnlyClass` の override に `apps/shared/**` を足す）→ (2) テストの補助（規則の対象もその PR で広げる）。
- apps/shared のクラス: `now.ts` は `Clock.now()`（static）、`logger.ts` は `Logger` のインスタンス `logger`（呼び出し側の `logger.emit` は変えない）、`log-event.ts` は `LogFieldMarks`（印 `sensitive` / `freeText` ほか）・`FreeTextMask`（自由文の網 `mask`）・`LogSeverity`（`of`）、`env.ts` は `EnvReader`（`read` / `readTool`）・`DotEnvFile`（`load` / `findRepoRoot` / `loadFromRepoRoot`）。値の `env` / `toolEnv` / `logger` / `LOG_EVENT_SCHEMAS` の名前は変えない。
- 表・スキーマ・定数はメソッドの中で作り、クラスの static フィールドにしない（Stryker の `ignoreStatic` の扱いが未確認のため。元の ADR の「未確認」）。
- 対象外:
  - frontend（`apps/frontend_customer`）の React の component / hook と、Next の規約が関数を求めるもの（`page.tsx` の default export、Route Handler の `GET` など、`proxy.ts` の `proxy`）。
  - `*.test.ts` / `*.spec.ts` の中のローカルの補助（そのファイルの中だけで使う関数）。
  - `vitest.global-setup.ts`: Vitest の globalSetup はモジュールの関数（default export か `setup` / `teardown`）を求める（Vitest 5.0.1 の `node_modules/vitest/dist/chunks/index.DzobfTyw.js`: `setup` / `teardown` が関数でなければ投げ、default export を `setup` として呼ぶ。2026-10-02 に読んで確認）。

## 理由
- ユーザー判断（2026-10-02、Issue #262）: 対象の範囲は「すべて」。
- apps/shared が関数のままだと、backend の本番コードに関数の import が残り、元の ADR の「関数の import をやめる」が backend の中だけで閉じない。
- `Clock.now()` を static にし、インスタンスをコンストラクタで注入する形にしない: 「作ったときの時刻が入る」は Entity の生成ルールで、時刻を呼び出し側から渡せる形にするとルールが漏れる（ADR `architecture/20260930-now-single-source.md` の判断と同じ）。テストの差し替えは今のまま `vi.mock("@repo/shared/now")` の 1 つで、自動モックはクラスの static メソッドも mock に差し替える（Issue #262 の調査。`vi.mocked(Clock.now).mockReturnValue(...)` で、`vi.mock` で now を差し替える 8 本のテストファイルが通ることを確認）。
- logger をインスタンスにする（static の `Logger.emit` にしない）: 呼び出し側の `logger.emit(...)` とテストの `vi.spyOn(logger, "emit")` を変えずに済む。
- テストの補助も対象にする: テストの組み立てを読むときも、依存の形（クラスのメソッド）が本番と同じになる。

## 採用しなかった案
- apps/shared を関数のまま残す（元の ADR の範囲のまま）: ユーザー判断「すべて」で採らない。
- `Clock` をインスタンスにして Entity や logger のコンストラクタに注入する: 時刻を渡せる形になり、Entity の生成ルールが呼び出し側に漏れる（上の理由）。差し替えの方法も `vi.mock` とコンストラクタ注入の 2 つになる。
- logger を static だけのクラス（`Logger.emit`）にして全呼び出しを直す: 呼び出し側とテストの spy の書き換えが増えるだけで、得るものが無い。
- frontend の component / hook もクラスにする: React と Next が関数を求める（クラスの component は非推奨の書き方）ので採らない。
- 規則の名前 `backend-class-based` を残す: 対象が backend だけでなくなり、名前が範囲と合わない。

## 影響
- 良い点: backend と apps/shared の本番コードに関数の import が無くなり、規則 `class-based` が両方を同じ判定で止める。時刻の差し替えの書き方（`vi.mocked(Clock.now)`）がすべてのテストでそろう。
- 悪い点: 状態の無い補助もクラス名を付けて呼ぶので記述が増える（`LogFieldMarks.freeText()` など）。`LOG_EVENT_SCHEMAS` は読み込み時にクラスのメソッドを呼ぶので、そのクラスを前に書く必要がある（クラスの宣言は巻き上げられない）。
- 未確認: Stryker の `ignoreStatic` がクラスの static フィールドの初期化を static な変異として扱うか（元の ADR と同じ。今は static フィールドを置かないので該当なし）。
- 見直す条件: 外部の仕様（Vitest・Playwright・Next）が関数を求める場所が、テストの補助の移行で増えたとき。

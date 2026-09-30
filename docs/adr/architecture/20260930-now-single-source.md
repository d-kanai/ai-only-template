# 現在時刻は apps/shared/now.ts の now() だけから取り、Entity の作成日時は引数で受け取らずに生成時に自動で入れる

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #151 / `.claude/rules/shared.md` / `.claude/rules/backend.md` / `.claude/rules/testing.md` / `.claude/rules/architecture-check.md` / `apps/shared/now.ts`

## 背景
現在時刻を `new Date()` で直接読む箇所が 3 つあった（`Todo.create` の既定値、`proxy.ts` の受信時刻、`logger.ts` の timestamp）。`Todo.create(title, createdAt = new Date())` は、一覧の並び順をテストで決まった時刻で確かめるために作成日時を引数で受け取れるようにしていた。

## 決定
- 現在時刻の唯一の出口として `apps/shared/now.ts` の `now(): Date` を置き（`@repo/shared/now`）、アプリのコードはそこからだけ現在時刻を取る。
- `Todo.create(title)` は作成日時を受け取らず、`now()` を自動で入れる（DB の行から戻す `reconstruct` は保存済みの作成日時を受け取る）。
- テストは `now` を `vi.mock` で差し替えて時刻を決める（backend の「`vi.mock` は使わない」の例外）。
- `apps/frontend_customer`・`apps/backend`・`apps/shared` のテスト以外で、引数の無い `new Date`・`Date.now`・`new` の無い `Date()` を `rule-tests/architecture.test.ts` の規則 `now-single-source` で止める（`now.ts` だけ例外）。
- `@repo/shared/now` は backend の 4 層すべてと frontend 直下（`proxy.ts`）から使ってよい。画面側（`app/`・`features/`・`shared/`）は今は使わないので許さない。

## 理由
- ユーザーの判断（2026-09-30）: テストのために作成日時を引数で受け取るのをやめ、domain の生成ルールとして自動で現在時刻が入る形にする。現在時刻は `now.ts` からだけ取り、テストはそれを mock する。規則にして全部直す。
- 時刻を各所で直接読むと、時刻に依存する振る舞いのテストが実行した瞬間で結果を変える。出口が 1 つなら、差し替える場所も 1 つになる。
- 作成日時を引数で受け取ると、「作ったときの時刻が入る」という生成ルールが呼び出し側に漏れ、任意の時刻の Todo を作れてしまう。
- `now()` は現在時刻の Date を返すだけで環境変数・出力・DB に触らないので、env・logger と違って domain・application から使っても層の意味を崩さない。
- 検査はリポジトリの規則として決定的に止める（CLAUDE.md の原則 7）。書き方の抽出は `console-direct-access` と同じ方法にそろえた。

## 採用しなかった案
- `Todo.create(title, createdAt = new Date())` のまま（引数で受け取る）: 生成ルールが呼び出し側に漏れる（ユーザー判断）。
- Clock（時計）の interface をコンストラクタで注入する: 時計は Entity の static な生成メソッドから使う横断的な seam で、注入すると Todo の生成に依存を渡す経路が要る。ユーザーの判断は `now.ts` + mock。
- `vi.useFakeTimers` で `Date` そのものを差し替える: 出口を 1 つに決めないと、どこで時刻を読んでいるかがコードから分からず、規則で止められない。`now.ts` 自身のテストだけで使う。
- Biome の `style/noRestrictedGlobals` で止める: 設定は禁止する名前の一覧（`deniedGlobals`。`@biomejs/biome` の `configuration_schema.json`）で、`Date` を禁止すると引数のある `new Date(x)` や型の位置の `Date` も止まる。

## 影響
- 良い点: 時刻に依存するテストが決定的になり、時刻を決める方法が 1 つになる。Entity の生成ルールが domain の中で完結する。
- 悪い点: 別名（`const D = Date; new D()`）・分割代入（`const { now } = Date`）などは検査が見逃す（`.claude/rules/architecture-check.md` の限界）。テストは `vi.mock` を書く必要がある。
- 見直す条件: 画面側で現在時刻が要るようになったとき（`screen-to-shared` を緩めるか決める）。E2E など別プロセスの時刻を決める必要が出たとき。

# DI コンテナとトランザクションの runner を廃止し、各クラスはコンストラクタ injection にして api ファイルで組み立てる

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #123 / `.claude/rules/backend.md` / `rule-tests/architecture.test.ts` の規則 `presentation`

## 背景
Issue #57 で、command を一律にトランザクションで包むため、DI コンテナ（`apps/backend/features/todo/infra/container.ts`）が query / command を Repository の実装と組み立て、command を domain の interface（トランザクションの runner）で包んでいた（architecture/20260928-commands-always-in-transaction.md）。presentation はコンテナからだけ query / command を受け取り、テストは InMemory 用のコンテナ（スナップショットで rollback する runner 付き）で組み立てていた。ユーザーの判断は「コンテナは分かりにくい。各クラスを普通のコンストラクタ injection にしてほしい」（2026-09-29 の work-logs）。

## 決定
- DI コンテナ（`infra/container.ts`）と、トランザクションの runner（domain の interface、Drizzle と InMemory の実装）を廃止する。
- query / command はコンストラクタで `TodoRepository` を受け取る（今のまま）。command はトランザクションを意識せずに書く。
- presentation もクラス `<Verb><Noun>Api`（`ListTodosApi` など）にする。コンストラクタで query / command（型は `Pick<..., "execute">`）を受け取り、`handle`（アロー関数のプロパティ）を Route Handler として export する。
- 組み立ては api ファイルの最下部で行う（`export const POST = new CreateTodoApi(new CreateTodoCommand(new PostgresTodoRepository(getDatabase().db))).handle`）。`PostgresTodoRepository` は `Database`（Drizzle の db）を受け取る。
- テストは InMemory の Repository をコンストラクタに渡す（`vi.mock` は使わない）。
- presentation の本番コードが参照してよい infra を、自 feature の Postgres の Repository の実装（`*-repository.postgres`）と `apps/backend/shared/infra/database` に変える（規則 `presentation`。InMemory の実装と `schema` は不可）。

## 理由
- ユーザー判断「分かりにくい」（2026-09-29 の work-logs）。コンテナは「組み立て」と「command をトランザクションで包む」の 2 つを 1 か所で行い、型（`Tx` のジェネリック・`repositoryFor`）が増えていた。api ファイルで直接組み立てれば、その API が何で動くかを 1 ファイルで読める。
- 今の command は書き込みが 1 文だけ（`save` の `INSERT ... ON CONFLICT DO UPDATE` か `delete`）で、Postgres は 1 文を原子的に実行するので、一律のトランザクションが無くても途中までの変更は残らない。
- コンストラクタ injection なら、テストで渡すものが型で縛られる（query / command の形が変わればテストがコンパイルエラーになる）。presentation もクラスにして、application と同じ形にそろえる（ユーザー判断）。
- `getDatabase` はプールを `globalThis` に 1 つだけ持つので、api ファイルごとに Repository を作ってもプールは増えない（`apps/backend/shared/infra/database.ts`）。

## 採用しなかった案
- コンテナを残す（組み立てだけに絞る）: 分かりにくさの元（presentation から見えない組み立ての場所）が残る。
- トランザクションの runner だけ残して command ごとに包む: 今の command は 1 文しか書かず、包む意味が無い。要る command が出たときに個別に足す。
- `vi.mock` でモジュールを差し替えてテストする: 差し替えたものの形が型で縛られず、query / command の形が変わってもテストが通り続ける。
- 「command / query を受け取って handler を返す関数」（`createTodoApi(command)`）: 動くが、application と形がそろわない（ユーザー判断でクラスに）。

## 影響
- 良い点: 組み立てが api ファイルに見える。テストは InMemory の Repository を渡すだけになり、rollback を再現する InMemory の runner とスナップショットが要らない。
- 悪い点: 複数の書き込みが要る command は、個別にトランザクションを書く必要がある（付け忘れを仕組みで防がない）。今の規則では application から `Database` と `drizzle-orm` を参照できないので、そのときに依存の形（domain に interface を置くか、規則を変えるか）を Issue で決める。
- 見直す条件: 複数の書き込みをする command が出たとき、または command の数が増えて付け忘れが問題になったとき。

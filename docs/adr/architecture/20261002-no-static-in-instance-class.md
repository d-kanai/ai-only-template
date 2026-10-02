# インスタンスで使うクラスに static を置かない（自分を返すファクトリは除く）

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #300 / ADR `architecture/20261002-class-based-backend.md`（補助を static にしてよいとした元の決定） / ADR `architecture/20261002-class-based-shared-and-test-support.md` / `.claude/rules/architecture-check.md` の `no-static-in-instance-class`

## 背景
ADR `architecture/20261002-class-based-backend.md` で最上位の関数をやめ、補助もクラスのメソッドにすると決めた。そこでは「インスタンスの状態を使わないものは `private static` / `static` など、使い方に合わせて選ぶ」とし、移行（Issue #262）では状態を使わない補助を一律 `private static` にした。
その結果、Repository・API・Entity・Writer・Logger のようにインスタンスとして使うクラスの中に、static の補助が混ざった（`PostgresTodoRepository.toTodos`・`ListTodosApi.toResponseItem`・`Todo.todoPropsSchema` など、2026-10-02 に 12 クラス・34 か所）。daiki が `private static toTodos(` を見て「なんで static なの、基本 static いらないはず」と指摘した（2026-10-02）。

## 決定
- インスタンスのメンバー（コンストラクタ・static でないメソッド・フィールド・アクセサ）を持つクラスには static のメンバーを置かない。補助は `private` のインスタンスのメソッドにし、`this.` で呼ぶ。
- 例外は、自分のクラス（か `Promise<自分のクラス>`）を返すと注釈した static のファクトリ（`Todo.create`・`Todo.reconstruct`・`TestDatabase.create`・`TodoBuilder.of`・`PostgresWriter.of`・`E2eLogServer.start`）。`PostgresWriter.of` は戻り値の型を `Writer` から `PostgresWriter` にした。
- インスタンスを作らずに使うもの（`TestDatabase.schemaPrefix`・`cleanupSchemas`）は、static だけの別のクラス `TestSchemas`（`prefix`・`cleanup`）に分ける。
- static だけのクラス（`Clock`・`TodoApi`・`EnvReader`・`ProblemResponse` など）は今回は変えない。インスタンスにして注入する形に変えるかは daiki の確認待ち（Issue #300）。
- 規則 `no-static-in-instance-class`（`rule-tests/architecture.test.ts`。対象は `class-based` と同じファイル）で機械的に止める。

## 理由
- daiki の判断（2026-10-02）: インスタンスで使うクラスの補助を static にする理由は無い。`toTodos` などは `this` を使わないので、インスタンスのメソッドにしても振る舞いは変わらない。
- 書き方が 1 つになる: 補助を足すたびに「状態を使うか」で static かどうかを選ばずに済み、呼び出しも `this.` にそろう。後で状態を使うようになっても呼び出し側を書き換えずに済む。
- ファクトリは private のコンストラクタの前に検証・準備をする入口で、インスタンスがまだ無いので static でしか書けない。名前（`create`・`of`・`start`）は決まっていないので、戻り値の型で見分ける。
- static だけのクラスは最上位の関数の代わりの置き場所（規則 `class-based`）で、static を外すとインスタンスの組み立てと注入が要る。`Clock` は ADR `architecture/20260930-now-single-source.md` で注入にしないと決めており、画面のテストは `vi.mocked(TodoApi.list)` で差し替えている。作り直しが大きいので範囲を分ける。

## 採用しなかった案
- `private static` だけを止める（public の static は残す）: `TestDatabase.cleanupSchemas` のようにインスタンスのクラスに static の入口が混ざる形が残る。
- static だけのクラスもインスタンスにして注入する（static をほぼすべて外す）: 変更が大きく、`Clock` の ADR と画面のテストの差し替えの形を作り直すことになる。daiki の確認を待ってから別の Issue で行う。
- ファクトリを名前（`create`・`of`）で見分ける: `E2eLogServer.start` のように名前が決まっていない。

## 影響
- 良い点: インスタンスで使うクラスの中の書き方が 1 つ（`private` のメソッドと `this.`）になる。
- 悪い点: 補助をコールバックに渡すときは `(x) => this.f(x)` と書く（`this` を束縛しない参照を渡さない）。型でスキーマを参照するところは `(typeof X)["schema"]` から `X["schema"]`（インスタンスの型の添字）に変わる。
- 見直す条件: static だけのクラスの扱いを daiki が決めたとき。ファクトリの見分け方（戻り値の型）で例外が増えたとき。

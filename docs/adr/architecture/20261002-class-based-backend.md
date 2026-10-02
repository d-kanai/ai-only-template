# apps/backend の本番コードはクラスを基本にし、関数を export せず、補助の関数もクラスのメソッドにする

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #262 / `.claude/rules/backend.md` の「モジュールの境界（expose / internal）」 / `apps/backend/features/notification/expose/notifier.ts` / ADR `architecture/20260929-constructor-injection-without-container.md` / ADR `architecture/20260930-modular-monolith-expose-internal.md`（「expose の関数を command に関数として渡す」の部分をこの ADR で変える）

## 背景
backend の application・presentation・Repository はクラスとコンストラクタ注入で組み立てている（ADR `architecture/20260929-constructor-injection-without-container.md`）が、それ以外は関数が混在していた。モジュールの公開の入口は関数（notification の `expose/notify.ts` の `notify`）で、command はそれを関数の型（`NotifyTodoCompleted`）で受け取っていた（ADR `architecture/20260930-modular-monolith-expose-internal.md`）。本番コードで関数を export するファイルは 15 本あり（backend の shared の `domain`・`infra`・`presentation` の 14 本と todo の domain の `requireTodo`。`validate`・`writerOf`・`changedProps`・`parseJsonBody`・`toProblemResponse` など。2026-10-02 に `grep -rlE '^export (async )?function'` でテスト・`spec/`・`test-support/` を除いて確認）、ファイルの中だけの補助の関数（`function toResponse` など）も多い。
ユーザーの判断は「関数 import 辞めたい。クラスベースを基本にしてほしい」「全部クラスの中でいい」（2026-10-02）。

## 決定
- 対象は `apps/backend` の本番コード（テスト・`spec/`・`test-support/` と `apps/shared` は対象外）。対象の範囲はユーザーと確認中で、ここに書くのは今の決定。
- 単独の関数を export しない。ファイルの中だけの補助の関数（モジュールの最上位の `function`）も置かず、クラスのメソッドにする（インスタンスの状態を使わないものは `private static` / `static` など、使い方に合わせて選ぶ）。
- モジュールをまたぐ利用・ファイルをまたぐ利用は、コンストラクタで受け取ったインスタンス（クラス）を通す。受け取る側は interface（`notify` を持つ `TodoCompletedNotifier` など）で受け、実装のクラスを import しない（モジュールをまたぐときの規則は ADR `architecture/20260930-modular-monolith-expose-internal.md` のまま）。
- モジュールの公開の入口（`expose/`）もクラスにする。最初の移行として、notification の `notify` 関数をクラス `Notifier`（`notify(message): void`。送信の command はコンストラクタの中で組み立てる）にし、todo の command は `TodoCompletedNotifier` の interface で受け取る（Issue #262）。
- 移行は領域ごとの PR に分ける: (1) notification の公開の入口（この ADR と同じ PR）→ (2) domain・Repository・presentation の補助の関数 → (3) backend の shared（domain / infra / presentation）→ (4) ルール検査テストで機械的に止める（CLAUDE.md の原則 7）。(4) までの間は、規則はレビューで見る。

## 理由
- ユーザー判断（2026-10-02、Issue #262）: 関数の import をやめ、クラスを基本にする。補助の関数もクラスの中に置く。
- application・presentation・Repository はすでにクラスとコンストラクタ注入で、テストはコンストラクタに偽物を渡して差し替える（`vi.mock` を使わない。ADR `architecture/20260929-constructor-injection-without-container.md`）。関数を import すると、その依存はコンストラクタに現れず、差し替えるには `vi.mock` かモジュールの関数を引数に取る形が要る。形をクラスにそろえると、依存がすべてコンストラクタで見え、差し替えの方法も 1 つになる。
- モジュールの公開の入口を関数の型で受けていた部分（`NotifyTodoCompleted = (message: string) => void`）は、Repository・TransactionRunner と同じく interface で受ける形にそろう。

## 採用しなかった案
- 関数とクラスの混在を続ける（今のまま）: ユーザー判断で採らない。依存がコンストラクタに出る部分と import に隠れる部分が混ざる。
- 関数は残し、export だけを禁じる（ファイルの中の補助の関数は可）: ユーザー判断「全部クラスの中でいい」で採らない。
- `apps/shared`（env / logger / now）とテストのコードも同時に対象にする: frontend と共有する基盤で、frontend 側の書き方にも影響する。対象の範囲はユーザーと確認中で、今は backend の本番コードに限る。

## 影響
- 良い点: backend の依存がコンストラクタで見え、テストの差し替えの方法がコンストラクタ注入にそろう。モジュールの公開の入口が Repository などと同じ「interface で受けるインスタンス」になる。
- 悪い点: 状態を持たない補助（変換・検査）もクラスに入れるので、記述が増える（`static` の呼び出しはクラス名を付けて書く）。移行の PR が数本に分かれ、その間は関数とクラスが混在する。Node の resolve フック（`shared/infra/ts-resolve.ts`。Node が関数の export を要求する）のように、外部の仕様が関数を求めるものは例外が要るかもしれない（未確認。(3) の PR で確かめる）。
- 未確認: Stryker の `ignoreStatic`（`stryker.config.mjs`）が、クラスの static フィールドの初期化（クラスの定義の評価 = モジュールの読み込み時に 1 回だけ実行される）を static な変異として数えから外すか。補助の値を static フィールドに置くと、変異が Ignored になり検査が弱くなるおそれがある。(2) の PR の前に Stryker で実測する。
- 見直す条件: 対象の範囲（`apps/shared`・テスト）のユーザーの確認が出たとき。外部の仕様（Next の Route Handler・Node のフック・drizzle-kit の設定）が関数を要求して、例外が増えたとき。

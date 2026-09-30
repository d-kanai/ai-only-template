# backend の feature をモジュールとし、直下を公開の入口 expose/ と中身 internal/ に分け、他のモジュールは presentation の組み立てで expose だけを使う

- 日付: 2026-09-30
- 状態: 採用
- 関連: Issue #208 / `.claude/rules/backend.md` の「モジュールの境界（expose / internal）」 / `.claude/rules/architecture-check.md` / `rule-tests/architecture.test.ts` / `apps/backend/features/notification/expose/notify.ts` / `apps/backend/features/todo/internal/presentation/change-todo-completion.api.ts`

## 背景
backend の feature は todo の 1 つだけで、feature の直下に 4 層（domain / application / presentation / infra）を置いていた。feature 同士の参照は層の規則（自 feature と backend/shared だけを許す）で違反になるだけで、他の feature の機能を使う正しい経路が無かった。
Todo を完了にしたときに通知を送る（notification を足す）ことになり、feature の間の呼び出しを、境界を保ったまま入れる形を決める必要が出た（ユーザーの依頼。今の通知はログに出すだけ）。

## 決定
- backend の feature（`apps/backend/features/<f>/`）を 1 つのモジュールとする（モジュラーモノリス）。直下は `expose/`（他のモジュールへ公開する入口。直下のファイルだけ）と `internal/`（4 層。中だけで使う実装）だけにする。
- 他のモジュールは `expose/` だけを使い、`internal/` は参照しない（規則 `module-internal`）。他のモジュールの `expose/` を参照してよいのは自モジュールの `internal/presentation/`（組み立ての場所）だけ（規則 `module-expose-only-from-presentation`）。`expose/` はモジュールの公開 API の組み立ての場所（presentation と同じ役割）で、参照してよいのは自モジュールの `internal/`・`expose/`、`apps/backend/shared/`（組み立てに使う `shared/infra/database` など）、`@repo/shared/env`・`@repo/shared/logger`・`@repo/shared/now` だけ（規則 `expose-imports`）。
- application は他のモジュールを知らない。api ファイルが他のモジュールの `expose/` の関数を import し、command のコンストラクタに関数として渡す（Todo の完了では `ChangeTodoCompletionCommand` が `(message: string) => void` を受け取り、`change-todo-completion.api.ts` が notification の `notify` を渡す）。
- 呼び出しは fire-and-forget。`notify` は同期の `void` を返し、中の Promise は `.catch` で受けて失敗を error のログ 1 行にする。通知は保存の後、未完了 → 完了に変わったときだけで、本文は id だけの英語（`Todo completed: <id>`）。

## 理由
- `internal/` を他のモジュールから見えなくすれば、公開するもの（`expose/` のファイル）だけが契約になり、中身を変えても他のモジュールは壊れない。規則はディレクトリの名前で書けるので、モジュールを足しても規則を直さずに済む。
- 依存を presentation の組み立てに集めると、モジュール間の依存が api ファイルを読めば分かり、application のテストは記録する関数を渡すだけで済む（コンストラクタ注入。ADR `architecture/20260929-constructor-injection-without-container.md`）。`vi.mock` を使わない方針（差し替えるのは now だけ）にも合う。
- Node 24 は未処理の reject でプロセスを終了する（`--unhandled-rejections` の既定 `throw`）。Promise を expose の外に出さなければ、呼び出し側が await を書き忘れても落ちない（2026-09-30 の work-logs の Issue #208 の項目、researcher の実測）。
- 同じ要求を 2 回送っても通知を 1 回にするのは、PUT を冪等にした決定（ADR `architecture/20260930-one-api-per-use-case.md`）に合わせるため。値（title）を出さないのは、ログに利用者の値を出さない方針（リクエストログ・Repository の書き込みのログ）に合わせるため。
- 検査は `rule-tests/architecture.test.ts` の規則として決定的に止める（CLAUDE.md の原則 7）。

## 採用しなかった案
- command が他のモジュールの expose を直接 import する: 手順は少ないが、application が他のモジュールに依存し、テストで差し替えるには `vi.mock` が要る。モジュール間の依存が application のあちこちに散る。
- DB のイベント表（outbox）やメッセージキューで送る: 送信の確実さ（再送・順序）は得られるが、今の通知はログに出すだけで、表・ワーカー・キューの運用に見合わない。確実さが要るようになったら、expose の中身（internal）をそちらに変える。
- expose を HTTP の Route Handler（presentation）と兼ねる（他のモジュールも HTTP で呼ぶ）: 同じプロセスの中で HTTP を経由し、失敗の種類と遅延が増える。HTTP の契約（Problem Details）は画面のためのもので、モジュール間の契約と混ぜない。

## 影響
- 良い点: モジュール間の依存が expose のファイルと api ファイルの組み立てに集まり、境界の違反はテストで止まる。通知の送り先を変えても todo は変わらない。
- 悪い点: 他のモジュールの機能を使うたびに、command のコンストラクタの引数と api ファイルの組み立てが増える。層の規則とモジュールの規則が同じ参照を重ねて検出する（テストの失敗が 2 件出る）。fire-and-forget なので、通知の失敗はログでしか分からず、再送されない。
- 見直す条件: 通知の確実さ（再送・順序）が要るようになったとき（outbox などに変える）、モジュールが増えて組み立てが api ファイルに収まらなくなったとき、`test-support/` や API ジャーニーからの internal の参照を境界の規則に入れたくなったとき。

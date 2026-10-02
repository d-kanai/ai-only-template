# rule-review の評価

違反を仕込んだ差分（patch）と、違反の無い差分で skill を通し、期待どおりに指摘する・しないかを確かめる。

## 当て方
リポジトリを scratchpad などに clone し（`git clone -q --local <repo> <dir>`。本体の作業ツリーと共有のフックを触らない）、clone の中で `git apply <patch>` してから、その clone で skill の手順を引数なしで行う。終わったら clone を消す。

## 期待
| patch | 期待する指摘 | 根拠の観点（行は変わりうるので WHAT で探す） |
| --- | --- | --- |
| `backend-violations.patch` | 🔴 2 件: (1) `change-todo-completion.command.ts` の通知の本文に title を入れた (2) `notification/expose/notifier.ts` が internal の `SendNotificationCommand` を再公開した | backend.md「本文は id だけの英語（`Todo completed: <id>`）。title などの利用者の値を入れない」、backend.md「`expose/` が公開するのは `expose/` に書いたクラス…と型にとどめ、internal の実装のクラスをそのまま公開しない」 |
| `frontend-violations.patch` | 🔴 2 件: (1) atom `Button` の props に Mantine の props 型（`variant`）を通した (2) `onClick` がマウスのイベントを渡す | frontend.md「atom を足す・変えるとき: props は画面が要るものだけを自前の型で出し（Mantine の props 型を渡さない）、イベントは文字列・boolean・引数なしで渡す」（1 行に 2 つの規範。1 件にまとめてもよい） |
| `clean.patch` | 指摘なし（atom `Button` の変数名を変えただけ） | - |

判定: 期待する指摘をすべて含み（見逃し 0）、期待に無い 🔴 が 0 件なら合格。期待に無い 🟡 は件数と内容を記録する。

## 結果の記録
| 日付 | 結果 |
| --- | --- |
| 2026-10-02（Issue #330） | 合格。backend: 検出 4 件 → 検証で 1 件を drop（`Notifier` の行の WHY を根拠にした派生の指摘）→ 🔴 2 件（期待どおり）+ 🟣 1 件（既存の `notifier.test.ts` の `vi.spyOn` による差し替え）。frontend: 🔴 2 件（期待どおり）。clean: 指摘なし。 |

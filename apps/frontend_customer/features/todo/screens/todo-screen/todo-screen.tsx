"use client";

import { useId } from "react";
import { useT } from "@/shared/i18n/i18n";
import { TodoItem } from "../../components/todo-item";
import { useTodoScreen } from "./todo-screen.hook";
import { todoScreenMessages } from "./todo-screen.messages";

// 一覧画面の見た目。状態・データ取得は useTodoScreen に置き、ここは戻り値を描くだけにする。
// "use client": データは hook から /api/todos を fetch して取る（SSR を前提にしない構成）ため、
// useState / useEffect とイベントハンドラを使うクライアントコンポーネントにする。
// 文言はすべて隣の辞書（todo-screen.messages.ts）のキーで t から出す（.claude/rules/frontend.md の「i18n」）。
export function TodoScreen() {
  const t = useT(todoScreenMessages);
  const {
    todos,
    isLoading,
    error,
    fieldErrors,
    newTitle,
    setNewTitle,
    addTodo,
    toggleTodo,
    deleteTodo,
  } = useTodoScreen();
  // 項目のエラーの要素の id（入力の aria-describedby から指す）。
  // WHY useId: 固定の文字列の id は、同じ画面を 2 つ描くと重複する（Biome の useUniqueElementIds も固定の id を違反にする）。
  const titleErrorId = useId();

  return (
    <main>
      <h1>{t("title")}</h1>
      <form
        onSubmit={(event) => {
          // フォーム送信によるページ遷移（再読み込み）を止め、hook の追加処理だけを行う。
          event.preventDefault();
          void addTodo();
        }}
      >
        <label>
          {t("form.newTitle")}
          <input
            // htmlFor + id で結び付けると固定 id が必要になるため、label で input を包んで名前を付ける。
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
            // 項目のエラー（400 の errors の #/title）を入力の説明として結び付け、入力が誤りであることを伝える。
            aria-invalid={fieldErrors.title !== undefined}
            aria-describedby={
              fieldErrors.title === undefined ? undefined : titleErrorId
            }
          />
        </label>
        {fieldErrors.title === undefined ? null : (
          <p
            // label の外に置く: label の中の文字はすべて入力の名前（accessible name）になり、名前にエラーの文言が混ざる。
            // role="alert" を付けない: フォーム全体のエラー（下の alert）と分け、入力の説明として読ませる。
            id={titleErrorId}
          >
            {fieldErrors.title}
          </p>
        )}
        <button type="submit">{t("form.submit")}</button>
      </form>
      {error === null ? null : (
        <p
          // role="alert": 操作の結果として後から出るエラーを、スクリーンリーダーにも即座に読み上げさせる。
          role="alert"
        >
          {error}
        </p>
      )}
      {isLoading ? (
        <p>{t("loading")}</p>
      ) : (
        <ul>
          {todos.map((todo) => (
            <TodoItem
              key={todo.id}
              todo={todo}
              onToggle={(id, completed) => void toggleTodo(id, completed)}
              onDelete={(id) => void deleteTodo(id)}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

"use client";

import Link from "next/link";
import { useT } from "@/shared/i18n/i18n";
import { useTodoDetailScreen } from "./todo-detail-screen.hook";
import { todoDetailScreenMessages } from "./todo-detail-screen.messages";

type TodoDetailScreenProps = {
  // URL の動的セグメント（/todo/[id]）から app/todo/[id]/page.tsx が取り出して渡す。
  // params の解決はルーティング側の責務にし、画面は Todo の id だけを受け取ることで Next に依存せずテストできる。
  // WHY id ではなく todoId: Biome の useUniqueElementIds は、コンポーネントの props でも名前が id なら
  //   固定文字列（<TodoDetailScreen id="todo-1" />）を DOM の id の重複とみなして違反にする。
  //   これは DOM の id ではなく Todo の id なので、ルールと衝突しない名前にして、テストでも固定文字列を渡せるようにする。
  todoId: string;
};

// 詳細画面の見た目。状態・データ取得は useTodoDetailScreen に置き、ここは戻り値を描くだけにする。
// "use client": データは hook から /api/todos/:id を fetch して取る（SSR を前提にしない構成）ため。
// 文言はすべて隣の辞書（todo-detail-screen.messages.ts）のキーで t から出す（.claude/rules/frontend.md の「i18n」）。
export function TodoDetailScreen({ todoId }: TodoDetailScreenProps) {
  const t = useT(todoDetailScreenMessages);
  const {
    todo,
    title,
    setTitle,
    isLoading,
    error,
    saveTitle,
    toggleCompleted,
  } = useTodoDetailScreen(todoId);

  return (
    <main>
      <Link
        // 取得に失敗した（not_found など）ときも一覧に戻れるよう、リンクは状態によらず常に出す。
        href="/"
      >
        {t("back")}
      </Link>
      {error === null ? null : (
        <p
          // role="alert": 操作の結果として後から出るエラーを、スクリーンリーダーにも即座に読み上げさせる。
          role="alert"
        >
          {error}
        </p>
      )}
      {isLoading ? <p>{t("loading")}</p> : null}
      {todo === null ? null : (
        <>
          <h1>
            {
              // 見出しは保存済みの title を出す。入力中の値を出すと、未保存なのに保存されたように見えるため。
              todo.title
            }
          </h1>
          <form
            onSubmit={(event) => {
              // フォーム送信によるページ遷移（再読み込み）を止め、hook の保存処理だけを行う。
              event.preventDefault();
              void saveTitle();
            }}
          >
            <label>
              {t("titleLabel")}
              <input
                // htmlFor + id で結び付けると固定 id が必要になるため、label で input を包んで名前を付ける。
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <button type="submit">{t("save")}</button>
          </form>
          <label>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => void toggleCompleted()}
            />
            {t("completed")}
          </label>
        </>
      )}
    </main>
  );
}

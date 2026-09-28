import { useCallback, useEffect, useState } from "react";
import type { TodoDto } from "@/backend/todo/presentation/list-todos.api";
import type { UpdateTodoRequest } from "@/backend/todo/presentation/update-todo.api";
import { getTodo, updateTodo } from "../../api/todo-api";

// todo-api は失敗時に Error を投げるが、fetch 自体の失敗なども含め catch に何が来るかは型で保証されない。
// 画面には文字列だけを渡したいので、Error 以外は固定の文言にする。
function toMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "予期しないエラーが発生しました";
}

// 詳細画面の状態とイベント。見た目（todo-detail-screen.tsx）はこの戻り値を描くだけにする。
export function useTodoDetailScreen(todoId: string) {
  // 取得前・取得失敗（not_found など）を「Todo がない」として区別できるよう null を使う。
  const [todo, setTodo] = useState<TodoDto | null>(null);
  // 保存前の編集中の値。todo.title（保存済みの値）とは別に持ち、見出しは保存済みの値を出す。
  const [title, setTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // App Router では /todo/1 → /todo/2 の遷移で同じコンポーネントが props だけ変えて再利用されうるため、
    // todoId が変わったら前の Todo の表示を残さないよう状態を戻してから取り直す。
    let ignore = false;
    setTodo(null);
    setIsLoading(true);
    setError(null);
    getTodo(todoId)
      .then(
        (fetched) => {
          if (ignore) return;
          setTodo(fetched);
          setTitle(fetched.title);
        },
        (reason: unknown) => {
          if (!ignore) setError(toMessage(reason));
        },
      )
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });
    // 遷移や unmount の後に、前の todoId の遅れたレスポンスで state を書き換えないようにする。
    return () => {
      ignore = true;
    };
  }, [todoId]);

  // PUT は更新後の Todo を返す契約なので、GET で取り直さずレスポンスをそのまま反映する（一覧画面と違い 1 件だけのため）。
  // 成功したら前の操作のエラー表示は古い情報なので消す。
  const update = useCallback(
    async (request: UpdateTodoRequest): Promise<TodoDto | null> => {
      try {
        const updated = await updateTodo(todoId, request);
        setTodo(updated);
        setError(null);
        return updated;
      } catch (reason) {
        setError(toMessage(reason));
        return null;
      }
    },
    [todoId],
  );

  const saveTitle = useCallback(async () => {
    // 空白だけの title はサーバで弾かれる入力なので送らない（一覧画面の追加と同じ扱い）。前後の空白は保存しない。
    const trimmed = title.trim();
    if (trimmed === "") return;
    const updated = await update({ title: trimmed });
    // 失敗したときは入力を残し、直して再送できるようにする。
    if (updated !== null) setTitle(updated.title);
  }, [title, update]);

  const toggleCompleted = useCallback(async () => {
    if (todo === null) return;
    // title は送らない。編集中で未保存の title を、完了の切り替えのついでに保存してしまわないため。
    await update({ completed: !todo.completed });
  }, [todo, update]);

  return {
    todo,
    title,
    setTitle,
    isLoading,
    error,
    saveTitle,
    toggleCompleted,
  };
}

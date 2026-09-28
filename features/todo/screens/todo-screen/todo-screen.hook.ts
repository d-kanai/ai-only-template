import { useCallback, useEffect, useState } from "react";
import type { TodoDto } from "@/backend/todo/presentation/list-todos.api";
import {
  createTodo,
  deleteTodo,
  listTodos,
  updateTodo,
} from "../../api/todo-api";

// todo-api は失敗時に Error を投げるが、fetch 自体の失敗（ネットワーク断）なども含め、catch には何が来るか型で保証されない。
// 画面には文字列だけを渡したいので、Error 以外は固定の文言にする。
function toMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "予期しないエラーが発生しました";
}

// 一覧画面の状態とイベント。見た目（todo-screen.tsx）はこの戻り値を描くだけにし、ロジックは renderHook で単体テストする。
export function useTodoScreen() {
  const [todos, setTodos] = useState<TodoDto[]>([]);
  // 初回の取得が終わるまでは「空の一覧」と区別したいので true から始める。
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");

  useEffect(() => {
    // unmount 後（StrictMode の二重実行や画面遷移）に遅れて返った結果で state を書き換えないようにする。
    let ignore = false;
    listTodos()
      .then(
        (response) => {
          if (!ignore) setTodos(response.todos);
        },
        (reason: unknown) => {
          if (!ignore) setError(toMessage(reason));
        },
      )
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  // 変更系の操作の共通処理。操作の後は一覧を取り直す。
  // 変更のレスポンスで手元の一覧を書き換えることもできるが、並び順や他の変更の反映まで画面側で再現することになる。
  // サーバの一覧を正とし、画面側に一覧の組み立てロジックを持たせないため、毎回 GET で取り直す。
  // 成功したら前の操作のエラー表示は古い情報なので消す。
  const mutateAndReload = useCallback(
    async (mutate: () => Promise<unknown>): Promise<boolean> => {
      try {
        await mutate();
        const response = await listTodos();
        setTodos(response.todos);
        setError(null);
        return true;
      } catch (reason) {
        setError(toMessage(reason));
        return false;
      }
    },
    [],
  );

  const addTodo = useCallback(async () => {
    // 空白だけの title はサーバで弾かれる入力なので、リクエストを送らずに止める。前後の空白は保存しない。
    const title = newTitle.trim();
    if (title === "") return;
    const succeeded = await mutateAndReload(() => createTodo({ title }));
    // 失敗したときは入力を残し、直して再送できるようにする。
    if (succeeded) setNewTitle("");
  }, [newTitle, mutateAndReload]);

  const toggleTodo = useCallback(
    async (id: string, completed: boolean) => {
      await mutateAndReload(() => updateTodo(id, { completed }));
    },
    [mutateAndReload],
  );

  const removeTodo = useCallback(
    async (id: string) => {
      await mutateAndReload(() => deleteTodo(id));
    },
    [mutateAndReload],
  );

  return {
    todos,
    isLoading,
    error,
    newTitle,
    setNewTitle,
    addTodo,
    toggleTodo,
    deleteTodo: removeTodo,
  };
}

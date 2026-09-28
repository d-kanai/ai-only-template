import { useCallback, useEffect, useRef, useState } from "react";
import {
  createTodo,
  deleteTodo,
  listTodos,
  type TodoDto,
  updateTodo,
} from "@/features/todo/api/todo-api";

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
  // 一覧の GET の連番。最後に送った GET の応答だけを反映する。
  // WHY: 初回の GET と操作後の再取得は並行しうる（初回が遅いうちに追加する、など）。応答は送った順に返るとは限らず、
  //   先に送った初回の GET（追加前の一覧）が後から返ると、追加後の一覧を古い一覧で上書きしてしまう。
  //   後に送った GET ほど新しいサーバの状態を反映しているので、最後に送ったものだけを正とする。
  const latestListRequestRef = useRef(0);

  // 一覧を取り直して反映する。失敗したら error に入れて false を返す。
  // 後から別の GET を送っていた（この応答が古い）場合は、成功も失敗も反映せず true を返す。
  // 表示は新しい GET の結果に任せ、この取得の失敗を「操作の失敗」として扱わない（追加の入力を残す判断などに使うため）。
  // 成功したら前の操作のエラー表示は古い情報なので消す。
  //
  // mutation testing（Stryker）で、reloadTodos・effect・mutateAndReload・toggleTodo・removeTodo の依存配列の変異
  // （ArrayDeclaration）は、それぞれの依存配列の行だけ数えない（disable next-line）。
  // WHY: reloadTodos は依存が無い useCallback なので作り直されず、それを依存に持つ effect・mutateAndReload（と、
  //   mutateAndReload を依存に持つ toggleTodo・removeTodo）も作り直されない。依存配列を [] や別の定数に変えても
  //   挙動が変わらない（等価な変異。Issue #55）。依存配列の直前にコメントを置くため、配列を別の行に書いている。
  const reloadTodos = useCallback(
    async (): Promise<boolean> => {
      latestListRequestRef.current += 1;
      const requestId = latestListRequestRef.current;
      const isStale = () => requestId !== latestListRequestRef.current;
      try {
        const response = await listTodos();
        if (isStale()) return true;
        setTodos(response.todos);
        setError(null);
        return true;
      } catch (reason) {
        if (isStale()) return true;
        setError(toMessage(reason));
        return false;
      } finally {
        // 初回が遅れている間に再取得が先に終わった場合も、一覧は表示できているので読み込み中を解く。
        if (!isStale()) setIsLoading(false);
      }
    },
    // Stryker disable next-line ArrayDeclaration: 依存の無い useCallback は、依存配列を別の定数にしても同じ（等価な変異）
    [],
  );

  useEffect(
    () => {
      void reloadTodos();
      // unmount 後（StrictMode の二重実行や画面遷移）に遅れて返った結果で state を書き換えないよう、
      // 連番を進めて送信中の GET をすべて古い扱いにする。
      // Next 16 の cacheComponents を有効にすると、画面遷移で前のページが unmount されず <Activity> で隠される
      // （Next.js 16.3.6 同梱ドキュメント 02-guides/preserving-ui-state.md）。隠すときもこの片付けが走り、隠れている間の
      // state 更新は反映されるので、ここで古い扱いにしないと、隠れている間に届いた古い一覧が再表示後に出てしまう。
      return () => {
        latestListRequestRef.current += 1;
      };
    },
    // Stryker disable next-line ArrayDeclaration: reloadTodos は作り直されないので [] でも同じ（等価な変異）
    [reloadTodos],
  );

  // 変更系の操作の共通処理。操作の後は一覧を取り直す。
  // 変更のレスポンスで手元の一覧を書き換えることもできるが、並び順や他の変更の反映まで画面側で再現することになる。
  // サーバの一覧を正とし、画面側に一覧の組み立てロジックを持たせないため、毎回 GET で取り直す。
  const mutateAndReload = useCallback(
    async (mutate: () => Promise<unknown>): Promise<boolean> => {
      try {
        await mutate();
      } catch (reason) {
        setError(toMessage(reason));
        return false;
      }
      return reloadTodos();
    },
    // Stryker disable next-line ArrayDeclaration: reloadTodos は作り直されないので [] でも同じ（等価な変異）
    [reloadTodos],
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
    // Stryker disable next-line ArrayDeclaration: mutateAndReload は作り直されないので [] でも同じ（等価な変異。Issue #55）
    [mutateAndReload],
  );

  const removeTodo = useCallback(
    async (id: string) => {
      await mutateAndReload(() => deleteTodo(id));
    },
    // Stryker disable next-line ArrayDeclaration: mutateAndReload は作り直されないので [] でも同じ（等価な変異。Issue #55）
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

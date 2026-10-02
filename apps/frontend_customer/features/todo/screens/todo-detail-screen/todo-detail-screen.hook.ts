import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiErrorMessage,
  type ErrorMessages,
} from "@/features/todo/api/api-error";
import { type Todo, TodoApi } from "@/features/todo/api/todo-api";
import { useLocale } from "@/shared/i18n/i18n";

// 失敗の理由（catch で受けた値）を包んで state に持つ。null（失敗なし）と、reject された値そのものが null / undefined の場合を区別するため。
// WHY 文言ではなく理由を持ち、描画のときに翻訳する（ApiErrorMessage.toMessages）: ロケールが変わっても表示中のエラーがそのロケールで出る。
//   翻訳に使う locale を useCallback の依存に入れずに済み、コールバックが作り直されない（下の依存配列の Stryker のコメントの前提）。
type Failure = { reason: unknown };

// 詳細画面の状態とイベント。見た目（todo-detail-screen.tsx）はこの戻り値を描くだけにする。
export function useTodoDetailScreen(todoId: string) {
  // 取得前・取得失敗（not_found など）を「Todo がない」として区別できるよう null を使う。
  const [todo, setTodo] = useState<Todo | null>(null);
  // 保存前の編集中の値。todo.title（保存済みの値）とは別に持ち、見出しは保存済みの値を出す。
  const [title, setTitle] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const locale = useLocale();
  // todo-api は失敗時に ApiError を投げるが、fetch 自体の失敗なども含め catch に何が来るかは型で保証されない。
  // 画面には翻訳した文字列だけを渡す（ApiError 以外は固定の文言。api-error.ts の ApiErrorMessage.toMessages）。
  const [failure, setFailure] = useState<Failure | null>(null);
  // 表示中の todoId の「世代」。todoId が変わる（または unmount する）たびに進める。
  // WHY: PUT は todoId が変わった後に返ることがある。useCallback の todoId は呼び出し時点の値で固定されるので、
  //   応答が返った時点でまだ同じ画面かどうかは、呼び出し時に控えた世代と今の世代を比べて判断する。
  //   todoId そのものを比べないのは、/todo/1 → /todo/2 → /todo/1 と戻った場合に、
  //   1 回目の /todo/1 で送った PUT の古い応答を、戻った後の取得結果の上に反映してしまうのを防ぐため。
  const todoGenerationRef = useRef(0);

  useEffect(() => {
    // App Router では /todo/1 → /todo/2 の遷移で同じコンポーネントが props だけ変えて再利用されうるため、
    // todoId が変わったら前の Todo の表示を残さないよう状態を戻してから取り直す。
    let ignore = false;
    setTodo(null);
    setIsLoading(true);
    setFailure(null);
    TodoApi.get(todoId)
      .then(
        (fetched) => {
          if (ignore) return;
          setTodo(fetched);
          setTitle(fetched.title);
        },
        (reason: unknown) => {
          if (!ignore) setFailure({ reason });
        },
      )
      .finally(() => {
        if (!ignore) setIsLoading(false);
      });
    // 遷移や unmount の後に、前の todoId の遅れたレスポンスで state を書き換えないようにする。
    return () => {
      ignore = true;
      // 世代は「呼び出し時と違うか」だけを見るので、進める向き（+= / -=）は問わない。
      // Stryker disable next-line AssignmentOperator: -= にしても毎回別の値になり、判定が変わらない（等価な変異。Issue #55）
      todoGenerationRef.current += 1;
    };
  }, [todoId]);

  // 名前の変更（PUT .../title）と完了の切り替え（PUT .../completion）の共通処理。send に今の todoId を渡して呼ぶ。
  // どちらの PUT も更新後の Todo を返す契約なので、GET で取り直さずレスポンスをそのまま反映する（一覧画面と違い 1 件だけのため）。
  // 成功したら前の操作のエラー表示は古い情報なので消す。
  // 応答を待つ間に todoId が変わっていたら、成功も失敗も反映せず null を返す。
  // 反映すると、新しい Todo の画面に前の Todo の内容やエラーが出てしまうため。
  // 呼び出し側（saveTitle）も null なら編集中の title を書き換えないので、新しい Todo の title も保たれる。
  // WHY todoId を send の引数で渡す（saveTitle などの closure で読まない）: todoId に依存するのをこの useCallback だけにし、
  //   世代（todoGenerationRef）を控える時点と、送る先の todoId を同じ描画の値にそろえる。
  const update = useCallback(
    async (send: (id: string) => Promise<Todo>): Promise<Todo | null> => {
      const generation = todoGenerationRef.current;
      const isStale = () => generation !== todoGenerationRef.current;
      try {
        const updated = await send(todoId);
        if (isStale()) return null;
        setTodo(updated);
        setFailure(null);
        return updated;
      } catch (reason) {
        if (!isStale()) setFailure({ reason });
        return null;
      }
    },
    [todoId],
  );

  const saveTitle = useCallback(async () => {
    // 空白だけの title はサーバで弾かれる入力なので送らない（一覧画面の追加と同じ扱い）。前後の空白は保存しない。
    const trimmed = title.trim();
    if (trimmed === "") return;
    const updated = await update((id) => TodoApi.rename(id, trimmed));
    // 失敗したときは入力を残し、直して再送できるようにする。
    if (updated !== null) setTitle(updated.title);
  }, [title, update]);

  const toggleCompleted = useCallback(async () => {
    if (todo === null) return;
    // 完了の API（本文は completed だけ）を呼ぶので、編集中で未保存の title は保存されない。
    const completed = !todo.completed;
    await update((id) => TodoApi.changeCompletion(id, completed));
  }, [todo, update]);

  // 失敗を、フォーム全体の文言（error。role="alert" で出す）と、入力の下に出す項目ごとの文言（fieldErrors）に分ける（Issue #144）。
  // WHY 項目は "title" だけ: この画面のtitle のフォームが描く入力は title だけ。ほかの項目の誤りは error に出る（api-error.ts の
  //   ApiErrorMessage.toMessages）。
  const errorMessages: ErrorMessages<"title"> =
    failure === null
      ? { form: null, fields: {} }
      : ApiErrorMessage.toMessages(failure.reason, locale, ["title"]);

  return {
    todo,
    title,
    setTitle,
    isLoading,
    error: errorMessages.form,
    fieldErrors: errorMessages.fields,
    saveTitle,
    toggleCompleted,
  };
}

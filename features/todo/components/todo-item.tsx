import Link from "next/link";
import type { TodoDto } from "@/backend/todo/presentation/list-todos.api";

type TodoItemProps = {
  todo: TodoDto;
  // 切り替え後の値を渡す。呼び出し側が現在値を反転する処理を持たずに済み、PUT の body にそのまま使える。
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
};

// 一覧の 1 行。状態は持たず、操作は props のコールバックで親（screen の hook）に返す。
// 各コントロールには title を含む aria-label を付ける。一覧では同じ「削除」ボタンが行の数だけ並ぶため、
// スクリーンリーダーでもテストでも、どの Todo の操作かを名前で区別できるようにする。
// （<label htmlFor> で結び付けると固定 id が必要になり、同じ部品を複数回描くと id が重複するため使わない）
export function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  return (
    <li>
      <input
        type="checkbox"
        aria-label={`「${todo.title}」を完了にする`}
        checked={todo.completed}
        onChange={(event) => onToggle(todo.id, event.target.checked)}
      />
      <Link href={`/todo/${encodeURIComponent(todo.id)}`}>{todo.title}</Link>
      <button
        type="button"
        aria-label={`「${todo.title}」を削除`}
        onClick={() => onDelete(todo.id)}
      >
        削除
      </button>
    </li>
  );
}

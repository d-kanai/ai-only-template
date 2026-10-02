import type { Todo } from "@/features/todo/api/todo-api";
import { DateTimeFormatter } from "@/shared/i18n/format";
import { useLocale, useT } from "@/shared/i18n/i18n";
import { Button } from "@/shared/ui/atoms/button";
import { Checkbox } from "@/shared/ui/atoms/checkbox";
import { Link } from "@/shared/ui/atoms/link";
import { ListItem } from "@/shared/ui/atoms/list-item";
import { Time } from "@/shared/ui/atoms/time";
import { todoItemMessages } from "./todo-item.messages";

type TodoItemProps = {
  todo: Todo;
  // 切り替え後の値を渡す。呼び出し側が現在値を反転する処理を持たずに済み、PUT の body にそのまま使える。
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
};

// 一覧の 1 行。状態は持たず、操作は props のコールバックで親（screen の hook）に返す。
// 見た目はデザインシステムの atom（shared/ui/atoms/）を置くだけで、形・色はテーマ（shared/ui/themes/）に書く（Issue #292）。
// Button は type を書かない: atom の Button の既定は type="button"（フォームの送信にならない）。
// 各コントロールには title を含む aria-label を付ける。一覧では同じ「削除」ボタンが行の数だけ並ぶため、
// スクリーンリーダーでもテストでも、どの Todo の操作かを名前で区別できるようにする。
// （<label htmlFor> で結び付けると固定 id が必要になり、同じ部品を複数回描くと id が重複するため使わない）
// 文言はすべて隣の辞書（todo-item.messages.ts）のキーで t から出す（.claude/rules/code/frontend.md の「i18n」）。
export function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  const t = useT(todoItemMessages);
  const locale = useLocale();
  // 作成日時はブラウザ（利用者）のタイムゾーンで出す。サーバは UTC で動く（package.json の TZ=UTC）ので、サーバで決めると
  // 利用者の時刻とずれる。
  // WHY 描画の中で読んでよい（hydration の不一致にならない）: 一覧は hook が useEffect の中で取得してから描くので、
  //   この部品はサーバの prerender・SSR では描かれず、ブラウザでだけ描かれる（.claude/rules/code/frontend.md の「データ取得とレンダリング」の表の「prerender」）。
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return (
    <ListItem>
      <Checkbox
        aria-label={t("toggle", { title: todo.title })}
        checked={todo.completed}
        onChange={(completed) => onToggle(todo.id, completed)}
      />
      <Link href={`/todo/${encodeURIComponent(todo.id)}`}>{todo.title}</Link>
      <Time dateTime={todo.createdAt}>
        {DateTimeFormatter.format(todo.createdAt, locale, timeZone)}
      </Time>
      <Button
        aria-label={t("deleteAria", { title: todo.title })}
        onClick={() => onDelete(todo.id)}
      >
        {t("delete")}
      </Button>
    </ListItem>
  );
}

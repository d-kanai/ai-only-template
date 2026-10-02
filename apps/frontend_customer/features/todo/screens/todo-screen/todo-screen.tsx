"use client";

import type { Todo } from "@/features/todo/api/todo-api";
import { DateTimeFormatter } from "@/shared/i18n/format";
import { useLocale, useT } from "@/shared/i18n/i18n";
import { Alert } from "@/shared/ui/atoms/alert";
import { Button } from "@/shared/ui/atoms/button";
import { Checkbox } from "@/shared/ui/atoms/checkbox";
import { Form } from "@/shared/ui/atoms/form";
import { Layout } from "@/shared/ui/atoms/layout";
import { Link } from "@/shared/ui/atoms/link";
import { List } from "@/shared/ui/atoms/list";
import { ListItem } from "@/shared/ui/atoms/list-item";
import { PageTitle } from "@/shared/ui/atoms/page-title";
import { Surface } from "@/shared/ui/atoms/surface";
import { Text } from "@/shared/ui/atoms/text";
import { TextInput } from "@/shared/ui/atoms/text-input";
import { Time } from "@/shared/ui/atoms/time";
import { useTodoScreen } from "./todo-screen.hook";
import { todoScreenMessages } from "./todo-screen.messages";

// 一覧画面。状態・データ取得は useTodoScreen に置き、ここは戻り値を描くだけにする。
// WHY 画面の関数は骨組み（<Layout> の下に Section / Form を並べるだけ）にする（daiki の依頼 2026-10-02）: ファイルを開いて
//   最初の関数を見れば画面のレイアウトが分かる。中身（atom の並べ方・読み込み中とエラーの出し分け）は、このファイルの下の方の
//   export しない部品に閉じる。形は rule-tests/screen-outline.test.ts が検査する。
// 見た目はデザインシステムの atom（shared/ui/atoms/）を置くだけで、色・余白・部品の形はテーマ（shared/ui/themes/）に書く（Issue #292）。
// "use client": データは hook から /api/todos を fetch して取る（SSR を前提にしない構成）ため、
// useState / useEffect とイベントハンドラを使うクライアントコンポーネントにする。
// 文言はすべて隣の辞書（todo-screen.messages.ts）のキーで t から出す（.claude/rules/code/frontend.md の「i18n」）。
export function TodoScreen() {
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
  return (
    <Layout>
      <TitleSection />
      <NewTodoForm
        title={newTitle}
        onTitleChange={setNewTitle}
        titleError={fieldErrors.title}
        onSubmit={() => void addTodo()}
      />
      <ErrorSection error={error} />
      <TodoListSection
        todos={todos}
        isLoading={isLoading}
        onToggle={(id, completed) => void toggleTodo(id, completed)}
        onDelete={(id) => void deleteTodo(id)}
      />
    </Layout>
  );
}

function TitleSection() {
  const t = useT(todoScreenMessages);
  return <PageTitle>{t("title")}</PageTitle>;
}

type NewTodoFormProps = {
  title: string;
  onTitleChange: (title: string) => void;
  titleError: string | undefined;
  onSubmit: () => void;
};

function NewTodoForm({
  title,
  onTitleChange,
  titleError,
  onSubmit,
}: NewTodoFormProps) {
  const t = useT(todoScreenMessages);
  return (
    // ページ遷移（再読み込み）は Form が止める。ここは hook の追加処理だけを行う。
    <Form onSubmit={onSubmit}>
      <TextInput
        label={t("form.newTitle")}
        value={title}
        onChange={onTitleChange}
        // 項目のエラー（400 の errors の #/title）。入力の下に出し、入力と結び付ける（role="alert" は付かない。
        // フォーム全体のエラーと分け、入力の説明として読ませる。shared/ui/atoms/text-input.tsx）。
        error={titleError}
      />
      <Button type="submit">{t("form.submit")}</Button>
    </Form>
  );
}

function ErrorSection({ error }: { error: string | null }) {
  // Alert は role="alert" を持つ: 操作の結果として後から出るエラーを、スクリーンリーダーにも即座に読み上げさせる。
  return error === null ? null : <Alert>{error}</Alert>;
}

type TodoListSectionProps = {
  todos: Todo[];
  isLoading: boolean;
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
};

function TodoListSection({
  todos,
  isLoading,
  onToggle,
  onDelete,
}: TodoListSectionProps) {
  const t = useT(todoScreenMessages);
  if (isLoading) {
    return <Text>{t("loading")}</Text>;
  }
  return (
    <Surface>
      <List>
        {todos.map((todo) => (
          <TodoItem
            key={todo.id}
            todo={todo}
            onToggle={onToggle}
            onDelete={onDelete}
          />
        ))}
      </List>
    </Surface>
  );
}

type TodoItemProps = {
  todo: Todo;
  // 切り替え後の値を渡す。呼び出し側が現在値を反転する処理を持たずに済み、PUT の body にそのまま使える。
  onToggle: (id: string, completed: boolean) => void;
  onDelete: (id: string) => void;
};

// 一覧の 1 行。状態は持たず、操作は props のコールバックで親（screen の hook）に返す。
// WHY この画面のファイルの中に export せずに置く（Issue #340）: 使うのはこの画面だけで、1 画面だけで使う部品は画面のファイルの中に
//   置く（.claude/rules/code/frontend.md の「ディレクトリ構成」の表の `components/`）。別の画面でも使うようになったら
//   features/todo/components/ に出す。Layout の直下には置かないので名前は ...Section / ...Form でなくてよい（screen-outline-layout-children）。
// Button は type を書かない: atom の Button の既定は type="button"（フォームの送信にならない）。
// 各コントロールには title を含む aria-label を付ける。一覧では同じ「削除」ボタンが行の数だけ並ぶため、
// スクリーンリーダーでもテストでも、どの Todo の操作かを名前で区別できるようにする。
// （<label htmlFor> で結び付けると固定 id が必要になり、同じ部品を複数回描くと id が重複するため使わない）
function TodoItem({ todo, onToggle, onDelete }: TodoItemProps) {
  const t = useT(todoScreenMessages);
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

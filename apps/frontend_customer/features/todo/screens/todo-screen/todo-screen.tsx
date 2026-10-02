"use client";

import type { Todo } from "@/features/todo/api/todo-api";
import { useT } from "@/shared/i18n/i18n";
import { Alert } from "@/shared/ui/atoms/alert";
import { Button } from "@/shared/ui/atoms/button";
import { Form } from "@/shared/ui/atoms/form";
import { Layout } from "@/shared/ui/atoms/layout";
import { List } from "@/shared/ui/atoms/list";
import { PageTitle } from "@/shared/ui/atoms/page-title";
import { Surface } from "@/shared/ui/atoms/surface";
import { Text } from "@/shared/ui/atoms/text";
import { TextInput } from "@/shared/ui/atoms/text-input";
import { TodoItem } from "../../components/todo-item";
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

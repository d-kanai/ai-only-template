"use client";

import { useT } from "@/shared/i18n/i18n";
import { Alert } from "@/shared/ui/atoms/alert";
import { Button } from "@/shared/ui/atoms/button";
import { Form } from "@/shared/ui/atoms/form";
import { List } from "@/shared/ui/atoms/list";
import { Page } from "@/shared/ui/atoms/page";
import { PageTitle } from "@/shared/ui/atoms/page-title";
import { Surface } from "@/shared/ui/atoms/surface";
import { Text } from "@/shared/ui/atoms/text";
import { TextInput } from "@/shared/ui/atoms/text-input";
import { TodoItem } from "../../components/todo-item";
import { useTodoScreen } from "./todo-screen.hook";
import { todoScreenMessages } from "./todo-screen.messages";

// 一覧画面。状態・データ取得は useTodoScreen に置き、ここは戻り値を描くだけにする。
// 見た目はデザインシステムの atom（shared/ui/atoms/）を置くだけで、色・余白・部品の形はテーマ（shared/ui/themes/）に書く（Issue #292）。
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
  return (
    <Page>
      <PageTitle>{t("title")}</PageTitle>
      {/* ページ遷移（再読み込み）は Form が止める。ここは hook の追加処理だけを行う。 */}
      <Form onSubmit={() => void addTodo()}>
        <TextInput
          label={t("form.newTitle")}
          value={newTitle}
          onChange={setNewTitle}
          // 項目のエラー（400 の errors の #/title）。入力の下に出し、入力と結び付ける（role="alert" は付かない。
          // フォーム全体のエラーと分け、入力の説明として読ませる。shared/ui/atoms/text-input.tsx）。
          error={fieldErrors.title}
        />
        <Button type="submit">{t("form.submit")}</Button>
      </Form>
      {error === null ? null : (
        // Alert は role="alert" を持つ: 操作の結果として後から出るエラーを、スクリーンリーダーにも即座に読み上げさせる。
        <Alert>{error}</Alert>
      )}
      {isLoading ? (
        <Text>{t("loading")}</Text>
      ) : (
        <Surface>
          <List>
            {todos.map((todo) => (
              <TodoItem
                key={todo.id}
                todo={todo}
                onToggle={(id, completed) => void toggleTodo(id, completed)}
                onDelete={(id) => void deleteTodo(id)}
              />
            ))}
          </List>
        </Surface>
      )}
    </Page>
  );
}

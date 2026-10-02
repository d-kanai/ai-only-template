"use client";

import {
  Alert,
  Button,
  Container,
  List,
  Paper,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useT } from "@/shared/i18n/i18n";
import { TodoItem } from "../../components/todo-item";
import { useTodoScreen } from "./todo-screen.hook";
import { todoScreenMessages } from "./todo-screen.messages";

// 一覧画面。状態・データ取得は useTodoScreen に置き、ここは戻り値を描くだけにする。
// 見た目はデザインシステム（Mantine）の部品を置くだけで、色・余白・部品の形はテーマ（shared/ui/themes/）に書く（Issue #292）。
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
    <Container component="main">
      <Title order={1}>{t("title")}</Title>
      <Paper
        component="form"
        onSubmit={(event) => {
          // フォーム送信によるページ遷移（再読み込み）を止め、hook の追加処理だけを行う。
          event.preventDefault();
          void addTodo();
        }}
      >
        <TextInput
          label={t("form.newTitle")}
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          // 項目のエラー（400 の errors の #/title）。Mantine の TextInput が入力の下に出し、aria-invalid と
          // aria-describedby（Mantine が振る id）で入力と結び付ける。role="alert" は付かない（フォーム全体のエラーと分け、
          // 入力の説明として読ませる）。
          error={fieldErrors.title}
        />
        <Button type="submit">{t("form.submit")}</Button>
      </Paper>
      {error === null ? null : (
        // Alert は role="alert" を持つ: 操作の結果として後から出るエラーを、スクリーンリーダーにも即座に読み上げさせる。
        <Alert>{error}</Alert>
      )}
      {isLoading ? (
        <Text>{t("loading")}</Text>
      ) : (
        <Paper>
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
        </Paper>
      )}
    </Container>
  );
}

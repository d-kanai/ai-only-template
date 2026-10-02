"use client";

import { useT } from "@/shared/i18n/i18n";
import { Alert } from "@/shared/ui/atoms/alert";
import { Button } from "@/shared/ui/atoms/button";
import { Checkbox } from "@/shared/ui/atoms/checkbox";
import { Form } from "@/shared/ui/atoms/form";
import { Link } from "@/shared/ui/atoms/link";
import { Page } from "@/shared/ui/atoms/page";
import { PageTitle } from "@/shared/ui/atoms/page-title";
import { Text } from "@/shared/ui/atoms/text";
import { TextInput } from "@/shared/ui/atoms/text-input";
import { useTodoDetailScreen } from "./todo-detail-screen.hook";
import { todoDetailScreenMessages } from "./todo-detail-screen.messages";

type TodoDetailScreenProps = {
  // URL の動的セグメント（/todo/[id]）から app/todo/[id]/page.tsx が取り出して渡す。
  // params の解決はルーティング側の責務にし、画面は Todo の id だけを受け取ることで Next に依存せずテストできる。
  // WHY id ではなく todoId: Biome の useUniqueElementIds は、コンポーネントの props でも名前が id なら
  //   固定文字列（<TodoDetailScreen id="todo-1" />）を DOM の id の重複とみなして違反にする。
  //   これは DOM の id ではなく Todo の id なので、ルールと衝突しない名前にして、テストでも固定文字列を渡せるようにする。
  todoId: string;
};

// 詳細画面。状態・データ取得は useTodoDetailScreen に置き、ここは戻り値を描くだけにする。
// 見た目はデザインシステムの atom（shared/ui/atoms/）を置くだけで、色・余白・部品の形はテーマ（shared/ui/themes/）に書く（Issue #292）。
// "use client": データは hook から /api/todos/:id を fetch して取る（SSR を前提にしない構成）ため。
// 文言はすべて隣の辞書（todo-detail-screen.messages.ts）のキーで t から出す（.claude/rules/frontend.md の「i18n」）。
export function TodoDetailScreen({ todoId }: TodoDetailScreenProps) {
  const t = useT(todoDetailScreenMessages);
  const {
    todo,
    title,
    setTitle,
    isLoading,
    error,
    fieldErrors,
    saveTitle,
    toggleCompleted,
  } = useTodoDetailScreen(todoId);
  return (
    <Page>
      {/* 取得に失敗した（not_found など）ときも一覧に戻れるよう、リンクは状態によらず常に出す。 */}
      <Link href="/">{t("back")}</Link>
      {error === null ? null : (
        // Alert は role="alert" を持つ: 操作の結果として後から出るエラーを、スクリーンリーダーにも即座に読み上げさせる。
        <Alert>{error}</Alert>
      )}
      {isLoading ? <Text>{t("loading")}</Text> : null}
      {todo === null ? null : (
        <>
          <PageTitle>
            {
              // 見出しは保存済みの title を出す。入力中の値を出すと、未保存なのに保存されたように見えるため。
              todo.title
            }
          </PageTitle>
          {/* ページ遷移（再読み込み）は Form が止める。ここは hook の保存処理だけを行う。 */}
          <Form onSubmit={() => void saveTitle()}>
            <TextInput
              label={t("titleLabel")}
              value={title}
              onChange={setTitle}
              // 項目のエラー（400 の errors の #/title）。入力の下に出し、入力と結び付ける（role="alert" は付かない。
              // フォーム全体のエラーと分け、入力の説明として読ませる。shared/ui/atoms/text-input.tsx）。
              error={fieldErrors.title}
            />
            <Button type="submit">{t("save")}</Button>
          </Form>
          <Checkbox
            label={t("completed")}
            checked={todo.completed}
            // 切り替え後の値は使わない: hook が保存済みの Todo の completed を反転して送る（todo-detail-screen.hook.ts の toggleCompleted）。
            onChange={() => void toggleCompleted()}
          />
        </>
      )}
    </Page>
  );
}

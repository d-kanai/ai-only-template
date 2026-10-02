"use client";

import type { Todo } from "@/features/todo/api/todo-api";
import { useT } from "@/shared/i18n/i18n";
import { Alert } from "@/shared/ui/atoms/alert";
import { Button } from "@/shared/ui/atoms/button";
import { Checkbox } from "@/shared/ui/atoms/checkbox";
import { Form } from "@/shared/ui/atoms/form";
import { Layout } from "@/shared/ui/atoms/layout";
import { Link } from "@/shared/ui/atoms/link";
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
// WHY 画面の関数は骨組み（<Layout> の下に Section / Form を並べるだけ）にする（daiki の依頼 2026-10-02）: ファイルを開いて
//   最初の関数を見れば画面のレイアウトが分かる。中身（atom の並べ方・読み込み中・エラー・Todo の有無の出し分け）は、
//   このファイルの下の方の export しない部品に閉じる。形は rule-tests/screen-outline.test.ts が検査する。
// 見た目はデザインシステムの atom（shared/ui/atoms/）を置くだけで、色・余白・部品の形はテーマ（shared/ui/themes/）に書く（Issue #292）。
// "use client": データは hook から /api/todos/:id を fetch して取る（SSR を前提にしない構成）ため。
// 文言はすべて隣の辞書（todo-detail-screen.messages.ts）のキーで t から出す（.claude/rules/frontend.md の「i18n」）。
export function TodoDetailScreen({ todoId }: TodoDetailScreenProps) {
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
    <Layout>
      <BackLinkSection />
      <StatusSection error={error} isLoading={isLoading} />
      <TitleSection todo={todo} />
      <EditTitleForm
        todo={todo}
        title={title}
        onTitleChange={setTitle}
        titleError={fieldErrors.title}
        onSubmit={() => void saveTitle()}
      />
      <CompletedSection todo={todo} onToggle={() => void toggleCompleted()} />
    </Layout>
  );
}

function BackLinkSection() {
  const t = useT(todoDetailScreenMessages);
  // 取得に失敗した（not_found など）ときも一覧に戻れるよう、リンクは状態によらず常に出す。
  return <Link href="/">{t("back")}</Link>;
}

function StatusSection({
  error,
  isLoading,
}: {
  error: string | null;
  isLoading: boolean;
}) {
  const t = useT(todoDetailScreenMessages);
  return (
    <>
      {error === null ? null : (
        // Alert は role="alert" を持つ: 操作の結果として後から出るエラーを、スクリーンリーダーにも即座に読み上げさせる。
        <Alert>{error}</Alert>
      )}
      {isLoading ? <Text>{t("loading")}</Text> : null}
    </>
  );
}

// 下の 3 つの部品は、Todo が取れていない（取得前・取得失敗）ときは何も描かない。
function TitleSection({ todo }: { todo: Todo | null }) {
  return todo === null ? null : (
    // 見出しは保存済みの title を出す。入力中の値を出すと、未保存なのに保存されたように見えるため。
    <PageTitle>{todo.title}</PageTitle>
  );
}

type EditTitleFormProps = {
  todo: Todo | null;
  title: string;
  onTitleChange: (title: string) => void;
  titleError: string | undefined;
  onSubmit: () => void;
};

function EditTitleForm({
  todo,
  title,
  onTitleChange,
  titleError,
  onSubmit,
}: EditTitleFormProps) {
  const t = useT(todoDetailScreenMessages);
  if (todo === null) {
    return null;
  }
  return (
    // ページ遷移（再読み込み）は Form が止める。ここは hook の保存処理だけを行う。
    <Form onSubmit={onSubmit}>
      <TextInput
        label={t("titleLabel")}
        value={title}
        onChange={onTitleChange}
        // 項目のエラー（400 の errors の #/title）。入力の下に出し、入力と結び付ける（role="alert" は付かない。
        // フォーム全体のエラーと分け、入力の説明として読ませる。shared/ui/atoms/text-input.tsx）。
        error={titleError}
      />
      <Button type="submit">{t("save")}</Button>
    </Form>
  );
}

function CompletedSection({
  todo,
  onToggle,
}: {
  todo: Todo | null;
  onToggle: () => void;
}) {
  const t = useT(todoDetailScreenMessages);
  return todo === null ? null : (
    <Checkbox
      label={t("completed")}
      checked={todo.completed}
      // 切り替え後の値は使わない: hook が保存済みの Todo の completed を反転して送る（todo-detail-screen.hook.ts の toggleCompleted）。
      onChange={onToggle}
    />
  );
}

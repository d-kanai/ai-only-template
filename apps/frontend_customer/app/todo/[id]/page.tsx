import { TodoDetailScreen } from "@/features/todo";

// props の型は Next 16 のグローバル型 PageProps<"/todo/[id]"> ではなく明示的に書く。
// PageProps は next build / next dev が .next/types に生成する型で、ビルド前（clone 直後の tsc やエディタ、Vitest）には存在せず型エラーになるため（app/layout.tsx と同じ理由）。
// Next 16 では動的セグメントの params は Promise なので、await して id を取り出してから screen に todoId として渡す。
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <TodoDetailScreen todoId={id} />;
}

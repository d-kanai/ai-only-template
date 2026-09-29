import { TodoScreen } from "@/features/todo";

// ルーティングだけを担う。画面の状態・データ取得・見た目は features/todo の screen に置く。
export default function Page() {
  return <TodoScreen />;
}

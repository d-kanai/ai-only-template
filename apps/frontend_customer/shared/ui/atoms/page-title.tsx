import { Title } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 画面の見出し（h1）。
// WHY 見出しの段（order）を受けない: 今の画面が使うのは画面ごとに 1 つの h1 だけ。h2 以下が要るようになったら、その段の atom か
//   段を受ける props を足す（使わない口を先に開けない）。
export function PageTitle({ children }: { children: ReactNode }) {
  return <Title order={1}>{children}</Title>;
}

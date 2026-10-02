import { Anchor } from "@mantine/core";
import NextLink from "next/link";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: アプリの中の画面へのリンク。
// WHY next/link で描く: 画面の移動をページの再読み込みにせず、Next のクライアント側の遷移にする。画面が next/link と Mantine の
//   Anchor の組み合わせ（component={Link}）を毎回書かずに済む。
// WHY props は href と文字だけ: 下線・色などの見た目はテーマの Anchor が決める。
type LinkProps = {
  href: string;
  children: ReactNode;
};

export function Link({ href, children }: LinkProps) {
  return (
    <Anchor component={NextLink} href={href}>
      {children}
    </Anchor>
  );
}

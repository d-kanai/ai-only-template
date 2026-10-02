import { Button as MantineButton } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292）: 画面は Mantine を直接使わず、shared/ui/atoms/ の部品を置く（rule-tests/design-system.test.ts の
//   design-system-mantine-boundary）。WHY: 画面が Mantine を知らずに済み、ライブラリを替えても atom の中だけ直せばよい。
// WHY props をこれだけにする: 画面が要るのは文字・押したときの処理・送信かどうか・名前の上書きだけ。Mantine の props 型を
//   渡すと variant / color / style props / className など見た目の口が画面に開く。見た目はテーマ（themes/）が決める。
type ButtonProps = {
  children: ReactNode;
  // WHY 引数なし: 画面はボタンを押したことだけを知ればよく、マウスのイベントの中身を使う場面が無い。
  onClick?: () => void;
  // WHY 既定を button にする: 送信ボタンは明示したときだけにし、フォームの中に置いた普通のボタンが送信にならないようにする。
  type?: "button" | "submit";
  // 見える文字（children）と別に、読み上げ・テストで使う名前（一覧の行ごとの「削除」を区別する）。
  "aria-label"?: string;
};

export function Button({
  children,
  onClick,
  type = "button",
  "aria-label": ariaLabel,
}: ButtonProps) {
  return (
    <MantineButton
      type={type}
      aria-label={ariaLabel}
      onClick={() => onClick?.()}
    >
      {children}
    </MantineButton>
  );
}

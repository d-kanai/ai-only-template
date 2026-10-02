import { Paper } from "@mantine/core";
import type { ReactNode } from "react";

// atom（Issue #292。WHY は button.tsx の冒頭）: 入力と送信ボタンを載せるフォームの面。
// WHY Paper を form として描く: テーマはフォームの面（form.paper）と一覧の面を要素の種類で描き分ける（themes/*/*.module.css）。
type FormProps = {
  // WHY 引数なしで呼ぶ: 送信によるページの遷移（再読み込み）を止める preventDefault はどの画面でも要るので、ここで行う。
  //   画面は送信されたときの処理（hook の追加・保存）だけを書く。
  onSubmit: () => void;
  children: ReactNode;
};

export function Form({ onSubmit, children }: FormProps) {
  return (
    <Paper
      component="form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </Paper>
  );
}

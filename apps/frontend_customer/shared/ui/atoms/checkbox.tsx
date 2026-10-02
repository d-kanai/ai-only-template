import { Checkbox as MantineCheckbox } from "@mantine/core";

// atom（Issue #292。WHY は button.tsx の冒頭）: 完了などの on / off を切り替えるチェックボックス。
// WHY 名前を label か aria-label のどちらか 1 つで必須にする: 名前の無いチェックボックスは読み上げでもテストでも区別できない。
//   一覧の行では見える文字を置かず（行のタイトルがリンクとして隣にある）、aria-label で行の Todo を名前に含める。
type CheckboxProps = {
  checked: boolean;
  // WHY 切り替え後の値（boolean）で呼ぶ: 画面が欲しいのは新しい値だけ。event.currentTarget.checked の取り出しを画面に書かせない。
  onChange: (checked: boolean) => void;
} & (
  | { label: string; "aria-label"?: never }
  | { "aria-label": string; label?: never }
);

export function Checkbox({
  checked,
  onChange,
  label,
  "aria-label": ariaLabel,
}: CheckboxProps) {
  return (
    <MantineCheckbox
      label={label}
      aria-label={ariaLabel}
      checked={checked}
      onChange={(event) => onChange(event.currentTarget.checked)}
    />
  );
}

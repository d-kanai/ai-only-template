import { TextInput as MantineTextInput } from "@mantine/core";

// atom（Issue #292。WHY は button.tsx の冒頭）: 1 行の文字の入力欄。
// WHY props をこれだけにする: 画面が要るのは見えるラベル・値・変更・項目のエラーだけ。見た目の口（size / radius / style など）は
//   型に出さず、テーマが決める。
type TextInputProps = {
  // 見えるラベル。入力欄の名前にもなる（Mantine が label と input を id で結ぶ）。
  label: string;
  value: string;
  // WHY 入力後の文字列で呼ぶ: 画面が欲しいのは値だけ。event.currentTarget.value の取り出しを画面ごとに書かせない。
  onChange: (value: string) => void;
  // 項目のエラー（400 の errors の #/title など）。Mantine が入力の下に出し、aria-invalid と aria-describedby（Mantine が振る id）で
  // 入力と結び付ける。role="alert" は付かない（フォーム全体のエラーの Alert と分け、入力の説明として読ませる）。
  error?: string;
};

export function TextInput({ label, value, onChange, error }: TextInputProps) {
  return (
    <MantineTextInput
      label={label}
      value={value}
      onChange={(event) => onChange(event.currentTarget.value)}
      error={error}
    />
  );
}

import type { Locale } from "./locale";

// 日時（ISO 8601 の文字列。API の createdAt）を、ロケールの書式とタイムゾーンで表示用の文字列にする。
// WHY Intl.DateTimeFormat（ライブラリや Temporal を使わない）: Node とブラウザの標準で、ロケールごとの書式を持つ。
//   Temporal は Node 24 で未実装・Safari が未対応（ADR docs/adr/architecture/20260929-i18n-without-library.md）。
// WHY timeZone を引数にする（関数の中で実行環境のタイムゾーンを読まない）: 画面では利用者のブラウザのタイムゾーン、
//   テストでは固定のタイムゾーンを渡し、どの環境でも同じ入力に同じ結果を返す純粋な関数にする。
//   サーバは UTC で動かす（package.json の TZ=UTC と instrumentation-node.ts の検査）が、日時の表示はブラウザで行う。
// WHY dateStyle: "medium" / timeStyle: "short": 一覧の 1 行に収まる長さで、年を含めて日付を取り違えない書式。
export function formatDateTime(
  iso: string,
  locale: Locale,
  timeZone: string,
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}

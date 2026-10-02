// .feature（Gherkin）の行の読み方。API ジャーニー（rule-tests/api-journey.test.ts の api-journey-section-divider。Issue #217）と
//   E2E（rule-tests/e2e-feature.test.ts の e2e-feature-section-divider。Issue #279）が同じ読み方を使う。
// WHY 1 か所に置く: 仕切りの形や区画の切り替えを 2 つのテストにそれぞれ書くと、片方だけが変わり、同じ書き方の .feature で
//   規則がずれる（rule-tests/feature-business-language.ts と同じ理由）。
// WHY テストファイルから export しない: Vitest はテストファイルを import するとその中の it も登録し、Biome の noExportsInTest も
//   止める（rule-tests/feature-business-language.ts の冒頭）。判定はこれを import するテストの must pass / must reject が固定する。

// .feature の行。区切りは \r\n・\r・\n のどれでもよい。
// WHY \r\n・\r・\n のどれでも分ける: CRLF のファイルを \n だけで分けると行末に \r が残り、仕切りの `─{5}$` が一致せず、すべての
//   When が仕切りの違反になる（reviewer の実測、Issue #217）。単独の \r も分ける: vitest-cucumber は readline で読み、\r でも行を
//   分けるので、\n だけで分けると \r で区切った行が 1 行に隠れて検査を逃れる（reviewer の指摘、Issue #219）。
export function featureLines(source: string): string[] {
  return source.split(/\r\n|\r|\n/);
}

// 仕切りの行 `# ───── <見出し> ─────`（字下げは任意。`#`・空白 1 つ・`─` 5 つ・空白 1 つ・空白と `─` で始まり終わらない見出し・
//   空白 1 つ・`─` 5 つで行が終わる）か。
// WHY 見出しの最初と最後の文字を「空白でも ─ でもない」に限る: `─` の数の違い（6 つ・4 つ）や空白の重なりを、見出しの一部として
//   通さないため（`# ────── x ─────` は左の 6 つ目の ─ が見出しの先頭になりうる）。
export function isSectionDivider(line: string): boolean {
  return /^\s*# ─{5} [^\s─](?:.*[^\s─])? ─{5}$/.test(line);
}

// 読者向けでないコメント行（仕切りでない `#` の行）か空行か。
// WHY 行頭（字下げの後）の # だけをコメントにする: Gherkin のコメントは行全体だけで、行の途中の # は文の一部。
// WHY 仕切りはコメントでも読者向けの行として扱う（reviewer の指摘、Issue #217）: 仕切りの見出しは読者が拾い読みする行で、見ないと
//   `# ───── POST /api/todos で DB に insert ─────` のように技術の言葉を見出しに移すだけで検査を逃れられる。
export function isSkippedLine(line: string): boolean {
  return /^\s*(?:#|$)/.test(line) && !isSectionDivider(line);
}

// .feature の区画（シナリオ・Background・それ以外）を、line が見出しなら切り替えて返す。見出しでなければ今の区画のまま。
export type FeatureSection = "scenario" | "background" | "other";
export function nextSection(
  line: string,
  current: FeatureSection,
): FeatureSection {
  if (/^\s*(?:Scenario(?: Outline| Template)?|Example)\s*:/.test(line)) {
    return "scenario";
  }
  if (/^\s*Background\s*:/.test(line)) {
    return "background";
  }
  return /^\s*(?:Feature|Rule)\s*:/.test(line) ? "other" : current;
}

// シナリオの中の When の行で、直前の行（空行を挟まない）が仕切りでないか（section-divider の違反）。
export function lacksSectionDivider(
  lines: readonly string[],
  index: number,
  section: FeatureSection,
): boolean {
  return (
    section === "scenario" &&
    /^\s*When\s/.test(lines[index] ?? "") &&
    !isSectionDivider(lines[index - 1] ?? "")
  );
}

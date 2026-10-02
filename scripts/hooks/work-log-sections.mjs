// 作業ログ（docs/work-logs/*.md）の diff から、追加された項目（`## ` の見出し）のうち `- 機械化:` の行が無いものを探す。Issue #178。
// 使い方: git diff ... -- docs/work-logs/<日>.md | node scripts/hooks/work-log-sections.mjs
//   → `- 機械化:` の無い見出し（`## ` を除いた文字列）を 1 行ずつ stdout に出す。無ければ何も出さない。終了コードは 0。
//
// WHY: ルールを足す・変えるたびに「lint / 型 / テスト / フック / CI で機械的に止められないか」を検討させる（CLAUDE.md の 7.）。
//   検討したことを作業ログの各項目の `- 機械化:` の行に残させ、書き忘れを Stop フック（require-work-log.sh）と CI
//   （check-work-logs-diff.sh）で止める。
// WHY 判定を 1 か所に切り出す: 2 つのスクリプトが同じ判定を持つと、片方だけ直してずれる。bash では diff の解析を書きにくいので node にする。
// WHY .mjs（.ts にしない）: CI の検査は setup-node より前に runner に入っている node で動く（ci.yml の「Check docs/work-logs in PR diff」）。
//   その版（Ubuntu 24.04 の runner で 22 系）では型の除去に頼れないので、そのまま実行できる JavaScript にする。
// WHY console を使わない: rule-tests/architecture.test.ts の console-direct-access が scripts/ の .mjs も対象にする（出力は stdout に書く）。
// 仕様と限界: .claude/rules/tooling/work-log-hooks.md。テスト: scripts/hooks/work-log-sections.test.ts。

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 行頭の空白（入れ子の箇条書き）を除いて `- 機械化:` で始まり、`:` の後に空白以外が 1 文字以上あること。
// WHY 空白以外を要求する: `- 機械化:` だけの行は検討した中身が無く、形だけ満たして素通りできてしまう。
// WHY 書き方を厳密にする（`機械化:`・`- 機械化 :`・全角の `：` は不可）: 揺れを許すと判定が曖昧になり、見逃しの境界が広がる。
const MECHANIZATION_LINE = /^\s*- 機械化:\s*\S/;

// 項目の見出し。`### ` や `# ` は項目ではない（`## ` の後の 1 文字が空白であることで区別する）。
const SECTION_HEADING = "## ";

// 見出しの文字列（`## ` を除き前後の空白を除いたもの）。空なら `##` を返す。
// WHY 空にしない: 呼び出し側は 1 行 1 見出しで読むので、空行を出すと bash の $(...) で消え、見出しが無かったことになる。
function headingText(line) {
  return line.slice(SECTION_HEADING.length).trim() || "##";
}

/**
 * diff（git diff の出力を行に分けたもの）の追加行（`+` の行）を見て、`- 機械化:` の行が無い見出しを追加された順に返す。
 * 1 項目 = 追加された `## ` の行から、次の追加された `## ` の行の前まで（または次のファイルの diff の前まで）の追加行。
 * @param {string[]} diffLines
 * @returns {string[]}
 */
export function findSectionsWithoutMechanization(diffLines) {
  const missing = [];
  let current;
  const closeSection = () => {
    if (current !== undefined && !current.mechanized)
      missing.push(current.heading);
    current = undefined;
  };
  for (const raw of diffLines) {
    // WHY \r を除く: CRLF のファイルでも見出しの文字列に \r を残さない（`- 機械化:` の判定は \s が \r を空白として扱う）。
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("diff --git ")) {
      // WHY ファイルの境目で項目を閉じる: CI の diff は複数のログを含む。次のファイルの追加行を前のファイルの項目に数えない。
      closeSection();
      continue;
    }
    // WHY diff のファイルの見出し（`+++ b/<path>`）を別扱いしない: 先頭の `+` を除くと `++ b/...` になり、見出し（`## `）にも
    //   `- 機械化:` の行にもならない。`--- a/...`・`@@` は `+` で始まらないので下で飛ばす。
    if (!line.startsWith("+")) continue;
    const added = line.slice(1);
    if (added.startsWith(SECTION_HEADING)) {
      closeSection();
      current = { heading: headingText(added), mechanized: false };
      continue;
    }
    if (current !== undefined && MECHANIZATION_LINE.test(added))
      current.mechanized = true;
  }
  closeSection();
  return missing;
}

/**
 * このファイルが `node scripts/hooks/work-log-sections.mjs` の入口として実行されたときだけ、input（stdin）の diff を読み、
 * `- 機械化:` の無い見出しを 1 行ずつ output（stdout）に書く。処理したら true、import されただけなら false。
 * WHY 入口の判定を関数にして引数で受け取る: テストから import したときに stdin を待たないようにし、入口のときの動作も
 *   同じプロセスで確かめられる（カバレッジ 100% を保つ。vitest.config.mts）。
 * WHY realpath: node は入口のファイルのシンボリックリンクを解決して import.meta.url にする（argv[1] は渡したままのパス）。
 * @param {string} moduleUrl このファイルの import.meta.url
 * @param {string | undefined} entryPath process.argv[1]（node -e などでは undefined）
 * @param {AsyncIterable<Buffer>} input
 * @param {{ write(text: string): unknown }} output
 * @returns {Promise<boolean>}
 */
export async function runCli(moduleUrl, entryPath, input, output) {
  if (
    entryPath === undefined ||
    pathToFileURL(realpathSync(entryPath)).href !== moduleUrl
  )
    return false;
  // WHY Buffer をまとめてから文字列にする: 塊ごとに文字列にすると、マルチバイト文字（日本語の見出し）の途中で切れた塊が化ける。
  const chunks = [];
  for await (const chunk of input) chunks.push(chunk);
  const diffLines = Buffer.concat(chunks).toString("utf8").split("\n");
  output.write(
    findSectionsWithoutMechanization(diffLines)
      .map((heading) => `${heading}\n`)
      .join(""),
  );
  return true;
}

await runCli(import.meta.url, process.argv[1], process.stdin, process.stdout);

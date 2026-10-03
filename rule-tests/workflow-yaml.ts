// GitHub Actions のワークフロー（.github/workflows/*.yml）を字句で読む補助。ワークフローの決まり（rule-tests/github-actions.test.ts）と
//   セキュリティの検査の組み込み（rule-tests/security-scan.test.ts。Issue #362）が同じ読み方を使う。
// WHY 1 か所に置く: job・step の読み方（直下のキーだけ・継続行をつなぐ・steps に限る）は reviewer と Codex の指摘で直してきたもので、
//   2 つのテストにそれぞれ書くと片方だけが直り、同じワークフローで判定がずれる（rule-tests/feature-lines.ts と同じ理由）。
// WHY テストファイルから export しない: Vitest はテストファイルを import するとその中の it も登録し、Biome の noExportsInTest も
//   止める（rule-tests/feature-business-language.ts の冒頭）。判定はこれを import するテストの must pass / must reject が固定する。
// 限界（YAML のパーサを依存に足さない）は rule-tests/github-actions.test.ts の冒頭と各関数のコメント。

export type Job = { name: string; timeout: string | undefined; body: string[] };

export const indentOf = (text: string) => text.length - text.trimStart().length;
const isBlankOrComment = (text: string) => /^\s*(?:#.*)?$/.test(text);

// トップレベルのキー（key は正規表現の文字列）の下の行（コメント・空行を除く。次のトップレベルのキーの手前まで）。
export function topLevelBlock(yaml: string, key: string): string[] {
  const heading = new RegExp(`^${key}\\s*:\\s*(?:#.*)?$`);
  const block: string[] = [];
  let inBlock = false;
  for (const text of yaml.split(/\r?\n/)) {
    if (isBlankOrComment(text)) continue;
    if (indentOf(text) === 0) {
      inBlock = heading.test(text);
    } else if (inBlock) {
      block.push(text);
    }
  }
  return block;
}

const jobsBlock = (yaml: string) => topLevelBlock(yaml, "jobs");

// job の見出しの後の行（job の中身）から、job の直下のキーの timeout-minutes の値を返す。直下のキーのインデントは中身の
//   最初の行のインデント（steps の下の step の timeout-minutes を job のものと取り違えないため）。
function jobTimeout(body: string[]): string | undefined {
  const propertyIndent = body[0] === undefined ? 0 : indentOf(body[0]);
  return body
    .filter((text) => indentOf(text) === propertyIndent)
    .map(
      (text) => /^\s*timeout-minutes\s*:\s*(.*?)\s*(?:#.*)?$/.exec(text)?.[1],
    )
    .find((value) => value !== undefined);
}

// トップレベルの `jobs:` の下の job と、job の直下の timeout-minutes の値（無ければ undefined）を返す。
//   job の見出しは、jobs の下の最初の行と同じインデントのすべての行。名前は最初の `:` の手前（前後の引用符を外す）。
//   WHY 同じインデントの行をすべて見出しにする: `<名前>:` の形に限ると、引用符の名前（`"b":`）・アンカー（`b: &x`）・
//     フロー形式（`b: { ... }`）の行が前の job の中身に混ざり、timeout の無い job を見逃した（reviewer の実測）。
//     見出しとして読めば、中身を読めないフロー形式は timeout 無しの違反になる（見逃しを余計な検出に倒す）。
export function readJobs(yaml: string): Job[] {
  const block = jobsBlock(yaml);
  const jobIndent = block[0] === undefined ? 0 : indentOf(block[0]);
  const headings = block.flatMap((text, index) =>
    indentOf(text) === jobIndent ? [{ name: jobName(text), index }] : [],
  );
  return headings.map(({ name, index }, position) => {
    const body = block.slice(
      index + 1,
      headings[position + 1]?.index ?? block.length,
    );
    return { name, timeout: jobTimeout(body), body };
  });
}

function jobName(heading: string): string {
  return heading
    .trim()
    .replace(/\s*:.*$/, "")
    .replace(/^(["'])(.*)\1$/, "$2");
}

export type Step = Record<string, string>;

// job の中身の行から steps を順に取り出す。1 ステップは `- ` で始まる行から次の `- ` の行まで。step の直下のキー（`- ` の後の
//   最初のキーと同じ列）の `キー: 値` だけを集める。
//   WHY 直下のキーだけ: `with:` / `env:` の下のキーを平たく集めると、`with:` の下の `run:` を実行するコマンドと取り違え、
//     `env:` の下の `continue-on-error: false` が step の `continue-on-error: true` を上書きした（reviewer の実測）。
//   WHY 継続行をつなぐ: 値の書いてある直下のキーより深い行は、YAML では値（plain scalar）の続き。読まないと、次の行に書いた
//     `|| true` を見逃した（`run: pnpm audit --audit-level high` の次の行の `|| true` は、YAML では 1 つの値の
//     `pnpm audit --audit-level high || true`。reviewer の実測）。値の無いキー（`with:`）の下の深い行は入れ子のマップなので、つながない。
//   限界: 複数行の値（`run: |`）の中身は読まない（値は "|" になり、下の判定では拒否になる）。継続行は空白 1 つでつなぐ。
export function readSteps(body: string[]): Step[] {
  const chunks: string[][] = [];
  for (const text of body) {
    if (text.trim().startsWith("- ")) chunks.push([]);
    chunks.at(-1)?.push(text);
  }
  return chunks.map(readStep);
}

const stripComment = (raw: string) => raw.replace(/\s+#.*$/, "").trim();

// 1 ステップの行（最初の行が `- `）から、直下のキーの値を集める（継続行は直前のキーの値につなぐ）。
function readStep(lines: string[]): Step {
  const propertyIndent = indentOf(lines[0] ?? "") + 2;
  const step: Step = {};
  let lastKey: string | undefined;
  lines.forEach((text, index) => {
    const trimmed = index === 0 ? text.trim().slice(2) : text.trim();
    if (index > 0 && indentOf(text) > propertyIndent) {
      if (lastKey !== undefined)
        step[lastKey] = `${step[lastKey]} ${stripComment(trimmed)}`;
      return;
    }
    const pair = /^([\w-]+)\s*:\s*(.*)$/.exec(trimmed);
    if (pair?.[1] === undefined) return;
    const value = stripComment(pair[2] ?? "");
    step[pair[1]] = value;
    lastKey = value === "" ? undefined : pair[1];
  });
  return step;
}

// job の直下のキー（job の中身の最初の行と同じインデント）の `キー: 値`。
export function jobProperties(body: string[]): Step {
  const propertyIndent = indentOf(body[0] ?? "");
  return Object.fromEntries(
    body
      .filter((text) => indentOf(text) === propertyIndent)
      .flatMap((text) => {
        const pair = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(text);
        return pair?.[1] === undefined
          ? []
          : [[pair[1], stripComment(pair[2] ?? "")]];
      }),
  );
}

// job の直下の `steps:` の値の行（次の直下のキーの手前まで）。
//   WHY steps に限る: job の中身のすべての `- ` の行を step として読むと、`strategy.matrix.include` の要素の `run:` を
//     実行するコマンドと取り違えた（Codex の指摘）。step の `- ` は `steps:` と同じインデントにも書ける（YAML のブロックの列）。
export function stepsBlock(body: string[]): string[] {
  const propertyIndent = indentOf(body[0] ?? "");
  const start = body.findIndex(
    (text) => indentOf(text) === propertyIndent && /^\s*steps\s*:/.test(text),
  );
  if (start === -1) return [];
  const rest = body.slice(start + 1);
  const end = rest.findIndex(
    (text) =>
      indentOf(text) < propertyIndent ||
      (indentOf(text) === propertyIndent && !text.trim().startsWith("- ")),
  );
  return end === -1 ? rest : rest.slice(0, end);
}

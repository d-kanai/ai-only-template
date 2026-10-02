// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは api ファイルのソースを文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 「1 ユースケース = 1 API」（.claude/rules/backend.md、Issue #175）を、api ファイル（apps/backend/features/*/internal/presentation/*.api.ts）の
// リクエストの項目の `.optional()` で機械的に検査するテスト。
// WHY 検査する: 複数の項目を任意で受けて command の中で「来た項目だけ変える」分岐をする部分更新の API（`{ title?, completed? }`）は、
//   1 つの API に複数のユースケース（改名・完了の切り替え）が混ざり、項目の組み合わせごとの振る舞い・検証・権限が増える。
//   文章の規則だけだと、PATCH の慣習で `.optional()` を並べる書き方が既定のように書かれる。
// 違反にするもの: 行の `//` より前（コード部分）にある `.optional(`。
// 例外の書き方: その行の直前に続く `//` のコメント行（空行を挟まない）のどれかが「// WHY 任意: <理由>」なら通す
//   （同じユースケースの中で本当に任意の項目。rule-tests/schema.test.ts の `// WHY 長さ:` と同じ仕組み）。
//   理由が空・見出しが違う（`// WHY 長さ:` など）・空行を挟む・同じ行の末尾・ブロックコメントは認めない。
// WHY 見出しを `WHY 任意:` だけにする: 別の理由の WHY コメント（その項目の検証の説明など）が直前にあるだけで黙って通らないようにする。
// WHY 行の `.optional(` を見る（どの項目か・スキーマの中かを見ない）: api ファイルで zod の `.optional()` を書く場所はリクエストの
//   スキーマだけで、複数行の chain でも `.optional()` がある行の直前に WHY を書けば、どの項目の例外かが読める。
// 限界: `//` 以降を落としてから探すので、文字列リテラルの中の `//`（`"http://..."` の後ろの `.optional(`）は見逃し、文字列の中の
//   `.optional(` は違反と数える（api ファイルのスキーマでこの書き方は無い想定）。ブロックコメント（`/* .optional() */`）の中も
//   違反と数える（安全側）。`.optional` を変数に入れ直して呼ぶ・`z.optional(x)`・`.partial()`・`.nullish()`・`.default()` のような
//   別の書き方で任意にするものは見ない。

// 例外を認める WHY の見出し（`// WHY 任意: <理由>`）。
const WHY_LABEL = "任意";

// 違反の行（0 始まり）の直前に続く `//` の行に「// WHY 任意: <理由>」があるか。
function hasWhyAbove(lines: string[], lineIndex: number): boolean {
  const why = new RegExp(`^//\\s*WHY ${WHY_LABEL}:\\s*\\S`);
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed.startsWith("//")) return false;
    if (why.test(trimmed)) return true;
  }
  return false;
}

// `.optional(` があり、直前の行に WHY が無い行の行番号（1 始まり）。
function findOptionalViolations(text: string): number[] {
  const lines = text.split("\n");
  return lines.flatMap((line, index) => {
    // WHY `//` 以降を落とす: 「// .optional() は使わない」のようなコメントを違反と数えない。
    const code = line.split("//")[0] ?? "";
    if (!/\.\s*optional\s*\(/.test(code)) return [];
    return hasWhyAbove(lines, index) ? [] : [index + 1];
  });
}

// 検査の対象: apps/backend/features/<f>/internal/presentation/ の直下の *.api.ts（テストは除く）。リポジトリ相対の / 区切りで、名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listApiFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, "apps/backend/features"), {
      recursive: true,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  return entries
    .map((path) => `apps/backend/features/${path.split(sep).join("/")}`)
    .filter((path) =>
      // `*.api.test.ts` は `.api.ts` で終わらないので、この形だけでテストは外れる。
      /^apps\/backend\/features\/[^/]+\/internal\/presentation\/[^/]+\.api\.ts$/.test(
        path,
      ),
    )
    .sort();
}

// 違反を「<パス>:<行>: <行の内容（前後の空白を除く）>」で返す。
function collectApiRequestViolations(root: string): string[] {
  return listApiFiles(root).flatMap((path) => {
    const text = readFileSync(join(root, path), "utf8");
    const lines = text.split("\n");
    return findOptionalViolations(text).map(
      (line) => `${path}:${line}: ${(lines[line - 1] ?? "").trim()}`,
    );
  });
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

describe("リクエストの任意項目の判定（findOptionalViolations）: must pass", () => {
  it.each([
    [
      ".optional() が無い（必須の項目だけ）",
      source(
        "RequestBody.schema({",
        "  title: z.string().trim(),",
        "  completed: z.boolean(),",
        "});",
      ),
    ],
    [
      "直前の行に // WHY 任意: がある",
      source(
        "RequestBody.schema({",
        "  title: z.string(),",
        "  // WHY 任意: 説明文は作成時に省略でき、省略は空文字と同じ意味。",
        "  description: z.string().optional(),",
        "});",
      ),
    ],
    [
      "複数行の WHY のコメントの 1 行目に // WHY 任意: がある（続きの行を挟む）",
      source(
        "RequestBody.schema({",
        "  // WHY 任意: 期限は作成時に決まっていないことが多い。",
        "  //   省略は「期限なし」で、別のユースケースではない。",
        "  dueDate: z.string().optional(),",
        "});",
      ),
    ],
    [
      "複数行の chain で、.optional() の行の直前に // WHY 任意: がある",
      source(
        "RequestBody.schema({",
        "  note: z",
        "    .string()",
        "    .trim()",
        "    // WHY 任意: メモは省略でき、省略は空文字と同じ意味。",
        "    .optional(),",
        "});",
      ),
    ],
    [
      "コメントの中の .optional() は数えない",
      source(
        "// .optional() は使わない（1 ユースケース = 1 API）。",
        "RequestBody.schema({",
        "  title: z.string(), // 部分更新の .optional() にしない",
        "});",
      ),
    ],
    [
      "名前の一部が optional なだけの別のもの（isOptional / optionalFields / .optionalize）",
      source(
        "const a = isOptional(x);",
        "const b = optionalFields;",
        "const c = s.optionalize;",
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findOptionalViolations(text)).toEqual([]);
  });
});

describe("リクエストの任意項目の判定（findOptionalViolations）: must reject", () => {
  it.each<[string, string, number[]]>([
    [
      "部分更新（title も completed も任意）",
      source(
        "RequestBody.schema({",
        "  title: z.string().optional(),",
        "  completed: z.boolean().optional(),",
        "});",
      ),
      [2, 3],
    ],
    [
      "複数行の chain の最後の行の .optional()（その行を報告する）",
      source(
        "RequestBody.schema({",
        "  title: z",
        "    .string()",
        "    .trim()",
        "    .optional(),",
        "});",
      ),
      [5],
    ],
    [
      "複数行の chain で、WHY が .optional() の行ではなく項目の先頭の行の直前にある",
      source(
        "RequestBody.schema({",
        "  // WHY 任意: メモは省略できる。",
        "  note: z",
        "    .string()",
        "    .optional(),",
        "});",
      ),
      [5],
    ],
    [
      "WHY のコメントと .optional() の行の間に空行がある（2 行上の WHY）",
      source(
        "RequestBody.schema({",
        "  // WHY 任意: 説明文は省略できる。",
        "",
        "  description: z.string().optional(),",
        "});",
      ),
      [4],
    ],
    [
      "WHY の見出しが別の規則（長さ）",
      source(
        "RequestBody.schema({",
        "  // WHY 長さ: 説明文は 1000 文字まで。",
        "  description: z.string().max(1000).optional(),",
        "});",
      ),
      [3],
    ],
    [
      "WHY 任意: の理由が空",
      source(
        "RequestBody.schema({",
        "  // WHY 任意:",
        "  description: z.string().optional(),",
        "});",
      ),
      [3],
    ],
    [
      "WHY が同じ行の末尾にある（直前の行に書く）",
      source(
        "RequestBody.schema({",
        "  description: z.string().optional(), // WHY 任意: 説明文は省略できる。",
        "});",
      ),
      [2],
    ],
    [
      "WHY がブロックコメント",
      source(
        "RequestBody.schema({",
        "  /* WHY 任意: 説明文は省略できる。 */",
        "  description: z.string().optional(),",
        "});",
      ),
      [3],
    ],
    [
      "WHY は直後の 1 項目だけに効き、次の項目の .optional() には効かない",
      source(
        "RequestBody.schema({",
        "  // WHY 任意: 説明文は省略できる。",
        "  description: z.string().optional(),",
        "  completed: z.boolean().optional(),",
        "});",
      ),
      [4],
    ],
    [
      ".optional の前後に空白がある（. optional ()）",
      source("RequestBody.schema({ completed: z.boolean(). optional () });"),
      [1],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findOptionalViolations(text)).toEqual(expected);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（presentation/*.api.ts の見つけ方）が漏れれば見逃す。一時ディレクトリに架空のツリーを置き、
//   本番と同じ collectApiRequestViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
describe("api ファイルの列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "api-request-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const partialUpdate = source(
    "RequestBody.schema({",
    "  title: z.string().optional(),",
    "});",
  );

  it("features/<f>/internal/presentation/*.api.ts だけを対象にし、違反を「パス:行: 行の内容」で返す", () => {
    const root = fixture({
      "apps/backend/features/a/internal/presentation/rename-a.api.ts": source(
        "RequestBody.schema({",
        "  title: z.string(),",
        "});",
      ),
      "apps/backend/features/a/internal/presentation/update-a.api.ts": source(
        "RequestBody.schema({",
        "  title: z.string().optional(),",
        "  completed: z.boolean().optional(),",
        "});",
      ),
      "apps/backend/features/b/internal/presentation/create-b.api.ts": source(
        "RequestBody.schema({",
        "  // WHY 任意: 説明文は省略でき、省略は空文字と同じ意味。",
        "  description: z.string().optional(),",
        "});",
      ),
      // 対象外: api のテスト、presentation 以外の層、presentation の入れ子、api でないファイル、shared、features の外。
      "apps/backend/features/a/internal/presentation/update-a.api.test.ts":
        partialUpdate,
      "apps/backend/features/a/internal/application/update-a.command.ts":
        partialUpdate,
      "apps/backend/features/a/internal/application/x.api.ts": partialUpdate,
      "apps/backend/features/a/internal/presentation/nested/x.api.ts":
        partialUpdate,
      "apps/backend/features/a/internal/presentation/helper.ts": partialUpdate,
      "apps/backend/shared/presentation/x.api.ts": partialUpdate,
      // Issue #208: internal/ を挟まない旧の置き場所（置き場所の規則 backend-placement が違反にする）。
      "apps/backend/features/a/presentation/old-a.api.ts": partialUpdate,
      "apps/frontend_customer/features/a/presentation/x.api.ts": partialUpdate,
    });
    expect({
      files: listApiFiles(root),
      violations: collectApiRequestViolations(root),
    }).toEqual({
      files: [
        "apps/backend/features/a/internal/presentation/rename-a.api.ts",
        "apps/backend/features/a/internal/presentation/update-a.api.ts",
        "apps/backend/features/b/internal/presentation/create-b.api.ts",
      ],
      violations: [
        "apps/backend/features/a/internal/presentation/update-a.api.ts:2: title: z.string().optional(),",
        "apps/backend/features/a/internal/presentation/update-a.api.ts:3: completed: z.boolean().optional(),",
      ],
    });
  });

  it("apps/backend/features が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listApiFiles(root),
      violations: collectApiRequestViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("リクエストの任意項目（実ファイル）", () => {
  it("apps/backend/features/*/internal/presentation/*.api.ts は .optional() を WHY 任意: 無しで使わない", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    expect(listApiFiles(repoRoot)).toContain(
      "apps/backend/features/todo/internal/presentation/create-todo.api.ts",
    );
    expect(collectApiRequestViolations(repoRoot)).toEqual([]);
  });
});

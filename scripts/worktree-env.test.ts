// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは bash を子プロセスで
//   起動するだけで DOM を使わない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// worktree 用の .env を .env.example から導く scripts/worktree-env.sh の仕様（Issue #64。.claude/rules/tooling/worktree.md）。
const repoRoot = resolve(__dirname, "..");
const scriptPath = join(repoRoot, "scripts", "worktree-env.sh");

let workDir: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "worktree-env-"));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

// 任意の中身の .env.example を一時ディレクトリに置いてパスを返す。
function exampleFile(fileName: string, content: string): string {
  const path = join(workDir, fileName);
  writeFileSync(path, content);
  return path;
}

function run(args: string[]) {
  return spawnSync("bash", [scriptPath, ...args], { encoding: "utf8" });
}

// 生成した .env の中から NAME= の行の値を取り出す（無ければ undefined）。
function dotenvValue(dotenv: string, name: string): string | undefined {
  const line = dotenv.split("\n").find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1);
}

const MINIMAL = [
  "# コメントはそのまま",
  "DATABASE_URL=postgresql://app:app@localhost:5432/app",
  "DATABASE_POOL_MAX=10",
  "",
  "E2E_PORT=3100",
  "",
].join("\n");

describe("worktree-env.sh（must pass: 導出した値）", () => {
  it("リポジトリの .env.example から、DATABASE_URL のデータベース名と E2E_PORT だけを worktree の名前から導いた値に置き換える", () => {
    // given
    const example = readFileSync(join(repoRoot, ".env.example"), "utf8");

    // when
    const result = run(["agent-a3f2", join(repoRoot, ".env.example")]);

    // then
    expect(result.status).toBe(0);
    expect(dotenvValue(result.stdout, "DATABASE_URL")).toBe(
      "postgresql://app:app@localhost:5432/app_wt_agent_a3f2",
    );
    // 3101 + (cksum("agent-a3f2") = 2768237315) % 800 = 3616。
    expect(dotenvValue(result.stdout, "E2E_PORT")).toBe("3616");
    // 1 行目は生成の印（コメント）。残りは .env.example と行ごとに対応し、置き換えた 2 行以外は同じ。
    const generated = result.stdout.split("\n");
    expect(generated[0]).toBe(
      "# scripts/worktree-env.sh が .env.example から生成した worktree「agent-a3f2」用の .env（手で直しても次の WorktreeCreate で上書きされる）",
    );
    const body = generated.slice(1);
    const original = example.split("\n");
    expect(body.length).toBe(original.length);
    const changed = body
      .map((line, i) => [line, original[i]] as const)
      .filter(([line, orig]) => line !== orig)
      .map(([, orig]) => orig.split("=")[0]);
    expect(changed).toEqual(["DATABASE_URL", "E2E_PORT"]);
  });

  it("DATABASE_URL と E2E_PORT 以外の行（コメント・空行・他の変数）はそのまま出す", () => {
    // given
    const example = exampleFile("minimal.env", MINIMAL);

    // when
    const result = run(["feat-64", example]);

    // then
    expect(result.status).toBe(0);
    expect(result.stdout.split("\n").slice(1).join("\n")).toBe(
      [
        "# コメントはそのまま",
        "DATABASE_URL=postgresql://app:app@localhost:5432/app_wt_feat_64",
        "DATABASE_POOL_MAX=10",
        "",
        // 3101 + (cksum("feat-64") = 372080524) % 800 = 3625。
        "E2E_PORT=3625",
        "",
      ].join("\n"),
    );
  });

  it("DATABASE_URL のクエリ（?sslmode=...）は残し、パスのデータベース名だけを置き換える", () => {
    // given
    const example = exampleFile(
      "query.env",
      "DATABASE_URL=postgresql://u:p@db.example:6543/main?sslmode=disable\nE2E_PORT=3100\n",
    );

    // when
    const result = run(["feat-64", example]);

    // then
    expect(dotenvValue(result.stdout, "DATABASE_URL")).toBe(
      "postgresql://u:p@db.example:6543/app_wt_feat_64?sslmode=disable",
    );
  });

  it("同じ名前からは何度実行しても同じ内容になる（決定的）", () => {
    // given
    const example = exampleFile("determinism.env", MINIMAL);

    // when
    const first = run(["bold-oak-a3f2", example]);
    const second = run(["bold-oak-a3f2", example]);

    // then
    expect(first.status).toBe(0);
    expect(second.stdout).toBe(first.stdout);
    expect(dotenvValue(first.stdout, "E2E_PORT")).toBe("3693");
  });

  it("名前が違えば、データベース名もポートも違う値になる", () => {
    // given
    const example = exampleFile("distinct.env", MINIMAL);

    // when
    const a = run(["agent-a3f2", example]).stdout;
    const b = run(["feat-64", example]).stdout;

    // then
    expect(dotenvValue(a, "DATABASE_URL")).not.toBe(
      dotenvValue(b, "DATABASE_URL"),
    );
    expect(dotenvValue(a, "E2E_PORT")).not.toBe(dotenvValue(b, "E2E_PORT"));
  });

  it("E2E_PORT は 3101〜3900 に収まり、メインの 3100 と重ならない", () => {
    // given
    const example = exampleFile("range.env", MINIMAL);

    // when
    const ports = Array.from({ length: 40 }, (_, i) =>
      Number(dotenvValue(run([`agent-${i}`, example]).stdout, "E2E_PORT")),
    );

    // then
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(3101);
      expect(port).toBeLessThanOrEqual(3900);
    }
    // 40 個がすべて同じ値に潰れていない（導出が名前を見ていることの確認）。
    expect(new Set(ports).size).toBeGreaterThan(30);
  });
});

describe("worktree_db_name（データベース名の sanitize）", () => {
  // 他のフック（worktree-create.sh / worktree-remove.sh）も source して同じ関数を使う。
  function dbName(name: string): string {
    const result = spawnSync(
      "bash",
      ["-c", 'source "$0" && worktree_db_name "$1"', scriptPath, name],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    return result.stdout.trim();
  }

  it.each([
    ["agent-a3f2", "app_wt_agent_a3f2", "英小文字・数字以外（-）は _ にする"],
    [
      "feat/64.X",
      "app_wt_feat_64__",
      "/ . と英大文字も _ にする（Postgres が大文字を小文字に畳むため）",
    ],
    ["64-fix", "app_wt__64_fix", "先頭が数字なら _ を前に付ける"],
    ["a_b", "app_wt_a_b", "_ はそのまま"],
  ])("%s → %s（%s）", (name, expected) => {
    // given: it.each の name と expected
    // when
    const actual = dbName(name);

    // then
    expect(actual).toBe(expected);
  });

  it("長い名前は、Postgres の識別子の上限（63 バイト）に収まるよう app_wt_ を含めて 63 文字に切る", () => {
    // given: 前提なし（100 文字の名前を渡す）
    // when
    const name = dbName("a".repeat(100));

    // then
    expect(name).toBe(`app_wt_${"a".repeat(56)}`);
    expect(name.length).toBe(63);
  });
});

describe("worktree-env.sh（must reject: 分離できない入力は失敗する）", () => {
  it("名前が空なら、何も出さずに失敗する", () => {
    // given
    const example = exampleFile("empty-name.env", MINIMAL);

    // when
    const result = run(["", example]);

    // then
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage");
  });

  it.each([
    ["DATABASE_URL", "E2E_PORT=3100\n"],
    ["E2E_PORT", "DATABASE_URL=postgresql://app:app@localhost:5432/app\n"],
  ])(
    ".env.example に %s が無ければ、その名前を出して失敗する（分離されないまま共有のリソースを指す .env を作らない）",
    (missing, content) => {
      // given
      const example = exampleFile(`no-${missing}.env`, content);

      // when
      const result = run(["feat-64", example]);

      // then
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(missing);
    },
  );

  it("DATABASE_URL にデータベース名のパスが無ければ失敗する（置き換える場所が無い）", () => {
    // given
    const example = exampleFile(
      "no-path.env",
      "DATABASE_URL=postgresql://app:app@localhost:5432\nE2E_PORT=3100\n",
    );

    // when
    const result = run(["feat-64", example]);

    // then
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it(".env.example が無ければ失敗する", () => {
    // given: 前提なし（存在しないパスを渡す）
    // when
    const result = run(["feat-64", join(workDir, "missing.env")]);

    // then
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

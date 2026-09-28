// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは bash と git を子プロセスで
//   起動するだけで DOM を使わない。
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// PreCompact フック（scripts/hooks/pre-compact.sh）の仕様。Issue #64。
// compact の前に、作業状態（日時・trigger・ブランチ・HEAD・git status --short・stash の件数・直近 5 コミットの 1 行目）を
// <リポジトリ直下>/.claude/state/pre-compact.md に上書きで書く。logs/ には書かない（WHY は .claude/rules/work-log.md）。

const scriptPath = resolve(import.meta.dirname, "pre-compact.sh");

describe("pre-compact.sh（PreCompact フック）", () => {
  let tmp: string;
  let repo: string;
  let gitEnv: NodeJS.ProcessEnv;
  const stateFile = () => join(repo, ".claude/state/pre-compact.md");

  function git(args: string[]) {
    const result = spawnSync("git", args, {
      cwd: repo,
      env: gitEnv,
      encoding: "utf8",
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  }

  function commit(file: string, message: string) {
    writeFileSync(join(repo, file), `${message}\n`);
    git(["add", file]);
    git(["commit", "-q", "-m", message]);
  }

  function run(input: Record<string, unknown>) {
    return spawnSync("bash", [scriptPath], {
      input: JSON.stringify(input),
      env: gitEnv,
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "pre-compact-"));
    repo = join(tmp, "repo");
    mkdirSync(repo);
    const home = join(tmp, "home");
    mkdirSync(home);
    writeFileSync(join(home, "gitconfig"), "");
    // 実行元の git の設定（グローバルのフック・署名など）がテストに漏れないようにする。
    gitEnv = {
      // WHY NODE_ENV: Next.js の型定義が ProcessEnv の NODE_ENV を必須にしており、無いと spawnSync の env に渡せない（tsc）。
      NODE_ENV: process.env.NODE_ENV,
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };
    git(["init", "-q", "-b", "main"]);
    // 6 コミット作り、直近 5 つだけが書かれることを確かめる。
    for (let i = 1; i <= 6; i++) commit("a.txt", `commit-${i}`);
    git(["checkout", "-q", "-b", "feat/1-x"]);
    // stash を 2 件、未追跡を 1 件、変更を 1 件作る。
    writeFileSync(join(repo, "a.txt"), "stash-1\n");
    git(["stash", "-q"]);
    writeFileSync(join(repo, "a.txt"), "stash-2\n");
    git(["stash", "-q"]);
    writeFileSync(join(repo, "a.txt"), "modified\n");
    writeFileSync(join(repo, "new.txt"), "new\n");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("trigger・ブランチ・HEAD・git status・stash の件数・直近 5 コミットを .claude/state/pre-compact.md に書き、何も出さずに 0 で終わる", () => {
    const head = git(["rev-parse", "HEAD"]);
    const result = run({
      hook_event_name: "PreCompact",
      trigger: "auto",
      cwd: repo,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");

    const lines = readFileSync(stateFile(), "utf8").split("\n");
    expect(lines).toContain("- trigger: auto");
    expect(lines).toContain("- branch: feat/1-x");
    expect(lines).toContain(`- HEAD: ${head}`);
    expect(lines).toContain("- stash: 2");
    // git status --short の行（変更と未追跡）。
    expect(lines).toContain(" M a.txt");
    expect(lines).toContain("?? new.txt");
    // 直近 5 コミットの 1 行目（新しい順）。6 つ目（commit-1）は書かない。
    const commitLines = lines.filter((line) => /commit-\d/.test(line));
    expect(
      commitLines.map((line) => line.replace(/^- [0-9a-f]+ /, "")),
    ).toEqual(["commit-6", "commit-5", "commit-4", "commit-3", "commit-2"]);
    // 日時の行（ローカル時刻と UTC からのずれ。例: 2026-09-28 21:30:00 +0000）。
    const dateLine = lines.find((line) => line.startsWith("- date: "));
    expect(dateLine).toMatch(
      /^- date: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4}$/,
    );
  });

  it("上書きする（2 回目の実行で 1 回目の内容は残らない）", () => {
    run({ trigger: "auto", cwd: repo });
    const result = run({ trigger: "manual", cwd: repo });
    expect(result.status).toBe(0);
    const content = readFileSync(stateFile(), "utf8");
    expect(content).toContain("- trigger: manual");
    expect(content).not.toContain("- trigger: auto");
  });

  it("cwd がサブディレクトリでも、リポジトリ直下の .claude/state に書く", () => {
    mkdirSync(join(repo, "sub"));
    const result = run({ trigger: "manual", cwd: join(repo, "sub") });
    expect(result.status).toBe(0);
    expect(existsSync(stateFile())).toBe(true);
    expect(existsSync(join(repo, "sub/.claude"))).toBe(false);
  });

  it("logs/ には書かない", () => {
    run({ trigger: "auto", cwd: repo });
    expect(existsSync(join(repo, "logs"))).toBe(false);
  });

  it("stash もコミットも無いリポジトリでも書ける（stash は 0、コミットの行は無し）", () => {
    const empty = join(tmp, "empty");
    mkdirSync(empty);
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: empty, env: gitEnv });
    const result = run({ trigger: "auto", cwd: empty });
    expect(result.status).toBe(0);
    const content = readFileSync(
      join(empty, ".claude/state/pre-compact.md"),
      "utf8",
    );
    expect(content).toContain("- stash: 0");
    expect(content).toContain("- branch: main");
  });

  it("cwd が git リポジトリでなければ何も書かず、理由を stderr に出して 0 で終わる（compact を止めない）", () => {
    const outside = join(tmp, "not-a-repo");
    mkdirSync(outside);
    const result = run({ trigger: "auto", cwd: outside });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("git リポジトリではない");
    expect(existsSync(join(outside, ".claude"))).toBe(false);
  });
});

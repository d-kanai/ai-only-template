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

// InstructionsLoaded フック（scripts/hooks/instructions-loaded.sh）の仕様。
// CLAUDE.md / .claude/rules/*.md が読み込まれるたびに、<リポジトリ直下>/.claude/state/instructions-loaded.jsonl に
// 1 行（ts・file_path・load_reason・trigger_file_path・memory_type）を追記する。
// WHY: 実際にどの指示ファイルが、いつ・何をきっかけに読まれたかを後から確かめるため。

const scriptPath = resolve(import.meta.dirname, "instructions-loaded.sh");

describe("instructions-loaded.sh（InstructionsLoaded フック）", () => {
  let tmp: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  const logFile = () => join(repo, ".claude/state/instructions-loaded.jsonl");

  function run(input: Record<string, unknown> | string) {
    return spawnSync("bash", [scriptPath], {
      input: typeof input === "string" ? input : JSON.stringify(input),
      env,
      encoding: "utf8",
    });
  }

  function records(file = logFile()): Record<string, unknown>[] {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "instructions-loaded-"));
    repo = join(tmp, "repo");
    mkdirSync(repo);
    const home = join(tmp, "home");
    mkdirSync(home);
    writeFileSync(join(home, "gitconfig"), "");
    env = {
      // WHY NODE_ENV: Next.js の型定義が ProcessEnv の NODE_ENV を必須にしており、無いと spawnSync の env に渡せない（tsc）。
      NODE_ENV: process.env.NODE_ENV,
      PATH: process.env.PATH,
      HOME: home,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    };
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("2 回実行すると 2 行を追記し、各行に ts・file_path・load_reason・trigger_file_path・memory_type を書く", () => {
    const before = Date.now();
    const first = run({
      hook_event_name: "InstructionsLoaded",
      cwd: repo,
      file_path: `${repo}/CLAUDE.md`,
      memory_type: "Project",
      load_reason: "session_start",
    });
    const second = run({
      hook_event_name: "InstructionsLoaded",
      cwd: repo,
      file_path: `${repo}/.claude/rules/work-log.md`,
      memory_type: "Project",
      load_reason: "path_glob_match",
      globs: ["docs/work-logs/**"],
      trigger_file_path: `${repo}/docs/work-logs/2026-09-28.md`,
    });
    const after = Date.now();
    for (const result of [first, second]) {
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
    }

    const [a, b, ...rest] = records();
    expect(rest).toEqual([]);
    expect(a).toEqual({
      ts: expect.any(String),
      file_path: `${repo}/CLAUDE.md`,
      load_reason: "session_start",
      trigger_file_path: null,
      memory_type: "Project",
    });
    expect(b).toEqual({
      ts: expect.any(String),
      file_path: `${repo}/.claude/rules/work-log.md`,
      load_reason: "path_glob_match",
      trigger_file_path: `${repo}/docs/work-logs/2026-09-28.md`,
      memory_type: "Project",
    });
    // ts は実行した時刻（ISO 8601 の UTC）。
    for (const record of [a, b]) {
      const ts = String(record?.ts);
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(Date.parse(ts)).toBeGreaterThanOrEqual(before - 1000);
      expect(Date.parse(ts)).toBeLessThanOrEqual(after + 1000);
    }
  });

  it("既にある記録を消さずに追記する", () => {
    mkdirSync(join(repo, ".claude/state"), { recursive: true });
    writeFileSync(logFile(), '{"old":true}\n');
    run({ cwd: repo, file_path: "/x/CLAUDE.md", load_reason: "compact" });
    expect(records()).toEqual([
      { old: true },
      {
        ts: expect.any(String),
        file_path: "/x/CLAUDE.md",
        load_reason: "compact",
        trigger_file_path: null,
        memory_type: null,
      },
    ]);
  });

  it("cwd がサブディレクトリでも、リポジトリ直下の .claude/state に書く", () => {
    mkdirSync(join(repo, "sub"));
    run({ cwd: join(repo, "sub"), file_path: "/x/CLAUDE.md" });
    expect(records()).toHaveLength(1);
    expect(existsSync(join(repo, "sub/.claude"))).toBe(false);
  });

  it("cwd が git リポジトリでなければ cwd の .claude/state に書く", () => {
    const outside = join(tmp, "not-a-repo");
    mkdirSync(outside);
    const result = run({ cwd: outside, file_path: "/x/CLAUDE.md" });
    expect(result.status).toBe(0);
    expect(
      records(join(outside, ".claude/state/instructions-loaded.jsonl")),
    ).toHaveLength(1);
  });

  it("stdin が JSON でなければ何も書かず、理由を stderr に出して 0 で終わる", () => {
    const result = spawnSync("bash", [scriptPath], {
      input: "not json",
      cwd: repo,
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("入力を読めない");
    expect(existsSync(logFile())).toBe(false);
  });
});

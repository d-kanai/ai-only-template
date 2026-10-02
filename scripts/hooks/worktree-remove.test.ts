// @vitest-environment node
// WHY: このテストは bash を子プロセスで起動するだけで DOM を使わない。
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// WorktreeRemove フック scripts/hooks/worktree-remove.sh の仕様（Issue #64。.claude/rules/tooling/worktree.md）。
// 公式（https://code.claude.com/docs/en/hooks.md の WorktreeRemove）: stdin に JSON（worktree_path / cwd など）が渡る。
//   0 以外で終わると、ディレクトリが残っていれば削除が失敗する。JSON の出力は捨てられる。
// 発火は実測で確認できていない（Issue #64 のコメント）ので、後始末の本命は worktree-create.sh の孤立した DB の掃除で、
//   こちらは発火したときに早めに消すだけ。
const repoRoot = resolve(__dirname, "..", "..");
const hookPath = join(repoRoot, "scripts", "hooks", "worktree-remove.sh");

const PSQL =
  "docker compose exec -T db psql -U app -d app -v ON_ERROR_STOP=1 -At -c";

// 偽の docker / pnpm: 呼ばれたカレントディレクトリと引数を CALL_LOG に記録する（worktree-create.test.ts と同じ）。
// FAKE_DOCKER_EXIT / FAKE_PNPM_EXIT があればその値で終わる。
const FAKE_DOCKER = `#!/bin/bash
echo "$PWD docker $*" >> "$CALL_LOG"
exit "\${FAKE_DOCKER_EXIT:-0}"
`;
const FAKE_PNPM = `#!/bin/bash
echo "$PWD pnpm $*" >> "$CALL_LOG"
exit "\${FAKE_PNPM_EXIT:-0}"
`;

let base: string;
let repo: string;
let bin: string;
let callLog: string;

// WHY GIT_* と WORKTREE_HOOK_* を消す: 外のリポジトリを操作したり、実行環境の DRY_RUN で結果が変わったりしないようにする。
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_") || key.startsWith("WORKTREE_HOOK_"))
      delete env[key];
  }
  return { ...env, ...extra };
}

function runHook(
  input: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return spawnSync("bash", [hookPath], {
    input: JSON.stringify({ hook_event_name: "WorktreeRemove", ...input }),
    encoding: "utf8",
    env: childEnv({
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: callLog,
      ...extra,
    }),
  });
}

function calls(): string[] {
  return existsSync(callLog)
    ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

function worktreePath(name: string): string {
  return join(repo, ".claude", "worktrees", name);
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "worktree-remove-")));
  repo = join(base, "repo");
  bin = join(base, "bin");
  callLog = join(base, "calls.log");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "pnpm"), FAKE_PNPM, { mode: 0o755 });
  const init = spawnSync("git", ["init", "-q", "-b", "main"], {
    cwd: repo,
    env: childEnv(),
  });
  expect(init.status).toBe(0);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("worktree-remove.sh（must pass）", () => {
  it("worktree の名前から導いた DB をメインの作業ツリーで drop し、何も出さずに 0 で終わる", () => {
    // given: 前提なし（beforeEach で空の git リポジトリと偽の docker / pnpm がある）
    // when
    const result = runHook({
      worktree_path: worktreePath("agent-a3f2"),
      cwd: repo,
    });

    // then
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(calls()).toEqual([
      `${repo} ${PSQL} drop database if exists app_wt_agent_a3f2 with (force)`,
    ]);
  });

  it("cwd が消えた worktree でも、worktree_path からメインを求めて drop する", () => {
    // given: 前提なし（beforeEach で空の git リポジトリと偽の docker / pnpm がある）
    // when
    const result = runHook({
      worktree_path: worktreePath("feat-64"),
      cwd: worktreePath("feat-64"),
    });

    // then
    expect(result.status).toBe(0);
    expect(calls()).toEqual([
      `${repo} ${PSQL} drop database if exists app_wt_feat_64 with (force)`,
    ]);
  });

  it("メインの共有フックが .claude/worktrees/ の下を指していれば、メインで pnpm exec lefthook install を実行する", () => {
    // given
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\n${worktreePath("agent-a3f2")}/node_modules/.pnpm/lefthook/bin/lefthook run pre-commit\n`,
    );

    // when
    runHook({ worktree_path: worktreePath("agent-a3f2"), cwd: repo });
    const lastCall = calls().at(-1);

    // then
    expect(lastCall).toBe(`${repo} pnpm exec lefthook install`);
  });

  it("共有フックがメインの node_modules を指していれば、lefthook install は実行しない", () => {
    // given
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\n${repo}/node_modules/.pnpm/lefthook/bin/lefthook run pre-commit\n`,
    );

    // when
    runHook({ worktree_path: worktreePath("agent-a3f2"), cwd: repo });
    const lefthookCalls = calls().filter((c) => c.includes("lefthook"));

    // then
    expect(lefthookCalls).toEqual([]);
  });

  it("WORKTREE_HOOK_DRY_RUN=1 なら実行予定を表示するだけで、docker も pnpm も呼ばない", () => {
    // given: 前提なし（beforeEach で空の git リポジトリと偽の docker / pnpm がある）
    // when
    const result = runHook(
      { worktree_path: worktreePath("agent-a3f2"), cwd: repo },
      { WORKTREE_HOOK_DRY_RUN: "1" },
    );

    // then
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      `[dry-run] (cd ${repo} && ${PSQL} "drop database if exists app_wt_agent_a3f2 with (force)")`,
      `[dry-run] (cd ${repo} && pnpm exec lefthook install) if .git/hooks/pre-commit points into .claude/worktrees/`,
    ]);
    expect(calls()).toEqual([]);
  });
});

describe("worktree-remove.sh（失敗しても worktree の削除を止めない）", () => {
  it("docker が失敗しても 0 で終わり、stderr に DB 名を出す", () => {
    // given: 前提なし（beforeEach で空の git リポジトリがあり、偽の docker を失敗させる）
    // when
    const result = runHook(
      { worktree_path: worktreePath("agent-a3f2"), cwd: repo },
      { FAKE_DOCKER_EXIT: "1" },
    );

    // then
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("app_wt_agent_a3f2");
  });

  // 入力はテストの中で作る（base は beforeEach で決まるため、it.each の表を読み込む時点では使えない）。
  it.each([
    ["worktree_path が無い", () => JSON.stringify({ cwd: repo })],
    [
      "worktree_path が .claude/worktrees/ の下でない（このフックが作った worktree でない）",
      () =>
        JSON.stringify({
          cwd: repo,
          worktree_path: join(base, "elsewhere", "x"),
        }),
    ],
    ["JSON でない", () => "not json"],
  ])(
    "%s ときは何もせずに 0 で終わる（関係のない DB を消さない）",
    (_, input) => {
      // given: it.each の input（フックが対象にしない入力）
      // when
      const result = spawnSync("bash", [hookPath], {
        input: input(),
        encoding: "utf8",
        env: childEnv({
          PATH: `${bin}:${process.env.PATH}`,
          CALL_LOG: callLog,
        }),
      });

      // then
      expect(result.status).toBe(0);
      expect(calls()).toEqual([]);
    },
  );
});

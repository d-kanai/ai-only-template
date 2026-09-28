// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom だが、このテストは bash / git を子プロセスで起動するだけで DOM を使わない。
//
// scripts/hooks/subagent-stop.sh（SubagentStop フック）の仕様。サブエージェントの終了時に、
// - 共有の Git フック（.git/hooks/pre-commit・commit-msg）が worktree の lefthook を指していたら、メインの作業ツリーで
//   lefthook install を実行して直す（LEARNINGS.md の Issue #26 / #34 / #50 で手作業で直した事故）
// - pnpm-lock.yaml に未コミットの変更があれば警告する
// を確かめる。結果は {"systemMessage": "..."} で返し、止めない（block しない）。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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

const repoRoot = resolve(__dirname, "..", "..");
const scriptPath = join(repoRoot, "scripts", "hooks", "subagent-stop.sh");

// lefthook install の代わり。本物と同じく git の共通ディレクトリの hooks/pre-commit と commit-msg を書き直し、
// 中にカレントディレクトリの node_modules のパスを入れる。呼ばれたときのカレントディレクトリと引数を LEFTHOOK_LOG に残す。
// FAKE_LEFTHOOK_EXIT が 0 以外なら何もせずその値で終わる（修復の失敗を確かめるため）。
const FAKE_LEFTHOOK = `#!/bin/bash
echo "$PWD $*" >> "$LEFTHOOK_LOG"
if [ "\${FAKE_LEFTHOOK_EXIT:-0}" != "0" ]; then echo "fake lefthook failed" >&2; exit "$FAKE_LEFTHOOK_EXIT"; fi
hooks="$(git rev-parse --git-common-dir)/hooks"
for name in pre-commit commit-msg; do
  printf '#!/bin/sh\\n%s/node_modules/.pnpm/lefthook-linux-x64@2.1.12/node_modules/lefthook-linux-x64/bin/lefthook run "%s"\\n' "$PWD" "$name" > "$hooks/$name"
done
`;

// lefthook が書くフックのうち、パスを含む行だけを再現する。
const hookPointingTo = (dir: string, name = "pre-commit") =>
  `#!/bin/sh\n  elif ${dir}/node_modules/.pnpm/lefthook-linux-x64@2.1.12/node_modules/lefthook-linux-x64/bin/lefthook -h >/dev/null 2>&1\n  then\n    ${dir}/node_modules/.pnpm/lefthook-linux-x64@2.1.12/node_modules/lefthook-linux-x64/bin/lefthook run "${name}"\n`;

let dir: string;
let mainRepo: string;
let worktree: string;
let outsideWorktree: string;
let lefthookLog: string;

function git(cwd: string, args: string[]) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

beforeEach(() => {
  // WHY 一時ディレクトリ: 本物の .git/hooks（全 worktree で共有）に触れないよう、使い捨てのリポジトリで確かめる。
  // WHY realpath: macOS の /var → /private/var のようにシンボリックリンクを挟むと、フックの中のパスと比べられないため。
  dir = realpathSync(mkdtempSync(join(tmpdir(), "subagent-stop-test-")));
  mainRepo = join(dir, "main");
  worktree = join(mainRepo, ".claude", "worktrees", "agent-1");
  outsideWorktree = join(dir, "main-wt-64");
  lefthookLog = join(dir, "lefthook.log");
  mkdirSync(mainRepo);
  git(mainRepo, ["init", "-q", "-b", "main"]);
  writeFileSync(join(mainRepo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(
    join(mainRepo, ".gitignore"),
    ".claude/worktrees/\nnode_modules/\n",
  );
  git(mainRepo, ["add", "."]);
  git(mainRepo, ["commit", "-q", "-m", "init"]);
  git(mainRepo, ["worktree", "add", "-q", "-b", "agent-1", worktree]);
  git(mainRepo, ["worktree", "add", "-q", "-b", "wt-64", outsideWorktree]);
  const bin = join(mainRepo, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "lefthook"), FAKE_LEFTHOOK);
  chmodSync(join(bin, "lefthook"), 0o755);
  writeHook("pre-commit", hookPointingTo(mainRepo));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeHook(name: string, content: string) {
  const file = join(mainRepo, ".git", "hooks", name);
  writeFileSync(file, content);
  chmodSync(file, 0o755);
}

function readHook(name: string) {
  return readFileSync(join(mainRepo, ".git", "hooks", name), "utf8");
}

function run(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const input = {
    session_id: "s",
    transcript_path: "/dev/null",
    cwd,
    hook_event_name: "SubagentStop",
    stop_hook_active: false,
    agent_id: "a",
    agent_type: "worker",
    last_assistant_message: "done",
  };
  return spawnSync("bash", [scriptPath], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, LEFTHOOK_LOG: lefthookLog, ...env },
  });
}

function systemMessage(result: ReturnType<typeof run>): string {
  expect(result.status, result.stderr).toBe(0);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  // WHY block しないことも確かめる: 止めてもサブエージェントには直せない（共有フックの修復はメインで行う）ため。
  expect(Object.keys(output)).toEqual(["systemMessage"]);
  return output.systemMessage as string;
}

function lefthookCalls(): string[] {
  return existsSync(lefthookLog)
    ? readFileSync(lefthookLog, "utf8").trim().split("\n")
    : [];
}

describe("何も問題がないとき", () => {
  it("共有フックがメインを指し、lockfile に変更がなければ何も出さず、lefthook install も呼ばない", () => {
    const result = run(mainRepo);
    expect([result.status, result.stdout]).toEqual([0, ""]);
    expect(lefthookCalls()).toEqual([]);
  });

  it("共有フックが無いときも何も出さない", () => {
    rmSync(join(mainRepo, ".git", "hooks", "pre-commit"));
    const result = run(worktree);
    expect([result.status, result.stdout]).toEqual([0, ""]);
    expect(lefthookCalls()).toEqual([]);
  });

  it("git リポジトリの外で呼ばれたら何も出さない", () => {
    const result = run(dir);
    expect([result.status, result.stdout]).toEqual([0, ""]);
  });

  it("入力が JSON でなければ何も出さず exit 0（stderr に理由）", () => {
    const result = spawnSync("bash", [scriptPath], {
      input: "not json",
      encoding: "utf8",
      env: { ...process.env, LEFTHOOK_LOG: lefthookLog },
    });
    expect([result.status, result.stdout]).toEqual([0, ""]);
    expect(result.stderr).toContain("subagent-stop");
  });
});

describe("共有フックが worktree を指しているとき", () => {
  it.each([
    [".claude/worktrees の下の worktree", () => worktree],
    [
      "リポジトリの外の worktree（パスに worktrees を含まない）",
      () => outsideWorktree,
    ],
  ])(
    "pre-commit が %s を指していれば、メインで lefthook install を実行して直す",
    (_label, target) => {
      writeHook("pre-commit", hookPointingTo(target()));
      const message = systemMessage(run(worktree));
      expect(lefthookCalls()).toEqual([`${mainRepo} install`]);
      expect(readHook("pre-commit")).toContain(`${mainRepo}/node_modules/`);
      expect(readHook("pre-commit")).not.toContain(target());
      expect(message).toContain("pre-commit");
      expect(message).toContain(target());
      expect(message).toContain("直しました");
    },
  );

  it("commit-msg だけが worktree を指していても直す", () => {
    writeHook("commit-msg", hookPointingTo(worktree, "commit-msg"));
    const message = systemMessage(run(mainRepo));
    expect(lefthookCalls()).toEqual([`${mainRepo} install`]);
    expect(readHook("commit-msg")).not.toContain(worktree);
    expect(message).toContain("commit-msg");
  });

  it("lefthook install が失敗したら、直せなかったことと手順を返す（exit 0）", () => {
    writeHook("pre-commit", hookPointingTo(worktree));
    const message = systemMessage(run(worktree, { FAKE_LEFTHOOK_EXIT: "3" }));
    expect(message).toContain("直せませんでした");
    expect(message).toContain("pnpm exec lefthook install");
    expect(readHook("pre-commit")).toContain(worktree);
  });

  it("node_modules/.bin/lefthook が無ければ pnpm exec lefthook install を使う", () => {
    writeHook("pre-commit", hookPointingTo(worktree));
    rmSync(join(mainRepo, "node_modules"), { recursive: true });
    const fakePnpmDir = join(dir, "fake-bin");
    mkdirSync(fakePnpmDir);
    writeFileSync(
      join(fakePnpmDir, "pnpm"),
      `#!/bin/bash\necho "$PWD pnpm $*" >> "$LEFTHOOK_LOG"\n`,
    );
    chmodSync(join(fakePnpmDir, "pnpm"), 0o755);
    systemMessage(
      run(worktree, { PATH: `${fakePnpmDir}:${process.env.PATH}` }),
    );
    expect(lefthookCalls()).toEqual([`${mainRepo} pnpm exec lefthook install`]);
  });
});

describe("pnpm-lock.yaml に未コミットの変更があるとき", () => {
  it("サブエージェントの作業ツリー（worktree）の lockfile の変更を警告する", () => {
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "changed\n");
    const message = systemMessage(run(worktree));
    expect(message).toContain("pnpm-lock.yaml");
    expect(message).toContain(worktree);
    expect(lefthookCalls()).toEqual([]);
  });

  it("メインの作業ツリーの lockfile の変更も警告する", () => {
    writeFileSync(join(mainRepo, "pnpm-lock.yaml"), "changed\n");
    const message = systemMessage(run(worktree));
    expect(message).toContain(`${mainRepo}/pnpm-lock.yaml`);
  });

  it("フックの修復と lockfile の警告を 1 つのメッセージにまとめる", () => {
    writeHook("pre-commit", hookPointingTo(worktree));
    writeFileSync(join(worktree, "pnpm-lock.yaml"), "changed\n");
    const message = systemMessage(run(worktree));
    expect(message).toContain("直しました");
    expect(message).toContain("pnpm-lock.yaml");
  });
});

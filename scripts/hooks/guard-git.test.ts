// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom だが、このテストは bash を子プロセスで起動するだけで DOM を使わない。
//
// scripts/hooks/guard-git.sh（PreToolUse フック）の仕様。ルール検査テスト（.claude/rules/git-guard.md）なので、
// deny される例（must reject）と通す例（must pass）を境界のケースまで両方持つ。
// フックとしての起動は Claude Code がするので、ここでは Claude Code と同じ形の JSON を stdin に渡してスクリプトを直接実行し、
// stdout の JSON（deny）か、何も出さない（許可）かを見る。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const scriptPath = join(repoRoot, "scripts", "hooks", "guard-git.sh");

type HookInput = {
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd: string;
  agent_type?: string | null;
  agent_id?: string;
};

type Decision = { denied: boolean; reason: string; stderr: string };

function runGuard(input: unknown, env: NodeJS.ProcessEnv = process.env) {
  // WHY /bin/bash を絶対パスで呼ぶ: node が無い環境のテストで PATH を空にするため（PATH から bash を探させない）。
  return spawnSync("/bin/bash", [scriptPath], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env,
  });
}

function decide(input: HookInput): Decision {
  const result = runGuard(input);
  // WHY exit 0 を必ず確かめる: 拒否は JSON（permissionDecision: "deny"）で返す約束。exit 2 など別の終わり方をすると、
  //   Claude Code の扱い（stderr を理由にする）が変わり、許可のときに exit 非 0 だとフックのエラーとして表示される。
  expect(result.status, result.stderr).toBe(0);
  if (result.stdout.trim() === "") {
    return { denied: false, reason: "", stderr: result.stderr };
  }
  const output = JSON.parse(result.stdout) as {
    hookSpecificOutput: {
      hookEventName: string;
      permissionDecision: string;
      permissionDecisionReason: string;
    };
  };
  expect(output.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
  return {
    denied: true,
    reason: output.hookSpecificOutput.permissionDecisionReason,
    stderr: result.stderr,
  };
}

function git(cwd: string, args: string[]) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
}

// カレントブランチで判定する規則（main での commit / merge など）のために、一時ディレクトリに git リポジトリを 2 つ作る。
// WHY 一時ディレクトリ: リポジトリの中に作ると、テストが途中で落ちたときに作業ツリーへ残る（rules の「ルール検査テスト」）。
// WHY コミットを作らない（unborn のまま）: git init 直後でもカレントブランチを判定できることを確かめるため
//   （rev-parse --abbrev-ref HEAD は unborn だと失敗する）。
let workDir: string;
let mainRepo: string;
let featureRepo: string;
let notRepo: string;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "guard-git-test-"));
  mainRepo = join(workDir, "main-repo");
  featureRepo = join(workDir, "feature-repo");
  notRepo = join(workDir, "not-a-repo");
  git(workDir, ["init", "-q", "-b", "main", mainRepo]);
  git(workDir, ["init", "-q", "-b", "feat/1-x", featureRepo]);
  spawnSync("mkdir", ["-p", notRepo]);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const SUBAGENT = { agent_type: "worker", agent_id: "agent-123" };

function bash(
  command: string,
  cwd: () => string,
  agent: Partial<HookInput> = {},
) {
  return () =>
    decide({
      tool_name: "Bash",
      tool_input: { command },
      cwd: cwd(),
      ...agent,
    });
}

describe("サブエージェント（agent_type / agent_id がある）", () => {
  // WHY 文字列のどこにあっても拒否するか: `-C` / `bash -c` / `&&` の後ろは permissions.deny では塞げない（公式の permissions
  //   ドキュメント「What a rule doesn't match」、Issue #64 の実測）。フックはシェルの構文解析をせず、コマンド文字列全体から拾う。
  it.each([
    ["git commit -m x"],
    ["git -C /tmp/x commit -m x"],
    ["git -c user.name=x commit -m x"],
    ["git --git-dir=/tmp/x/.git commit -m x"],
    ["/usr/bin/git commit -m x"],
    ["bash -c 'git push'"],
    ['sh -c "git push origin feat"'],
    ["git 'push' origin feat"],
    ["ls && git push origin feat"],
    ["git status; git merge main"],
    ["true || git rebase main"],
    ["git add . | cat; git tag v1"],
    ["git reset --hard HEAD~1"],
    ["git reset -q --hard"],
    ["git checkout main"],
    ["git checkout -q main"],
    ["gh pr create --fill"],
    ["gh pr merge 12 --merge"],
    ["git \\\n  commit -m x"],
    ["(cd sub && git push)"],
    ["echo $(git commit -m x)"],
    // 誤検知として受け入れる例（.claude/rules/git-guard.md の「誤検知」）: 文字列の中の git commit も拒否する。
    ['echo "git commit -m x"'],
  ])("%s は拒否する", (command) => {
    const result = bash(command, () => featureRepo, SUBAGENT)();
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("サブエージェント");
  });

  it.each([
    ["git status"],
    ["git diff --stat"],
    ["git log --oneline -5"],
    ["git show HEAD:main.ts"],
    ["git merge-base HEAD main"],
    ["git commit-graph verify"],
    ["git checkout -b feat/2-y"],
    ["git checkout -- file.ts"],
    ["git reset --soft HEAD~1"],
    ["git stash list"],
    ["git branch --show-current"],
    ["cat .git/HEAD"],
    ["gh pr view 12"],
    ["gh pr list"],
    ["pnpm test"],
  ])("%s は許可する", (command) => {
    expect(bash(command, () => featureRepo, SUBAGENT)().denied).toBe(false);
  });

  it("agent_id だけがあってもサブエージェントとして拒否する", () => {
    const result = bash("git commit -m x", () => featureRepo, {
      agent_id: "agent-123",
    })();
    expect(result.denied).toBe(true);
  });

  it("agent_type だけがあってもサブエージェントとして拒否する", () => {
    const result = bash("git commit -m x", () => featureRepo, {
      agent_type: "worker",
    })();
    expect(result.denied).toBe(true);
  });

  it.each([
    ["mcp__github__create_pull_request"],
    ["mcp__github__merge_pull_request"],
    ["mcp__github__push_files"],
    ["mcp__github__create_or_update_file"],
    ["mcp__github__delete_file"],
    ["mcp__github__update_pull_request_branch"],
  ])("MCP の書き込みツール %s は拒否する", (toolName) => {
    const result = decide({
      tool_name: toolName,
      tool_input: { owner: "o", repo: "r", branch: "feat/1-x" },
      cwd: featureRepo,
      ...SUBAGENT,
    });
    expect(result.denied).toBe(true);
    expect(result.reason).toContain(toolName);
  });

  it.each([
    ["mcp__github__get_me"],
    ["mcp__github__pull_request_read"],
    ["Read"],
  ])("書き込みでないツール %s は許可する", (toolName) => {
    const result = decide({
      tool_name: toolName,
      tool_input: {},
      cwd: featureRepo,
      ...SUBAGENT,
    });
    expect(result.denied).toBe(false);
  });
});

describe("メイン（agent_type / agent_id が無い）", () => {
  const MAIN_AGENTS: Array<[string, Partial<HookInput>]> = [
    ["agent_type が無い", {}],
    ["agent_type が null", { agent_type: null }],
    ["agent_type が空文字", { agent_type: "" }],
  ];

  describe.each(MAIN_AGENTS)("%s", (_label, agent) => {
    it("feature ブランチでの git commit は許可する", () => {
      expect(bash("git commit -m x", () => featureRepo, agent)().denied).toBe(
        false,
      );
    });

    it("main での git commit は拒否する", () => {
      const result = bash("git commit -m x", () => mainRepo, agent)();
      expect(result.denied).toBe(true);
      expect(result.reason).toContain("main");
    });

    it("git push --force は拒否する", () => {
      expect(
        bash("git push --force origin feat", () => featureRepo, agent)().denied,
      ).toBe(true);
    });
  });

  describe("git push", () => {
    it.each([
      ["git push --force"],
      ["git push --force origin feat/1-x"],
      ["git push -f origin feat/1-x"],
      ["git push -fu origin feat/1-x"],
      ["git push -uf origin feat/1-x"],
      ["git push --force-with-lease origin feat/1-x"],
      ["git push --force-with-lease=feat/1-x origin feat/1-x"],
      ["git push --force-if-includes origin feat/1-x"],
      ["git push origin +feat/1-x"],
      ["git push origin main"],
      ["git push -u origin main"],
      ["git push origin HEAD:main"],
      ["git push origin feat/1-x:main"],
      ["git push origin HEAD:refs/heads/main"],
      ["git push origin :main"],
      ["git push origin --delete main"],
      ["git push -d origin main"],
      ["git -C /tmp/x push origin main"],
      ["cd x && git push origin main"],
      ["bash -c 'git push origin main'"],
      ["git push --no-verify origin feat/1-x"],
    ])("%s は拒否する", (command) => {
      expect(bash(command, () => featureRepo)().denied).toBe(true);
    });

    it.each([
      ["git push"],
      ["git push origin feat/1-x"],
      ["git push -u origin feat/1-x"],
      ["git push -u origin HEAD"],
      ["git push origin feat/1-x:feat/1-x"],
      ["git push origin --delete feat/1-x"],
      ["git push origin maintenance"],
      ["git push origin main-feature"],
      ["git push --follow-tags origin feat/1-x"],
      ["git pull origin main"],
      ["git fetch origin main"],
      ["git log main..HEAD"],
    ])("%s は許可する", (command) => {
      expect(bash(command, () => featureRepo)().denied).toBe(false);
    });

    it("main で引数なしの git push は拒否する（プッシュ先がカレントブランチ = main になるため）", () => {
      expect(bash("git push", () => mainRepo)().denied).toBe(true);
      expect(bash("git push origin", () => mainRepo)().denied).toBe(true);
      expect(bash("git push -u origin", () => mainRepo)().denied).toBe(true);
      expect(bash("git push -u origin HEAD", () => mainRepo)().denied).toBe(
        true,
      );
    });

    it("main でもプッシュ先を明示した feature ブランチへの git push は許可する", () => {
      expect(bash("git push origin feat/1-x", () => mainRepo)().denied).toBe(
        false,
      );
    });
  });

  describe("git commit / git merge", () => {
    it.each([
      ["git commit -m x", () => mainRepo],
      ["git commit --amend --no-edit", () => mainRepo],
      ["git merge feat/1-x", () => mainRepo],
      ["git merge --no-ff feat/1-x", () => mainRepo],
      // -C の先のブランチで判定する（cwd は feature のリポジトリ）。
      ["git -C MAIN commit -m x", () => featureRepo],
      ["git commit --no-verify -m x", () => featureRepo],
      ["git commit -n -m x", () => featureRepo],
      ["git commit -anm x", () => featureRepo],
      ["git commit -qn -m x", () => featureRepo],
      ["LEFTHOOK=0 git commit -m x", () => featureRepo],
      ["LEFTHOOK=false git commit -m x", () => featureRepo],
      ["export LEFTHOOK=0 && git commit -m x", () => featureRepo],
      ["git merge --squash feat/2-y", () => featureRepo],
    ])("%s は拒否する", (command, cwd) => {
      const resolved = command.replace("MAIN", mainRepo);
      expect(bash(resolved, cwd)().denied).toBe(true);
    });

    it.each([
      ["git commit -m x", () => featureRepo],
      ["git commit -F /tmp/msg.txt", () => featureRepo],
      ["git commit -am x", () => featureRepo],
      // -m の直後の文字はメッセージ（-mnew は "new" というメッセージ）なので、n があっても --no-verify ではない。
      ["git commit -mnew", () => featureRepo],
      ["git merge main", () => featureRepo],
      ["git merge --no-ff origin/main", () => featureRepo],
      ["git -C FEATURE commit -m x", () => mainRepo],
      ["git checkout main", () => featureRepo],
      ["git pull", () => mainRepo],
      ["git branch -d feat/1-x", () => mainRepo],
      ["git status", () => mainRepo],
      ["git log --oneline", () => mainRepo],
      // git リポジトリでない場所ではカレントブランチが分からないので判定しない。
      ["git commit -m x", () => notRepo],
    ])("%s は許可する", (command, cwd) => {
      const resolved = command.replace("FEATURE", featureRepo);
      expect(bash(resolved, cwd)().denied).toBe(false);
    });
  });

  describe("gh / MCP のマージ", () => {
    it.each([
      ["gh pr merge 12 --squash"],
      ["gh pr merge 12 -s"],
      ["gh pr merge 12 --rebase"],
      ["gh pr merge 12 -r"],
    ])("%s は拒否する", (command) => {
      expect(bash(command, () => featureRepo)().denied).toBe(true);
    });

    it.each([
      ["gh pr merge 12 --merge"],
      ["gh pr create --fill --label chore"],
    ])("%s は許可する", (command) => {
      expect(bash(command, () => featureRepo)().denied).toBe(false);
    });

    it.each([["squash"], ["rebase"]])(
      "merge_pull_request の merge_method が %s なら拒否する",
      (method) => {
        const result = decide({
          tool_name: "mcp__github__merge_pull_request",
          tool_input: { pullNumber: 1, merge_method: method },
          cwd: featureRepo,
        });
        expect(result.denied).toBe(true);
      },
    );

    it("merge_pull_request の merge_method が merge なら許可する", () => {
      const result = decide({
        tool_name: "mcp__github__merge_pull_request",
        tool_input: { pullNumber: 1, merge_method: "merge" },
        cwd: featureRepo,
      });
      expect(result.denied).toBe(false);
    });

    it.each([
      ["mcp__github__push_files"],
      ["mcp__github__create_or_update_file"],
      ["mcp__github__delete_file"],
    ])("%s で branch が main なら拒否し、feature なら許可する", (toolName) => {
      const toMain = decide({
        tool_name: toolName,
        tool_input: { branch: "main" },
        cwd: featureRepo,
      });
      const toFeature = decide({
        tool_name: toolName,
        tool_input: { branch: "feat/1-x" },
        cwd: featureRepo,
      });
      expect([toMain.denied, toFeature.denied]).toEqual([true, false]);
    });

    it("create_pull_request は許可する", () => {
      const result = decide({
        tool_name: "mcp__github__create_pull_request",
        tool_input: { head: "feat/1-x", base: "main" },
        cwd: featureRepo,
      });
      expect(result.denied).toBe(false);
    });
  });
});

describe("入力を読めないとき", () => {
  it("JSON でない入力は拒否せず（exit 0・stdout なし）、stderr に理由を出す", () => {
    const result = runGuard("not json");
    expect([result.status, result.stdout]).toEqual([0, ""]);
    expect(result.stderr).toContain("guard-git");
  });

  it("node が無いときは拒否せず（exit 0・stdout なし）、stderr に理由を出す", () => {
    const result = runGuard(
      {
        tool_name: "Bash",
        tool_input: { command: "git push --force" },
        cwd: featureRepo,
      },
      { PATH: join(workDir, "no-such-bin") },
    );
    expect([result.status, result.stdout]).toEqual([0, ""]);
    expect(result.stderr).toContain("node");
  });

  it("command が無い Bash の入力は許可する", () => {
    const result = decide({
      tool_name: "Bash",
      tool_input: {},
      cwd: featureRepo,
    });
    expect(result.denied).toBe(false);
  });
});

// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom だが、このテストは bash を子プロセスで起動するだけで DOM を使わない。
//
// scripts/hooks/guard-git.sh（PreToolUse フック）の仕様。ルール検査テスト（.claude/rules/tooling/git-guard.md）なので、
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
    // 誤検知として受け入れる例（.claude/rules/tooling/git-guard.md の「誤検知」）: 文字列の中の git commit も拒否する。
    ['echo "git commit -m x"'],
  ])("%s は拒否する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo, SUBAGENT)();

    // then
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
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo, SUBAGENT)();

    // then
    expect(result.denied).toBe(false);
  });

  it("agent_id だけがあってもサブエージェントとして拒否する", () => {
    // given: 前提なし（agent_id だけを渡す）
    // when
    const result = bash("git commit -m x", () => featureRepo, {
      agent_id: "agent-123",
    })();

    // then
    expect(result.denied).toBe(true);
  });

  it("agent_type だけがあってもサブエージェントとして拒否する", () => {
    // given: 前提なし（agent_type だけを渡す）
    // when
    const result = bash("git commit -m x", () => featureRepo, {
      agent_type: "worker",
    })();

    // then
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
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = decide({
      tool_name: toolName,
      tool_input: { owner: "o", repo: "r", branch: "feat/1-x" },
      cwd: featureRepo,
      ...SUBAGENT,
    });

    // then
    expect(result.denied).toBe(true);
    expect(result.reason).toContain(toolName);
  });

  it.each([
    ["mcp__github__get_me"],
    ["mcp__github__pull_request_read"],
    ["Read"],
  ])("書き込みでないツール %s は許可する", (toolName) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = decide({
      tool_name: toolName,
      tool_input: {},
      cwd: featureRepo,
      ...SUBAGENT,
    });

    // then
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
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash("git commit -m x", () => featureRepo, agent)();

      // then
      expect(result.denied).toBe(false);
    });

    it("main での git commit は拒否する", () => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash("git commit -m x", () => mainRepo, agent)();

      // then
      expect(result.denied).toBe(true);
      expect(result.reason).toContain("main");
    });

    it("git push --force は拒否する", () => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash(
        "git push --force origin feat",
        () => featureRepo,
        agent,
      )();

      // then
      expect(result.denied).toBe(true);
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
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash(command, () => featureRepo)();

      // then
      expect(result.denied).toBe(true);
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
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash(command, () => featureRepo)();

      // then
      expect(result.denied).toBe(false);
    });

    it("main で引数なしの git push は拒否する（プッシュ先がカレントブランチ = main になるため）", () => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash("git push", () => mainRepo)();

      // then
      expect(result.denied).toBe(true);
      expect(bash("git push origin", () => mainRepo)().denied).toBe(true);
      expect(bash("git push -u origin", () => mainRepo)().denied).toBe(true);
      expect(bash("git push -u origin HEAD", () => mainRepo)().denied).toBe(
        true,
      );
    });

    it("main でもプッシュ先を明示した feature ブランチへの git push は許可する", () => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash("git push origin feat/1-x", () => mainRepo)();

      // then
      expect(result.denied).toBe(false);
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
      // given
      const resolved = command.replace("MAIN", mainRepo);
      // when
      const result = bash(resolved, cwd)();

      // then
      expect(result.denied).toBe(true);
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
      // given
      const resolved = command.replace("FEATURE", featureRepo);
      // when
      const result = bash(resolved, cwd)();

      // then
      expect(result.denied).toBe(false);
    });
  });

  describe("gh / MCP のマージ", () => {
    it.each([
      ["gh pr merge 12 --squash"],
      ["gh pr merge 12 -s"],
      ["gh pr merge 12 --rebase"],
      ["gh pr merge 12 -r"],
    ])("%s は拒否する", (command) => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash(command, () => featureRepo)();

      // then
      expect(result.denied).toBe(true);
    });

    it.each([
      ["gh pr merge 12 --merge"],
      ["gh pr create --fill --label chore"],
    ])("%s は許可する", (command) => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash(command, () => featureRepo)();

      // then
      expect(result.denied).toBe(false);
    });

    it.each([["squash"], ["rebase"]])(
      "merge_pull_request の merge_method が %s なら拒否する",
      (method) => {
        // given: 前提なし（リポジトリは beforeAll で作成済み）
        // when
        const result = decide({
          tool_name: "mcp__github__merge_pull_request",
          tool_input: { pullNumber: 1, merge_method: method },
          cwd: featureRepo,
        });

        // then
        expect(result.denied).toBe(true);
      },
    );

    it("merge_pull_request の merge_method が merge なら許可する", () => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = decide({
        tool_name: "mcp__github__merge_pull_request",
        tool_input: { pullNumber: 1, merge_method: "merge" },
        cwd: featureRepo,
      });

      // then
      expect(result.denied).toBe(false);
    });

    it.each([
      ["mcp__github__push_files"],
      ["mcp__github__create_or_update_file"],
      ["mcp__github__delete_file"],
    ])("%s で branch が main なら拒否し、feature なら許可する", (toolName) => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
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

      // then
      expect([toMain.denied, toFeature.denied]).toEqual([true, false]);
    });

    it("create_pull_request は許可する", () => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = decide({
        tool_name: "mcp__github__create_pull_request",
        tool_input: { head: "feat/1-x", base: "main" },
        cwd: featureRepo,
      });

      // then
      expect(result.denied).toBe(false);
    });
  });
});

describe("入力を読めないとき", () => {
  it("JSON でない入力は拒否せず（exit 0・stdout なし）、stderr に理由を出す", () => {
    // given: 前提なし（JSON でない文字列を渡す）
    // when
    const result = runGuard("not json");

    // then
    expect([result.status, result.stdout]).toEqual([0, ""]);
    expect(result.stderr).toContain("guard-git");
  });

  it("node が無いときは拒否せず（exit 0・stdout なし）、stderr に理由を出す", () => {
    // given: 前提なし（PATH から node を見つけられなくする）
    // when
    const result = runGuard(
      {
        tool_name: "Bash",
        tool_input: { command: "git push --force" },
        cwd: featureRepo,
      },
      // WHY process.env を展開する: 型（Next の型定義で NODE_ENV が必須）を満たすため。node を見つけられなくするのは PATH だけで足りる。
      { ...process.env, PATH: join(workDir, "no-such-bin") },
    );

    // then
    expect([result.status, result.stdout]).toEqual([0, ""]);
    expect(result.stderr).toContain("node");
  });

  it("command が無い Bash の入力は許可する", () => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = decide({
      tool_name: "Bash",
      tool_input: {},
      cwd: featureRepo,
    });

    // then
    expect(result.denied).toBe(false);
  });
});

// reviewer の指摘（Issue #64）で足したケース。見逃す書き方（must reject）と、似ているが危険でない書き方（must pass）を並べる。
describe("長いオプションの省略形（git は一意な接頭辞を受け付ける）", () => {
  // 最短の接頭辞の根拠（git 2.43.0 の builtin/commit.c・push.c・merge.c のオプション定義）:
  // - --no-v: commit / push / merge の --no-verify。--no-v〜--no-ver は --no-verbose とも一致して git では曖昧（エラー）に
  //   なるが、止めても害はないので止める側に倒す。--no-veri から --no-verify に決まる。
  // - --for: push の --force / --force-with-lease / --force-if-includes（--fo は --follow-tags と曖昧）。
  // - --m: push の --mirror（push に m で始まるオプションはほかに無い）。
  // - --sq: merge の --squash（--s は --stat / --summary / --strategy / --signoff と曖昧）。
  it.each([
    ["git commit --no-verif -m x"],
    ["git commit --no-veri -m x"],
    ["git commit --no-v -m x"],
    ["git merge --no-verif main"],
    ["git push --no-verif origin feat/1-x"],
    ["git push --forc origin feat/1-x"],
    ["git push --for origin feat/1-x"],
    ["git push --force-with-l origin feat/1-x"],
    ["git push --force-w=feat/1-x origin feat/1-x"],
    ["git push --force-if origin feat/1-x"],
    ["git push --mirror"],
    ["git push --mirr origin"],
    ["git push --m origin"],
    ["git merge --squas feat/2-y"],
    ["git merge --sq feat/2-y"],
  ])("%s は拒否する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo)();

    // then
    expect(result.denied).toBe(true);
  });

  it.each([
    ["git commit --no-verb -m x"],
    ["git commit --no-edit"],
    ["git commit --verbose -m x"],
    ["git merge --no-verify-signatures main"],
    ["git merge --stat main"],
    ["git merge --strategy=ort main"],
    ["git merge --st main"],
    ["git push --fol origin feat/1-x"],
    ["git push --follow-tags origin feat/1-x"],
    ["git push --dry-run origin feat/1-x"],
    ["git log --no-walk"],
    // 最短の接頭辞より短いもの。git では複数のオプションに当たって曖昧（エラー。git 2.43.0 の parse-options.c）になり、
    // 危険なオプションとしては動かないので止めない（最短の接頭辞を短くしすぎていないことの確認）。
    ["git commit --no- -m x"],
    ["git merge --s main"],
    ["git push --fo origin feat/1-x"],
    ["git push --a origin feat/1-x"],
  ])("%s は許可する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo)();

    // then
    expect(result.denied).toBe(false);
  });
});

describe("フックを飛ばす設定と環境変数", () => {
  it.each([
    ["git -c core.hooksPath=/dev/null commit -m x"],
    ["git -c core.hookspath=/tmp/x commit -m x"],
    ["git --config-env=core.hooksPath=HOOKS commit -m x"],
    ["git config core.hooksPath /tmp/empty"],
    ['GIT_CONFIG_PARAMETERS="core.hooksPath=/x" git commit -m x'],
    // 誤検知として受け入れる例: 読むだけでも core.hooksPath という文字列があれば拒否する。
    ["git config --get core.hooksPath"],
    ["LEFTHOOK_EXCLUDE=biome git commit -m x"],
    ["export LEFTHOOK_EXCLUDE=biome"],
    ["LEFTHOOK_BIN=true git commit -m x"],
    ["LEFTHOOK_CONFIG=/tmp/empty.yml git commit -m x"],
  ])("%s は拒否する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo)();

    // then
    expect(result.denied).toBe(true);
  });

  it.each([
    ["git -c color.ui=never commit -m x"],
    ["git config --get core.editor"],
    ["LEFTHOOK_VERBOSE=1 git commit -m x"],
    ["LEFTHOOK_OUTPUT=summary git commit -m x"],
  ])("%s は許可する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo)();

    // then
    expect(result.denied).toBe(false);
  });
});

describe("gh pr merge の書き方（pflag は省略形を受け付けないが、= の値と短いオプションの束は受け付ける）", () => {
  it.each([
    ["gh pr merge 12 --squash=true"],
    ["gh pr merge 12 --rebase=1"],
    ["gh pr merge 12 -sd"],
    ["gh pr merge 12 -ds"],
    ["gh pr merge 12 -rd"],
    ["gh pr merge 12 --delete-branch --squash"],
  ])("%s は拒否する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo)();

    // then
    expect(result.denied).toBe(true);
  });

  it.each([
    ["gh pr merge 12 --squash=false"],
    ["gh pr merge 12 -md"],
    ["gh pr merge 12 --merge --delete-branch"],
    // -t の値（件名）の中の s は -s ではない。
    ["gh pr merge 12 --merge -tsubject"],
  ])("%s は許可する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo)();

    // then
    expect(result.denied).toBe(false);
  });
});

describe("push のオプションの値を読み飛ばす", () => {
  // -o / --push-option の値をブランチ名として数えると、「リモートだけ（= カレントブランチへの push）」を見逃す。
  it.each([
    ["git push origin -o ci.skip"],
    ["git push origin --push-option ci.skip"],
    ["git push -o ci.skip"],
  ])("main で %s は拒否する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => mainRepo)();

    // then
    expect(result.denied).toBe(true);
  });

  it("feature で git push origin -o ci.skip は許可する", () => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash("git push origin -o ci.skip", () => featureRepo)();

    // then
    expect(result.denied).toBe(false);
  });
});

describe("コマンド置換・cd・--git-dir でブランチの場所が変わる書き方", () => {
  it.each([
    ["cd MAIN && git commit -m x"],
    ["cd MAIN; git merge feat/1-x"],
    ["pushd MAIN && git commit -m x"],
    ["git --git-dir=MAIN/.git commit -m x"],
    ["git --git-dir MAIN/.git commit -m x"],
  ])("feature から %s は拒否する（main のリポジトリで判定する）", (command) => {
    // given
    const resolved = command.replace("MAIN", mainRepo);
    // when
    const result = bash(resolved, () => featureRepo)();

    // then
    expect(result.denied).toBe(true);
  });

  it.each([
    ["cd FEATURE && git commit -m x"],
    ["git --git-dir=FEATURE/.git commit -m x"],
    ["cd FEATURE && git merge main"],
  ])("main から %s は許可する（feature のリポジトリで判定する）", (command) => {
    // given
    const resolved = command.replace("FEATURE", featureRepo);
    // when
    const result = bash(resolved, () => mainRepo)();

    // then
    expect(result.denied).toBe(false);
  });

  it("サブシェルの中の cd は、サブシェルを閉じた後のコマンドに効かない", () => {
    // given
    const outside = `(cd ${featureRepo}) && git commit -m x`;
    const inside = `(cd ${featureRepo} && git commit -m x)`;

    // when
    const denied = [
      bash(outside, () => mainRepo)().denied,
      bash(inside, () => mainRepo)().denied,
    ];

    // then
    expect(denied).toEqual([true, false]);
  });
});

describe("サブエージェントの追加の拒否", () => {
  it.each([
    ['git -C "$(pwd)" commit -m x'],
    ["git -C $(pwd) push"],
    ["git -C `pwd` commit -m x"],
    ["echo $(git -C $(pwd) commit -m x)"],
    ["git cherry-pick abc123"],
    ["git revert HEAD"],
    ["git am 0001.patch"],
    ["git pull"],
    ["git pull --rebase origin main"],
    ["git -c alias.ci=commit ci -m x"],
    ["git -c ALIAS.ci=commit ci -m x"],
    ["git config alias.ci commit"],
    ["git config --global alias.ci commit"],
  ])("%s は拒否する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo, SUBAGENT)();

    // then
    expect(result.denied).toBe(true);
    expect(result.reason).toContain("サブエージェント");
  });

  it.each([
    ["git -C $(pwd) status"],
    ["git -c color.ui=never log --oneline"],
    ["git config --get user.name"],
    ["git log --grep=alias.x"],
    ["git fetch origin"],
  ])("%s は許可する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo, SUBAGENT)();

    // then
    expect(result.denied).toBe(false);
  });
});

describe("同じコマンドの中でブランチを切り替えてから commit / merge する書き方", () => {
  it.each([
    ["git checkout main && git commit -m x"],
    ["git switch main; git merge feat/1-x"],
    ["git checkout -q main && git commit -m x"],
  ])(
    "feature から %s は拒否する（切り替えた後の main で判定する）",
    (command) => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash(command, () => featureRepo)();

      // then
      expect(result.denied).toBe(true);
    },
  );

  it.each([
    ["git checkout -b feat/2-y && git commit -m x"],
    ["git switch -c feat/2-y && git commit -m x"],
    ["git checkout main && git checkout -b feat/2-y && git commit -m x"],
  ])("main から %s は許可する（新しいブランチで判定する）", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => mainRepo)();

    // then
    expect(result.denied).toBe(false);
  });

  it("ブランチでないもの（ファイル）の checkout の後は、今のブランチで判定する", () => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(
      "git checkout -- x.ts && git commit -m x",
      () => mainRepo,
    )();

    // then
    expect(result.denied).toBe(true);
  });
});

describe("main を含みうる push", () => {
  it.each([
    ["git push --all origin"],
    ["git push --al origin"],
    ["git push --branches origin"],
    ["git push origin refs/heads/*:refs/heads/*"],
    ["git push origin *:*"],
  ])("%s は拒否する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo)();

    // then
    expect(result.denied).toBe(true);
  });

  it.each([["git push --atomic origin feat/1-x"], ["git push --tags origin"]])(
    "%s は許可する",
    (command) => {
      // given: 前提なし（リポジトリは beforeAll で作成済み）
      // when
      const result = bash(command, () => featureRepo)();

      // then
      expect(result.denied).toBe(false);
    },
  );
});

describe("サブエージェントの低レベルのコミット操作", () => {
  it.each([
    ["git commit-tree HEAD^{tree} -m x"],
    ["git update-ref refs/heads/main 0123abc"],
  ])("%s は拒否する", (command) => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash(command, () => featureRepo, SUBAGENT)();

    // then
    expect(result.denied).toBe(true);
  });

  it("git rev-parse HEAD は許可する", () => {
    // given: 前提なし（リポジトリは beforeAll で作成済み）
    // when
    const result = bash("git rev-parse HEAD", () => featureRepo, SUBAGENT)();

    // then
    expect(result.denied).toBe(false);
  });
});

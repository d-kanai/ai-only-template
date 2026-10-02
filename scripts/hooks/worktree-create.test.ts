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

// WorktreeCreate フック scripts/hooks/worktree-create.sh の仕様（Issue #64。.claude/rules/worktree.md）。
// 公式（https://code.claude.com/docs/en/hooks.md の WorktreeCreate）: stdin に JSON（name / cwd など）が渡り、command フックは
//   作った worktree のパスを stdout の最後の空でない行に出す。0 以外で終わると worktree の作成が失敗する。
const repoRoot = resolve(__dirname, "..", "..");
const hookPath = join(repoRoot, "scripts", "hooks", "worktree-create.sh");
const envScriptPath = join(repoRoot, "scripts", "worktree-env.sh");

const PSQL =
  "docker compose exec -T db psql -U app -d app -v ON_ERROR_STOP=1 -At -c";
const LIST_SQL =
  "select datname from pg_database where starts_with(datname, 'app_wt_') order by 1";

// 偽の docker: 呼ばれたカレントディレクトリと引数を CALL_LOG に 1 行ずつ記録する（pnpm と同じファイルにして順序も見る）。
// - FAKE_DOCKER_EXIT があれば、何もせずその値で終わる（デーモンが無い・DB が起動していない経路）。
// - 列挙の SQL には FAKE_DB_LIST をそのまま出す。存在確認の SQL には FAKE_DB_EXISTS=1 のときだけ 1 を出す。
// WHY 偽物にするか: 本物の docker / Postgres にデータベースを作ったり消したりしない（実機の確認は別に 1 度だけ行う）。
const FAKE_DOCKER = `#!/bin/bash
echo "$PWD docker $*" >> "$CALL_LOG"
if [ -n "\${FAKE_DOCKER_EXIT:-}" ]; then exit "$FAKE_DOCKER_EXIT"; fi
case "$*" in
  *"select datname from pg_database"*) printf '%b' "\${FAKE_DB_LIST:-}" ;;
  *"select 1 from pg_database"*) if [ "\${FAKE_DB_EXISTS:-0}" = 1 ]; then echo 1; fi ;;
esac
exit 0
`;

// 偽の pnpm: カレントディレクトリ・CI・その場所の .env の DATABASE_URL（無ければ none）・引数を CALL_LOG に記録する。
//   .env を書いてから db:migrate したか（worktree の DB を指しているか）と、install に CI=true を付けたかを確かめるため。
// FAKE_PNPM_EXIT（既定 0）で終わる。
const FAKE_PNPM = `#!/bin/bash
if [ -f .env ]; then db=$(grep '^DATABASE_URL=' .env | cut -d= -f2-); else db=none; fi
echo "$PWD CI=\${CI:-} env_db=$db pnpm $*" >> "$CALL_LOG"
exit "\${FAKE_PNPM_EXIT:-0}"
`;

const EXAMPLE = [
  "DATABASE_URL=postgresql://app:app@localhost:5432/app",
  "DATABASE_POOL_MAX=10",
  "E2E_PORT=3100",
  "",
].join("\n");

let base: string;
let repo: string;
let bin: string;
let callLog: string;

function git(args: string[], cwd = repo) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
  });
  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
}

// テストの子プロセスに渡す環境変数。
// WHY GIT_* と CI を消す: git のフックの中などで GIT_DIR が設定されていると、一時リポジトリではなく外のリポジトリを操作してしまう。
//   CI は GitHub Actions で true になっており、偽の pnpm の記録（CI=）が実行環境で変わるため。
function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("GIT_") ||
      key === "CI" ||
      key.startsWith("WORKTREE_HOOK_")
    ) {
      delete env[key];
    }
  }
  return { ...env, ...extra };
}

function runHook(
  input: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  return spawnSync("bash", [hookPath], {
    input: JSON.stringify({ hook_event_name: "WorktreeCreate", ...input }),
    encoding: "utf8",
    env: gitEnv({
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
  // realpath: macOS の /var → /private/var のように tmpdir が symlink を含むと、git の出すパスと比べられないため。
  base = realpathSync(mkdtempSync(join(tmpdir(), "worktree-create-")));
  repo = join(base, "repo");
  bin = join(base, "bin");
  callLog = join(base, "calls.log");
  mkdirSync(repo);
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), FAKE_DOCKER, { mode: 0o755 });
  writeFileSync(join(bin, "pnpm"), FAKE_PNPM, { mode: 0o755 });
  writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(repo, ".env.example"), EXAMPLE);
  git(["init", "-q", "-b", "main"]);
  git(["add", "."]);
  git([
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("worktree-create.sh（must pass: 作成）", () => {
  it("<メイン>/.claude/worktrees/<name> に <name> ブランチの worktree を作り、その絶対パスだけを stdout に出す", () => {
    // given: 前提なし（beforeEach で git リポジトリと偽の docker / pnpm がある）
    // when
    const result = runHook({ name: "agent-a3f2", cwd: repo });

    // then
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${worktreePath("agent-a3f2")}\n`);
    expect(git(["worktree", "list", "--porcelain"])).toContain(
      `worktree ${worktreePath("agent-a3f2")}\nHEAD`,
    );
    expect(
      git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        worktreePath("agent-a3f2"),
      ).trim(),
    ).toBe("agent-a3f2");
  });

  it("worktree の .env は、worktree の .env.example から worktree-env.sh で導いた内容になる（DB 名と E2E_PORT が worktree 用）", () => {
    // given: 前提なし（beforeEach で git リポジトリと偽の docker / pnpm がある）
    // when
    runHook({ name: "agent-a3f2", cwd: repo });
    const dotenv = readFileSync(
      join(worktreePath("agent-a3f2"), ".env"),
      "utf8",
    );
    const expected = spawnSync(
      "bash",
      [
        envScriptPath,
        "agent-a3f2",
        join(worktreePath("agent-a3f2"), ".env.example"),
      ],
      { encoding: "utf8" },
    ).stdout;

    // then
    expect(dotenv).toBe(expected);
    expect(dotenv).toContain(
      "DATABASE_URL=postgresql://app:app@localhost:5432/app_wt_agent_a3f2\n",
    );
    expect(dotenv).toContain("E2E_PORT=3616\n");
  });

  it("孤立 DB の列挙 → CI=true で install → DB の存在確認 → create database → .env の DB で migrate の順に呼ぶ（docker はメインで実行）", () => {
    // given
    const wt = worktreePath("agent-a3f2");

    // when
    runHook({ name: "agent-a3f2", cwd: repo });

    // then
    expect(calls()).toEqual([
      `${repo} ${PSQL} ${LIST_SQL}`,
      `${wt} CI=true env_db=none pnpm install --frozen-lockfile`,
      `${repo} ${PSQL} select 1 from pg_database where datname = 'app_wt_agent_a3f2'`,
      `${repo} ${PSQL} create database app_wt_agent_a3f2`,
      `${wt} CI= env_db=postgresql://app:app@localhost:5432/app_wt_agent_a3f2 pnpm db:migrate`,
    ]);
  });

  it("DB が既にあれば create database は呼ばず、migrate だけを行う", () => {
    // given: 前提なし（beforeEach で git リポジトリと偽の docker / pnpm がある）
    // when
    runHook({ name: "agent-a3f2", cwd: repo }, { FAKE_DB_EXISTS: "1" });
    const recorded = calls();

    // then
    expect(recorded.filter((c) => c.includes("create database"))).toEqual([]);
    expect(recorded.filter((c) => c.endsWith("pnpm db:migrate"))).toHaveLength(
      1,
    );
  });

  it("対応する worktree が無い app_wt_ の DB だけを drop し、ある worktree・作成中の worktree・形の違う名前は消さない", () => {
    // given
    runHook({ name: "keep-me", cwd: repo });
    rmSync(callLog);

    // when
    runHook(
      { name: "agent-a3f2", cwd: repo },
      {
        FAKE_DB_LIST:
          "app_wt_agent_a3f2\\napp_wt_gone\\napp_wt_keep_me\\napp_wt_bad-name\\napp_wt_x;drop\\n",
      },
    );
    const drops = calls().filter((c) => c.includes("drop database"));

    // then
    expect(drops).toEqual([
      `${repo} ${PSQL} drop database if exists app_wt_gone with (force)`,
    ]);
  });

  it("ディレクトリを消した worktree（git には登録が残る）の DB も孤立として drop する", () => {
    // given
    runHook({ name: "gone-dir", cwd: repo });
    rmSync(worktreePath("gone-dir"), { recursive: true, force: true });
    rmSync(callLog);

    // when
    runHook(
      { name: "agent-a3f2", cwd: repo },
      { FAKE_DB_LIST: "app_wt_gone_dir\\n" },
    );
    const drops = calls().filter((c) => c.includes("drop database"));

    // then
    expect(drops).toEqual([
      `${repo} ${PSQL} drop database if exists app_wt_gone_dir with (force)`,
    ]);
  });

  it("同じ name で 2 回呼ぶと、既存の worktree をそのまま使って同じパスを返す", () => {
    // given
    runHook({ name: "agent-a3f2", cwd: repo });

    // when
    const second = runHook({ name: "agent-a3f2", cwd: repo });

    // then
    expect(second.status).toBe(0);
    expect(second.stdout).toBe(`${worktreePath("agent-a3f2")}\n`);
    expect(git(["worktree", "list"]).trim().split("\n")).toHaveLength(2);
  });

  it("同名のブランチが既にあれば、そのブランチで worktree を作る", () => {
    // given
    git(["branch", "agent-a3f2"]);

    // when
    const result = runHook({ name: "agent-a3f2", cwd: repo });

    // then
    expect(result.status).toBe(0);
    expect(
      git(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        worktreePath("agent-a3f2"),
      ).trim(),
    ).toBe("agent-a3f2");
  });

  it("cwd が worktree の中でも、メインの作業ツリーの下に作る", () => {
    // given
    runHook({ name: "first", cwd: repo });

    // when
    const result = runHook({ name: "second", cwd: worktreePath("first") });

    // then
    expect(result.stdout).toBe(`${worktreePath("second")}\n`);
  });
});

describe("worktree-create.sh（共有フックの修復）", () => {
  it("メインの .git/hooks/pre-commit が .claude/worktrees/ の下を指していれば、最後にメインで pnpm exec lefthook install を実行する", () => {
    // given
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\n${repo}/.claude/worktrees/old/node_modules/.pnpm/lefthook/bin/lefthook run pre-commit\n`,
    );

    // when
    runHook({ name: "agent-a3f2", cwd: repo });
    const lastCall = calls().at(-1);

    // then
    expect(lastCall).toBe(`${repo} CI= env_db=none pnpm exec lefthook install`);
  });

  it("pre-commit がメインの node_modules を指していれば、lefthook install は実行しない", () => {
    // given
    writeFileSync(
      join(repo, ".git", "hooks", "pre-commit"),
      `#!/bin/sh\n${repo}/node_modules/.pnpm/lefthook/bin/lefthook run pre-commit\n`,
    );

    // when
    runHook({ name: "agent-a3f2", cwd: repo });
    const lefthookCalls = calls().filter((c) => c.includes("lefthook"));

    // then
    expect(lefthookCalls).toEqual([]);
  });
});

describe("worktree-create.sh（DB の段が失敗しても worktree は返す）", () => {
  it("docker が失敗しても 0 で終わってパスを返し、.env は書き、migrate は呼ばず、DB が分離されていないことを stderr に出す", () => {
    // given: 前提なし（beforeEach で git リポジトリと偽の docker / pnpm がある）
    // when
    const result = runHook(
      { name: "agent-a3f2", cwd: repo },
      { FAKE_DOCKER_EXIT: "1" },
    );

    // then
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${worktreePath("agent-a3f2")}\n`);
    expect(existsSync(join(worktreePath("agent-a3f2"), ".env"))).toBe(true);
    expect(calls().filter((c) => c.includes("db:migrate"))).toEqual([]);
    expect(result.stderr).toContain("app_wt_agent_a3f2 を作れませんでした");
  });

  it("pnpm install が失敗しても 0 で終わってパスを返し、stderr に警告を出す", () => {
    // given: 前提なし（beforeEach で git リポジトリと偽の docker / pnpm がある）
    // when
    const result = runHook(
      { name: "agent-a3f2", cwd: repo },
      { FAKE_PNPM_EXIT: "1" },
    );

    // then
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${worktreePath("agent-a3f2")}\n`);
    expect(result.stderr).toContain("pnpm install");
  });
});

describe("worktree-create.sh（must reject: 作れない入力は 0 以外で終わる）", () => {
  it.each([
    ["空", ""],
    ["パスを上にたどる", "../evil"],
    ["スラッシュを含む", "a/b"],
    ["ドットで始まる", ".hidden"],
  ])("name が%s（%s）なら、worktree を作らずに失敗する", (_, name) => {
    // given: it.each の name（作れない名前）
    // when
    const result = runHook({ name, cwd: repo });

    // then
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(git(["worktree", "list"]).trim().split("\n")).toHaveLength(1);
    expect(calls()).toEqual([]);
  });

  it("cwd が git リポジトリでなければ失敗する", () => {
    // given: 前提なし（git リポジトリでない base を cwd にする）
    // when
    const result = runHook({ name: "agent-a3f2", cwd: base });

    // then
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("worktree-create.sh（DRY_RUN）", () => {
  it("WORKTREE_HOOK_DRY_RUN=1 なら実行予定を表示して最後の行にパスを出すだけで、worktree も DB も作らない", () => {
    // given
    const wt = worktreePath("agent-a3f2");

    // when
    const result = runHook(
      { name: "agent-a3f2", cwd: repo },
      { WORKTREE_HOOK_DRY_RUN: "1" },
    );

    // then
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      `[dry-run] (cd ${repo} && git worktree add -b agent-a3f2 ${wt} HEAD)`,
      `[dry-run] (cd ${repo} && ${PSQL} "${LIST_SQL}") and drop app_wt_* databases without a worktree`,
      `[dry-run] (cd ${wt} && CI=true timeout 120 pnpm install --frozen-lockfile)`,
      `[dry-run] bash ${envScriptPath} agent-a3f2 ${wt}/.env.example > ${wt}/.env`,
      `[dry-run] (cd ${repo} && ${PSQL} "create database app_wt_agent_a3f2") unless it exists`,
      `[dry-run] (cd ${wt} && timeout 15 pnpm db:migrate)`,
      `[dry-run] (cd ${repo} && pnpm exec lefthook install) if .git/hooks/pre-commit points into .claude/worktrees/`,
      wt,
    ]);
    expect(existsSync(wt)).toBe(false);
    expect(calls()).toEqual([]);
  });
});

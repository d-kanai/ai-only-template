// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは bash と git を子プロセスで
//   起動するだけで DOM を使わない。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// CI の PR で作業ログの追記を必須にするスクリプト（scripts/hooks/check-logs-diff.sh <base-ref>）の仕様。Issue #64。
// `git diff --name-only <base-ref>...HEAD` に logs/ の .md が 1 件以上あれば exit 0、無ければ理由を出して exit 1。
// CI の ci.yml に組み込まれていることは logs-check.test.ts が検査する。

const scriptPath = resolve(import.meta.dirname, "check-logs-diff.sh");

describe("check-logs-diff.sh", () => {
  let tmp: string;
  let repo: string;
  let gitEnv: NodeJS.ProcessEnv;

  function git(args: string[]) {
    const result = spawnSync("git", args, {
      cwd: repo,
      env: gitEnv,
      encoding: "utf8",
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  }

  function commitFiles(files: Record<string, string>, message = "change") {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(repo, path, ".."), { recursive: true });
      writeFileSync(join(repo, path), content);
    }
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message]);
  }

  function run(args: string[]) {
    return spawnSync("bash", [scriptPath, ...args], {
      cwd: repo,
      env: gitEnv,
      encoding: "utf8",
    });
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "check-logs-diff-"));
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
    commitFiles(
      { "README.md": "readme\n", "logs/2026-09-27.md": "# 27\n" },
      "init",
    );
    git(["checkout", "-q", "-b", "work"]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("通す（must pass）", () => {
    it("logs/ に .md を足した PR は 0 で終わる", () => {
      commitFiles({ "src.ts": "x\n", "logs/2026-09-28.md": "# 28\n" });
      const result = run(["main"]);
      expect(result.status).toBe(0);
    });

    it("既存の logs/*.md に追記しただけの PR も 0 で終わる", () => {
      commitFiles({ "logs/2026-09-27.md": "# 27\n追記\n" });
      expect(run(["main"]).status).toBe(0);
    });

    it("logs/ のサブディレクトリの .md も数える", () => {
      commitFiles({ "logs/2026/09-28.md": "# 28\n" });
      expect(run(["main"]).status).toBe(0);
    });

    it("base が PR の後に logs を変えずに進んでいても、PR 側の logs の変更で 0 になる", () => {
      commitFiles({ "logs/2026-09-28.md": "# 28\n" });
      git(["checkout", "-q", "main"]);
      commitFiles({ "other.ts": "y\n" });
      git(["checkout", "-q", "work"]);
      expect(run(["main"]).status).toBe(0);
    });
  });

  describe("落とす（must reject）", () => {
    it("logs の変更が無い PR は 1 で終わり、理由を stderr に出す", () => {
      commitFiles({ "src.ts": "x\n" });
      const result = run(["main"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("logs/");
      expect(result.stderr).toContain("main...HEAD");
    });

    it("logs 以外の .md だけを変えた（文書だけの）PR も 1 で終わる", () => {
      commitFiles({ "docs/work-log.md": "# doc\n", "README.md": "changed\n" });
      expect(run(["main"]).status).toBe(1);
    });

    it("logs/ の .md を削除しただけの PR は 1 で終わる（追加・変更だけを数える）", () => {
      git(["rm", "-q", "logs/2026-09-27.md"]);
      git(["commit", "-q", "-m", "remove log"]);
      expect(run(["main"]).status).toBe(1);
    });

    it("logs/ の .md 以外のファイル（logs/x.txt）だけなら 1 で終わる", () => {
      commitFiles({ "logs/x.txt": "x\n" });
      expect(run(["main"]).status).toBe(1);
    });

    it("別のディレクトリの logs/（apps/logs/a.md）は数えない", () => {
      commitFiles({ "apps/logs/a.md": "x\n" });
      expect(run(["main"]).status).toBe(1);
    });

    it("base 側だけで logs が変わっていても（三点 diff なので）PR 側に変更が無ければ 1 で終わる", () => {
      commitFiles({ "src.ts": "x\n" });
      git(["checkout", "-q", "main"]);
      commitFiles({ "logs/2026-09-28.md": "# main\n" });
      git(["checkout", "-q", "work"]);
      expect(run(["main"]).status).toBe(1);
    });

    it("作業ツリーにある未コミットの logs の変更は数えない（PR の差分だけを見る）", () => {
      commitFiles({ "src.ts": "x\n" });
      writeFileSync(join(repo, "logs/2026-09-28.md"), "# 未コミット\n");
      expect(run(["main"]).status).toBe(1);
    });

    it("base-ref が存在しなければ 0 以外で終わる（差分を取れないまま通さない）", () => {
      commitFiles({ "logs/2026-09-28.md": "# 28\n" });
      const result = run(["origin/nope"]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("origin/nope");
    });

    it("base-ref を渡さなければ 0 以外で終わり、使い方を出す", () => {
      const result = run([]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("usage");
    });
  });
});

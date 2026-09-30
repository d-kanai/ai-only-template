// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは bash と git を子プロセスで
//   起動するだけで DOM を使わない。
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// CI の PR で作業ログの追記を必須にするスクリプト（scripts/hooks/check-work-logs-diff.sh <base-ref>）の仕様。
// `git diff --name-only <base-ref>...HEAD` に docs/work-logs/ の .md が 1 件以上あれば exit 0、無ければ理由を出して exit 1。
// CI の ci.yml に組み込まれていることは rule-tests/work-logs-check.test.ts が検査する。

const scriptPath = resolve(import.meta.dirname, "check-work-logs-diff.sh");

describe("check-work-logs-diff.sh", () => {
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
    tmp = mkdtempSync(join(tmpdir(), "check-work-logs-diff-"));
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
      { "README.md": "readme\n", "docs/work-logs/2026-09-27.md": "# 27\n" },
      "init",
    );
    git(["checkout", "-q", "-b", "work"]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("通す（must pass）", () => {
    it("docs/work-logs/ に .md を足した PR は 0 で終わる", () => {
      commitFiles({
        "src.ts": "x\n",
        "docs/work-logs/2026-09-28.md": "# 28\n",
      });
      const result = run(["main"]);
      expect(result.status).toBe(0);
    });

    it("既存の docs/work-logs/*.md に追記しただけの PR も 0 で終わる", () => {
      commitFiles({ "docs/work-logs/2026-09-27.md": "# 27\n追記\n" });
      expect(run(["main"]).status).toBe(0);
    });

    it("docs/work-logs/ のサブディレクトリの .md も数える", () => {
      commitFiles({ "docs/work-logs/2026/09-28.md": "# 28\n" });
      expect(run(["main"]).status).toBe(0);
    });

    it("base が PR の後に作業ログを変えずに進んでいても、PR 側の作業ログの変更で 0 になる", () => {
      commitFiles({ "docs/work-logs/2026-09-28.md": "# 28\n" });
      git(["checkout", "-q", "main"]);
      commitFiles({ "other.ts": "y\n" });
      git(["checkout", "-q", "work"]);
      expect(run(["main"]).status).toBe(0);
    });
  });

  describe("rename の扱い（--no-renames）", () => {
    it("ログの名前を変えただけの PR は、追加 + 削除として見えるので 0 で終わる（限界）", () => {
      // --no-renames: 利用者の diff.renames の設定に左右されず、名前の変更を常に「削除 + 追加」として扱う。
      //   rename の検出が効くと R になり --diff-filter=AM で外れる（設定で結果が変わる）。
      // 限界: 中身を足していない名前の変更でも通る（.claude/rules/work-log.md）。
      git([
        "mv",
        "docs/work-logs/2026-09-27.md",
        "docs/work-logs/2026-09-26.md",
      ]);
      git(["commit", "-q", "-m", "rename log"]);
      expect(run(["main"]).status).toBe(0);
    });

    it("diff.renames=false の設定でも結果が同じ（0）", () => {
      git([
        "mv",
        "docs/work-logs/2026-09-27.md",
        "docs/work-logs/2026-09-26.md",
      ]);
      git(["commit", "-q", "-m", "rename log"]);
      git(["config", "diff.renames", "false"]);
      expect(run(["main"]).status).toBe(0);
    });
  });

  describe("落とす（must reject）", () => {
    it("作業ログの変更が無い PR は 1 で終わり、理由を stderr に出す", () => {
      commitFiles({ "src.ts": "x\n" });
      const result = run(["main"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("docs/work-logs/");
      expect(result.stderr).toContain("main...HEAD");
    });

    it("作業ログ以外の .md だけを変えた（文書だけの）PR も 1 で終わる", () => {
      commitFiles({ "docs/adr/x.md": "# doc\n", "README.md": "changed\n" });
      expect(run(["main"]).status).toBe(1);
    });

    it("docs/work-logs/ の .md を削除しただけの PR は 1 で終わる（追加・変更だけを数える）", () => {
      git(["rm", "-q", "docs/work-logs/2026-09-27.md"]);
      git(["commit", "-q", "-m", "remove log"]);
      expect(run(["main"]).status).toBe(1);
    });

    it("docs/work-logs/ の .md 以外のファイル（docs/work-logs/x.txt）だけなら 1 で終わる", () => {
      commitFiles({ "docs/work-logs/x.txt": "x\n" });
      expect(run(["main"]).status).toBe(1);
    });

    it("別のディレクトリの docs/work-logs/（apps/docs/work-logs/a.md）は数えない", () => {
      commitFiles({ "apps/docs/work-logs/a.md": "x\n" });
      expect(run(["main"]).status).toBe(1);
    });

    // WHY リポジトリ直下の work-logs/ を must reject に置く: 置き場所は docs/work-logs/ だけ。直下の work-logs/ のログを数えると、
    //   リポジトリ直下に work-logs/ を作って書く誤りを CI が見逃す。
    it("旧い置き場所（リポジトリ直下の work-logs/）の .md だけなら 1 で終わる", () => {
      commitFiles({ "work-logs/2026-09-28.md": "# 28\n" });
      expect(run(["main"]).status).toBe(1);
    });

    it("docs/work-logs の前方一致のディレクトリ（docs/work-logs-old/）の .md だけなら 1 で終わる", () => {
      commitFiles({ "docs/work-logs-old/a.md": "x\n" });
      expect(run(["main"]).status).toBe(1);
    });

    it("base 側だけで既存のログが変わっていても（三点 diff なので）PR 側に変更が無ければ 1 で終わる", () => {
      // WHY 既存のログの変更にする: base 側で新しいログを足すだけだと、二点 diff（..）でも HEAD 側から見て「削除」になり、
      //   --diff-filter=AM で外れて 1 になる（二点に壊しても落ちない）。変更（M）なら二点では数えてしまい 0 になる。
      commitFiles({ "src.ts": "x\n" });
      git(["checkout", "-q", "main"]);
      commitFiles({ "docs/work-logs/2026-09-27.md": "# 27\nmain で追記\n" });
      git(["checkout", "-q", "work"]);
      expect(run(["main"]).status).toBe(1);
    });

    it("作業ツリーにある未コミットの作業ログの変更は数えない（PR の差分だけを見る）", () => {
      commitFiles({ "src.ts": "x\n" });
      writeFileSync(
        join(repo, "docs/work-logs/2026-09-28.md"),
        "# 未コミット\n",
      );
      expect(run(["main"]).status).toBe(1);
    });

    it("base-ref が存在しなければ 0 以外で終わる（差分を取れないまま通さない）", () => {
      commitFiles({ "docs/work-logs/2026-09-28.md": "# 28\n" });
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

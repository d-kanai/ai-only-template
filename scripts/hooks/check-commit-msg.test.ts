// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom だが、このテストは bash / git を子プロセスで起動するだけで DOM を使わない。
//
// scripts/hooks/check-commit-msg.sh（lefthook の commit-msg）の仕様。コミットメッセージの形式（.claude/general/commit.md）を
// 機械で止めるルール検査テストなので、通るメッセージ（must pass）と拒否するメッセージ（must reject）を両方持ち、
// 最後に一時的な git リポジトリで `git commit` から lefthook 経由でスクリプトが呼ばれることまで通す。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const scriptPath = join(repoRoot, "scripts", "hooks", "check-commit-msg.sh");
// WHY pnpm exec を使わない: pnpm exec は依存の状態によって install を走らせ、共有の .git/hooks を書き換えうる
//   （LEARNINGS.md の Issue #50）。node_modules/.bin の lefthook を直接呼ぶ。
const lefthookBin = join(repoRoot, "node_modules", ".bin", "lefthook");

const VALID = [
  "Biome の設定を直す",
  "",
  "🎯 WHY",
  "warn が放置されるため",
  "",
  "📝 WHAT",
  "biome.json を変えた",
  "",
  "🛠️ 実装経緯",
  "Issue #26 の方針どおり",
  "",
  "✅ 検証内容",
  "pnpm lint が通る",
  "",
  "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>",
].join("\n");

let dir: string;

beforeAll(() => {
  // WHY 一時ディレクトリ: メッセージのファイルや git リポジトリをリポジトリの中に作ると、途中で落ちたときに作業ツリーに残る。
  dir = mkdtempSync(join(tmpdir(), "check-commit-msg-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function check(message: string) {
  counter += 1;
  const file = join(dir, `msg-${counter}.txt`);
  writeFileSync(file, message);
  return spawnSync("bash", [scriptPath, file], { encoding: "utf8" });
}

const without = (line: string) =>
  VALID.split("\n")
    .filter((l) => l !== line)
    .join("\n");

describe("通すメッセージ（must pass）", () => {
  it.each<[string, string]>([
    ["4 つの見出しと Co-Authored-By がある", VALID],
    ["末尾に改行がある", `${VALID}\n`],
    [
      "見出しの行の前後に空白がある",
      VALID.replace("🎯 WHY", "  🎯 WHY").replace(
        "✅ 検証内容",
        "✅ 検証内容 \t",
      ),
    ],
    ["CRLF の改行", VALID.replaceAll("\n", "\r\n")],
    [
      "Co-Authored-By の大文字小文字が違う（git の trailer は大文字小文字を区別しない）",
      VALID.replace("Co-Authored-By:", "co-authored-by:"),
    ],
    [
      "git が付けるコメント行（# で始まる）がある",
      `${VALID}\n# Please enter the commit message for your changes.\n# On branch feat/1-x\n`,
    ],
    [
      "commit -v の切り取り線より下に差分がある（見出しの文字列を含んでいても見ない）",
      `${VALID}\n# ------------------------ >8 ------------------------\n# Do not modify or remove the line above.\ndiff --git a/x b/x\n+🎯 WHY\n`,
    ],
    ["マージコミット", "Merge branch 'main' into feat/1-x\n"],
    [
      "マージコミット（PR）",
      "Merge pull request #74 from d-kanai/refactor/68\n\nbody",
    ],
    ["fixup!", "fixup! Biome の設定を直す\n"],
    ["squash!", "squash! Biome の設定を直す\n"],
    ["amend!", "amend! Biome の設定を直す\n\n本文だけ"],
    [
      "Revert でも 4 つの見出しと Co-Authored-By があれば通る",
      `Revert "Biome の設定を直す"\n${VALID.split("\n").slice(1).join("\n")}`,
    ],
    [
      // # の行を読み飛ばしてから 1 行目を決めるので、先頭のコメントの後の Merge もマージコミットとして扱う。
      "先頭にコメント行があるマージコミット",
      "# Conflicts:\n#\tx.ts\nMerge branch 'main' into feat/1-x\n",
    ],
  ])("%s", (_label, message) => {
    const result = check(message);
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("拒否するメッセージ（must reject）", () => {
  it.each<[string, string, string[]]>([
    ["🎯 WHY が無い", without("🎯 WHY"), ["🎯 WHY"]],
    ["📝 WHAT が無い", without("📝 WHAT"), ["📝 WHAT"]],
    ["🛠️ 実装経緯 が無い", without("🛠️ 実装経緯"), ["🛠️ 実装経緯"]],
    ["✅ 検証内容 が無い", without("✅ 検証内容"), ["✅ 検証内容"]],
    [
      "Co-Authored-By が無い",
      without("Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"),
      ["Co-Authored-By:"],
    ],
    [
      "見出しが 2 つ無い（不足をすべて並べる）",
      without("📝 WHAT")
        .split("\n")
        .filter((l) => l !== "✅ 検証内容")
        .join("\n"),
      ["📝 WHAT", "✅ 検証内容"],
    ],
    [
      "見出しの順番が違う（WHAT が WHY より前）",
      VALID.replace("🎯 WHY", "TMP")
        .replace("📝 WHAT", "🎯 WHY")
        .replace("TMP", "📝 WHAT"),
      ["順番"],
    ],
    [
      "見出しがコメント行の中にだけある",
      `${without("✅ 検証内容")}\n# ✅ 検証内容\n`,
      ["見出し「✅ 検証内容」の行がありません"],
    ],
    [
      // # の行を読み飛ばさないと、コメントが 1 行目（サマリ）として数えられて通ってしまう。
      "コメント行を除くと 1 行目が空（git のテンプレートのコメントだけが先頭にある）",
      `# Please enter the commit message\n\n${VALID.split("\n").slice(1).join("\n")}`,
      ["1 行目（サマリ）が空です"],
    ],
    [
      "Revert もほかのコミットと同じく検査する（取り消す理由を書く）",
      'Revert "Biome の設定を直す"\n\nThis reverts commit 0123abc.\n',
      ["見出し「🎯 WHY」の行がありません"],
    ],
    [
      "見出しが 1 行目（サマリ）にしか無い",
      [
        "🎯 WHY",
        "",
        "📝 WHAT",
        "🛠️ 実装経緯",
        "✅ 検証内容",
        "Co-Authored-By: x",
      ].join("\n"),
      ["🎯 WHY"],
    ],
    [
      "見出しが文の途中にある（行の先頭にない）",
      VALID.replace("🎯 WHY", "理由は 🎯 WHY に書く"),
      ["🎯 WHY"],
    ],
    [
      "見出しが切り取り線より下にしか無い",
      `${without("🎯 WHY")}\n# ------------------------ >8 ------------------------\n🎯 WHY\n`,
      ["見出し「🎯 WHY」の行がありません"],
    ],
    [
      // git commit -v の差分では、変更していない行が先頭に空白 1 つを付けて並ぶ（前後の空白を除くと見出しと同じになる）。
      "見出しが git commit -v の差分の行（先頭に空白）にしか無い",
      [
        "Biome の設定を直す",
        "",
        "Co-Authored-By: x",
        "# ------------------------ >8 ------------------------",
        "# Do not modify or remove the line above.",
        "diff --git a/msg.txt b/msg.txt",
        " 🎯 WHY",
        " 📝 WHAT",
        " 🛠️ 実装経緯",
        " ✅ 検証内容",
      ].join("\n"),
      [
        "見出し「🎯 WHY」の行がありません",
        "見出し「✅ 検証内容」の行がありません",
      ],
    ],
    ["1 行目が空", `\n${VALID}`, ["1 行目"]],
    ["空のメッセージ", "", ["1 行目"]],
    [
      "マージで始まらない Merge（Merged で始まる）",
      "Merged something\n",
      ["🎯 WHY"],
    ],
  ])("%s", (_label, message, expectedInStderr) => {
    const result = check(message);
    expect(result.status).toBe(1);
    for (const text of expectedInStderr) {
      expect(result.stderr).toContain(text);
    }
  });

  it("メッセージのファイルが無ければ exit 1", () => {
    const result = spawnSync("bash", [scriptPath, join(dir, "no-such-file")], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no-such-file");
  });
});

describe("lefthook.yml の commit-msg", () => {
  it("commit-msg で check-commit-msg.sh にメッセージのファイル（{1}）を渡す", () => {
    // WHY lefthook dump: YAML を自前で読まず、Lefthook 自身が解釈した結果を見る（rule-tests/lint.test.ts と同じ）。
    const result = spawnSync(lefthookBin, ["dump", "--format", "json"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const config = JSON.parse(result.stdout) as {
      "commit-msg"?: { commands?: Record<string, { run?: string }> };
    };
    const runs = Object.values(config["commit-msg"]?.commands ?? {}).map(
      (command) => command.run,
    );
    expect(runs).toEqual(["bash scripts/hooks/check-commit-msg.sh {1}"]);
  });

  it("一時的な git リポジトリで、git commit が形式の違うメッセージを拒否し、正しいメッセージを通す", () => {
    // 使い捨てのリポジトリに lefthook.yml とスクリプトをコピーし、.git/hooks/commit-msg を手で置く。
    // WHY lefthook install を使わない: install は lefthook.yml のすべてのフック（pre-commit の biome など）を入れ、
    //   一時リポジトリには node_modules が無いので pre-commit が失敗する。commit-msg だけを確かめる。
    // WHY --no-auto-install: lefthook run は設定が変わったと判断すると lefthook install を自動で実行する。
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "scripts", "hooks"), { recursive: true });
    const gitIn = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(
        "git",
        ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
        {
          cwd: repo,
          encoding: "utf8",
          env: { ...process.env, ...env },
        },
      );
    expect(gitIn(["init", "-q", "-b", "feat/1-x"]).status).toBe(0);
    copyFileSync(join(repoRoot, "lefthook.yml"), join(repo, "lefthook.yml"));
    copyFileSync(
      scriptPath,
      join(repo, "scripts", "hooks", "check-commit-msg.sh"),
    );
    const hook = join(repo, ".git", "hooks", "commit-msg");
    writeFileSync(
      hook,
      `#!/bin/sh\nexec "${lefthookBin}" run --no-auto-install commit-msg "$@"\n`,
    );
    chmodSync(hook, 0o755);

    writeFileSync(join(dir, "bad.txt"), without("🛠️ 実装経緯"));
    writeFileSync(join(dir, "good.txt"), VALID);
    const bad = gitIn([
      "commit",
      "-q",
      "--allow-empty",
      "-F",
      join(dir, "bad.txt"),
    ]);
    const good = gitIn([
      "commit",
      "-q",
      "--allow-empty",
      "-F",
      join(dir, "good.txt"),
    ]);

    expect(bad.status).not.toBe(0);
    expect(bad.stdout + bad.stderr).toContain("🛠️ 実装経緯");
    expect(good.status, good.stdout + good.stderr).toBe(0);
    const log = gitIn(["log", "--format=%s"]);
    expect(log.stdout.trim()).toBe("Biome の設定を直す");
  });
});

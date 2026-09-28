// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは bash と git を子プロセスで
//   起動するだけで DOM を使わない。
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Stop フック（scripts/hooks/require-log.sh）の仕様。Issue #64。
// このターンでツールを使ったのに、その日の作業ログ（logs/<今日>.md）が作業ツリーでも今日のコミットでも変わっていなければ、
// {"decision":"block"} で停止を拒否する。WHY と限界は .claude/rules/work-log.md。

const scriptPath = resolve(import.meta.dirname, "require-log.sh");

// スクリプトは `date +%F`（ローカルのタイムゾーン）で今日を決める。JS の Date のローカルの値も同じ TZ を使うので、
// 期待値もここで同じ規則で作る（UTC にすると、UTC とローカルで日付が違う時間帯にテストが落ちる）。
function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
const now = new Date();
const today = localDate(now);
const yesterdayNoon = new Date(
  now.getFullYear(),
  now.getMonth(),
  now.getDate() - 1,
  12,
);
const yesterday = localDate(yesterdayNoon);
const todayLog = `logs/${today}.md`;

type Entry = Record<string, unknown>;

// transcript の 1 行（Claude Code の JSONL と同じ形。2026-09-28 に実セッションの transcript で type と content の形を確認）。
const human = (text: string): Entry => ({
  type: "user",
  message: { role: "user", content: text },
});
const humanArray = (text: string): Entry => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
});
const meta = (text: string): Entry => ({
  type: "user",
  isMeta: true,
  message: { role: "user", content: text },
});
const toolUse = (id: string, name = "Bash"): Entry => ({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: {} }],
  },
});
const toolResult = (id: string): Entry => ({
  type: "user",
  message: {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content: "ok" }],
  },
});
const assistantText = (text: string): Entry => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
// transcript にはメッセージ以外の行（attachment / system など）も混ざる。
const attachment: Entry = { type: "attachment", attachment: {} };

// ツールを 1 回使ったターン（人間ターン → tool_use → tool_result → 最後のテキスト）。
const turnWithTool = (prompt = "調べて"): Entry[] => [
  human(prompt),
  toolUse("t1"),
  toolResult("t1"),
  assistantText("調べました"),
];

describe("require-log.sh（Stop フック）", () => {
  let tmp: string;
  let repo: string;
  let transcript: string;
  let gitEnv: NodeJS.ProcessEnv;

  // 実行元の git の設定（グローバルのフック・署名・ユーザー名）がテストに漏れないよう、HOME と設定ファイルを一時ディレクトリに向ける。
  function git(args: string[], extraEnv: Record<string, string> = {}) {
    const result = spawnSync("git", args, {
      cwd: repo,
      env: { ...gitEnv, ...extraEnv },
      encoding: "utf8",
    });
    if (result.status !== 0)
      throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  }

  function writeRepoFile(path: string, content: string) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }

  function commit(message: string, extraEnv: Record<string, string> = {}) {
    git(["add", "-A"]);
    git(["commit", "-q", "-m", message], extraEnv);
  }

  function writeTranscript(entries: Entry[], trailing = "") {
    writeFileSync(
      transcript,
      `${entries.map((e) => JSON.stringify(e)).join("\n")}\n${trailing}`,
    );
  }

  function run(input: Record<string, unknown>) {
    return spawnSync("bash", [scriptPath], {
      input: JSON.stringify(input),
      env: gitEnv,
      encoding: "utf8",
    });
  }

  const stopInput = (extra: Record<string, unknown> = {}) => ({
    hook_event_name: "Stop",
    transcript_path: transcript,
    cwd: repo,
    stop_hook_active: false,
    ...extra,
  });

  function expectBlocked(result: ReturnType<typeof run>) {
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: "block",
      reason: `作業ログ ${todayLog} に、このターンでやったこと（調査・判断・確認した事実）を追記してください（.claude/general/log.md）。追記してからコミットしてください。`,
    });
  }

  function expectAllowed(result: ReturnType<typeof run>) {
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  }

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "require-log-"));
    repo = join(tmp, "repo");
    mkdirSync(repo);
    const home = join(tmp, "home");
    mkdirSync(home);
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
    // 実行元のタイムゾーンをそのまま渡す（スクリプトの date と、このテストの Date を同じ TZ にするため）。
    if (process.env.TZ !== undefined) gitEnv.TZ = process.env.TZ;
    writeFileSync(join(home, "gitconfig"), "");
    git(["init", "-q", "-b", "main"]);
    writeRepoFile("README.md", "readme\n");
    writeRepoFile(`logs/${yesterday}.md`, "# 昨日\n");
    // 最初のコミットは昨日の日付にする（今日のコミットに logs/<今日>.md が無い状態から始める）。
    const yesterdayDate = `${yesterday}T12:00:00`;
    commit("init", {
      GIT_AUTHOR_DATE: yesterdayDate,
      GIT_COMMITTER_DATE: yesterdayDate,
    });
    transcript = join(tmp, "transcript.jsonl");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("停止を拒否する（must reject）", () => {
    it("ツールを使ったのに logs/<今日>.md が作業ツリーでもコミットでも変わっていなければ、block と理由を返す", () => {
      writeTranscript(turnWithTool());
      expectBlocked(run(stopInput()));
    });

    it("tool_result の user 行を人間のターンと数えない（人間ターン → tool_use → tool_result → テキストは 1 回の使用）", () => {
      // tool_result を人間のターンと誤認すると、その後の tool_use が 0 件になって素通りする。
      writeTranscript([
        human("調べて"),
        toolUse("t1"),
        toolResult("t1"),
        toolUse("t2", "Agent"),
        toolResult("t2"),
        assistantText("完了"),
      ]);
      expectBlocked(run(stopInput()));
    });

    it("isMeta の user 行（Stop フックのフィードバックなど）を人間のターンと数えない", () => {
      writeTranscript([
        human("調べて"),
        toolUse("t1"),
        toolResult("t1"),
        meta("Stop hook feedback: ..."),
        assistantText("完了"),
      ]);
      expectBlocked(run(stopInput()));
    });

    it("メッセージ以外の行（attachment など）と、書きかけの最後の行があっても数えられる", () => {
      // transcript は非同期に書かれる（公式 hooks の transcript_path の説明）ので、最後の行が途中で切れていることがある。
      writeTranscript(
        [attachment, ...turnWithTool(), attachment],
        '{"type":"assi',
      );
      expectBlocked(run(stopInput()));
    });

    it("変更されたのが昨日の logs だけなら拒否する", () => {
      writeTranscript(turnWithTool());
      writeRepoFile(`logs/${yesterday}.md`, "# 昨日\n追記\n");
      writeRepoFile("src.ts", "x\n");
      expectBlocked(run(stopInput()));
    });

    it("logs/<今日>.md が昨日の日付のコミットにしか無ければ拒否する", () => {
      writeTranscript(turnWithTool());
      writeRepoFile(todayLog, "# 今日\n");
      const yesterdayDate = `${yesterday}T13:00:00`;
      commit("log", {
        GIT_AUTHOR_DATE: yesterdayDate,
        GIT_COMMITTER_DATE: yesterdayDate,
      });
      expectBlocked(run(stopInput()));
    });

    it("stop_hook_active が入力に無くても（true でなければ）拒否する", () => {
      writeTranscript(turnWithTool());
      expectBlocked(
        run({
          hook_event_name: "Stop",
          transcript_path: transcript,
          cwd: repo,
        }),
      );
    });

    it("cwd がリポジトリのサブディレクトリでも、リポジトリ直下の logs/<今日>.md で判定する", () => {
      writeTranscript(turnWithTool());
      mkdirSync(join(repo, "sub"));
      expectBlocked(run(stopInput({ cwd: join(repo, "sub") })));
    });
  });

  describe("停止を許可する（must pass）", () => {
    it("logs/<今日>.md が作業ツリーで新しく作られていれば（未追跡）許可する", () => {
      writeTranscript(turnWithTool());
      writeRepoFile(todayLog, "# 今日\n");
      expectAllowed(run(stopInput()));
    });

    it("コミット済みの logs/<今日>.md が作業ツリーで変更されていれば許可する", () => {
      writeTranscript(turnWithTool());
      writeRepoFile(todayLog, "# 今日\n");
      commit("log", {
        GIT_AUTHOR_DATE: `${yesterday}T13:00:00`,
        GIT_COMMITTER_DATE: `${yesterday}T13:00:00`,
      });
      writeRepoFile(todayLog, "# 今日\n追記\n");
      expectAllowed(run(stopInput()));
    });

    it("logs/<今日>.md の変更がステージ済みなら許可する", () => {
      writeTranscript(turnWithTool());
      writeRepoFile(todayLog, "# 今日\n");
      git(["add", todayLog]);
      expectAllowed(run(stopInput()));
    });

    it("logs/<今日>.md が今日のコミットで変更されていれば（作業ツリーはきれいでも）許可する", () => {
      writeTranscript(turnWithTool());
      writeRepoFile(todayLog, "# 今日\n");
      commit("log");
      expect(git(["status", "--porcelain"])).toBe("");
      expectAllowed(run(stopInput()));
    });

    it("cwd がリポジトリのサブディレクトリでも、リポジトリ直下の logs/<今日>.md の変更を見て許可する", () => {
      writeTranscript(turnWithTool());
      mkdirSync(join(repo, "sub"));
      writeRepoFile(todayLog, "# 今日\n");
      expectAllowed(run(stopInput({ cwd: join(repo, "sub") })));
    });

    it("stop_hook_active が true なら（フックで続けている途中なら）判定せずに許可する", () => {
      writeTranscript(turnWithTool());
      expectAllowed(run(stopInput({ stop_hook_active: true })));
    });

    it("最後の人間のターン以降にツールを使っていなければ（会話だけのターン）許可する", () => {
      writeTranscript([human("やあ"), assistantText("こんにちは")]);
      expectAllowed(run(stopInput()));
    });

    it("前のターンでツールを使っていても、最後の人間のターン以降に使っていなければ許可する", () => {
      writeTranscript([
        ...turnWithTool(),
        human("ありがとう"),
        assistantText("どういたしまして"),
      ]);
      expectAllowed(run(stopInput()));
    });

    it("content が配列でも tool_result を含まない user 行は人間のターンとして扱う", () => {
      writeTranscript([
        ...turnWithTool(),
        humanArray("次は？"),
        assistantText("以上です"),
      ]);
      expectAllowed(run(stopInput()));
    });

    it("cwd が git リポジトリでなければ何もせず、理由を stderr に出す", () => {
      writeTranscript(turnWithTool());
      const outside = join(tmp, "not-a-repo");
      mkdirSync(outside);
      const result = run(stopInput({ cwd: outside }));
      expectAllowed(result);
      expect(result.stderr).toContain("git リポジトリではない");
    });

    it("transcript が読めなければ何もせず、理由を stderr に出す", () => {
      const result = run(
        stopInput({ transcript_path: join(tmp, "missing.jsonl") }),
      );
      expectAllowed(result);
      expect(result.stderr).toContain("transcript を読めない");
    });

    it("transcript_path が無ければ何もせず、理由を stderr に出す", () => {
      const result = run({
        hook_event_name: "Stop",
        cwd: repo,
        stop_hook_active: false,
      });
      expectAllowed(result);
      expect(result.stderr).toContain("transcript を読めない");
    });

    it("stdin が JSON でなければ何もせず、理由を stderr に出す", () => {
      const result = spawnSync("bash", [scriptPath], {
        input: "not json",
        env: gitEnv,
        encoding: "utf8",
      });
      expectAllowed(result);
      expect(result.stderr).toContain("入力を読めない");
    });
  });

  it("テストの前提: transcript を消した状態と置いた状態で結果が変わる（fixture が効いている）", () => {
    writeTranscript(turnWithTool());
    expectBlocked(run(stopInput()));
    unlinkSync(transcript);
    expectAllowed(run(stopInput()));
  });
});

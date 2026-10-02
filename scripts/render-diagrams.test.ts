// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは bash を子プロセスで
//   起動するだけで DOM を使わない。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// 構成図の元（*.mmd）をすべて .png にする scripts/render-diagrams.sh の仕様（Issue #324。スキル infra-diagram）。
// WHY mermaid-cli を偽物に差し替える: 本物は Chromium で描画し、取得と描画に時間がかかる。ここで固定するのは「どの元を
//   どの出力に描くか・何を渡すか・いつ失敗するか」で、描画そのものは mermaid-cli の仕事（本物での確認は作業ログ）。
const repoRoot = resolve(__dirname, "..");
const scriptPath = join(repoRoot, "scripts", "render-diagrams.sh");

let workDir: string;
let diagramsDir: string;
let fakeBrowser: string;
let fakeMmdc: string;
let callLog: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "render-diagrams-"));
  diagramsDir = join(workDir, "diagrams");
  mkdirSync(diagramsDir);
  fakeBrowser = join(workDir, "chrome");
  writeFileSync(fakeBrowser, "#!/bin/sh\n");
  chmodSync(fakeBrowser, 0o755);
  callLog = join(workDir, "calls.log");
  // 偽の mermaid-cli: 受け取った引数と puppeteer の設定を記録し、-o のパスに入力の名前を書く。
  //   FAIL_ON に一致する入力では失敗する。
  fakeMmdc = join(workDir, "mmdc");
  writeFileSync(
    fakeMmdc,
    [
      "#!/usr/bin/env bash",
      "while [ $# -gt 0 ]; do",
      '  case "$1" in',
      '    -p) config="$2"; shift 2 ;;',
      '    -i) input="$2"; shift 2 ;;',
      '    -o) output="$2"; shift 2 ;;',
      '    *) rest="$rest $1"; shift ;;',
      "  esac",
      "done",
      `echo "$(basename "$input") -> $(basename "$output")$rest $(cat "$config")" >> "${callLog}"`,
      'if [ -n "$FAIL_ON" ] && [ "$(basename "$input")" = "$FAIL_ON" ]; then exit 3; fi',
      'echo "png of $(basename "$input")" > "$output"',
    ].join("\n"),
  );
  chmodSync(fakeMmdc, 0o755);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function run(env: Record<string, string>) {
  return spawnSync("bash", [scriptPath, diagramsDir], {
    encoding: "utf8",
    env: {
      ...process.env,
      MMDC: fakeMmdc,
      PUPPETEER_EXECUTABLE_PATH: fakeBrowser,
      ...env,
    },
  });
}

function calls(): string[] {
  return existsSync(callLog)
    ? readFileSync(callLog, "utf8").trim().split("\n")
    : [];
}

describe("render-diagrams.sh（must pass: 描く）", () => {
  it("すべての .mmd を同じ名前の .png に、2 倍・白背景で描き、Chromium のパスと --no-sandbox を puppeteer に渡す", () => {
    // given
    writeFileSync(join(diagramsDir, "system.mmd"), "flowchart LR\n  a --> b\n");
    writeFileSync(join(diagramsDir, "deploy.mmd"), "flowchart TB\n  a --> b\n");

    // when
    const result = run({});

    // then
    expect(result.status).toBe(0);
    expect(calls()).toEqual([
      `deploy.mmd -> deploy.png -s 2 -b white -q {"executablePath":"${fakeBrowser}","args":["--no-sandbox"]}`,
      `system.mmd -> system.png -s 2 -b white -q {"executablePath":"${fakeBrowser}","args":["--no-sandbox"]}`,
    ]);
    expect(readFileSync(join(diagramsDir, "system.png"), "utf8")).toBe(
      "png of system.mmd\n",
    );
    expect(readFileSync(join(diagramsDir, "deploy.png"), "utf8")).toBe(
      "png of deploy.mmd\n",
    );
  });

  it("元の .mmd が無い .png を消し、ほかのファイル（README.md）は残す", () => {
    // given
    writeFileSync(join(diagramsDir, "system.mmd"), "flowchart LR\n");
    writeFileSync(join(diagramsDir, "old-name.png"), "stale");
    writeFileSync(join(diagramsDir, "README.md"), "# 構成図\n");

    // when
    const result = run({});

    // then
    expect(result.status).toBe(0);
    expect(readdirSync(diagramsDir).sort()).toEqual([
      "README.md",
      "system.mmd",
      "system.png",
    ]);
  });
});

describe("render-diagrams.sh（must reject: 失敗する）", () => {
  it(".mmd が 1 つも無ければ、何も描かずに失敗する", () => {
    // given
    writeFileSync(join(diagramsDir, "README.md"), "# 構成図\n");

    // when
    const result = run({});

    // then
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `render-diagrams: ${diagramsDir} に .mmd が無い\n`,
    );
    expect(calls()).toEqual([]);
  });

  it("PUPPETEER_EXECUTABLE_PATH のファイルが無ければ、何も描かずに失敗する", () => {
    // given
    writeFileSync(join(diagramsDir, "system.mmd"), "flowchart LR\n");
    const missing = join(workDir, "no-chrome");

    // when
    const result = run({ PUPPETEER_EXECUTABLE_PATH: missing });

    // then
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `render-diagrams: Chromium が見つからない（${missing}）。PUPPETEER_EXECUTABLE_PATH に Chrome / Chromium のパスを渡す\n`,
    );
    expect(calls()).toEqual([]);
  });

  it("mermaid-cli が失敗したら、そこで止まって失敗を返す（後の図を描かず、古い .png も消さない）", () => {
    // given
    writeFileSync(join(diagramsDir, "a.mmd"), "flowchart LR\n");
    writeFileSync(join(diagramsDir, "b.mmd"), "flowchart LR\n");
    writeFileSync(join(diagramsDir, "old.png"), "stale");

    // when
    const result = run({ FAIL_ON: "a.mmd" });

    // then
    expect(result.status).toBe(3);
    expect(calls()).toHaveLength(1);
    expect(existsSync(join(diagramsDir, "b.png"))).toBe(false);
    expect(existsSync(join(diagramsDir, "old.png"))).toBe(true);
  });
});

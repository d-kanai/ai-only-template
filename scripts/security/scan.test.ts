// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom だが、このテストは bash を子プロセスで起動するだけで DOM を使わない。
//
// scripts/security/scan.sh の zap-alerts（ZAP の警告の判定。Issue #364）の仕様。main の日次の zap-e2e（.github/workflows/zap.yml。Issue #405）が E2E を ZAP 経由で流して active scan をかけた後、
//   ZAP の API（/JSON/core/view/alerts/）から取った警告をこの判定に渡し、ジョブを落とすかを決める。
// 判定:
//   - 危険度（risk）が Low / Medium / High の警告が 1 件でもあれば失敗（終了コード 1）。Informational は表示だけで落とさない。
//     WHY Informational は落とさない: 「Modern Web Application」（SPA だと知らせるだけ）のように、直すものの無い知らせが毎回出る
//       （2026-10-03 に E2E を ZAP 経由で流して実測）。
//   - 許容する警告は、除外のファイル（scripts/security/zap-ignore.tsv）に alertRef と WHY を書いて外す。
//     WHY pluginId でなく alertRef: 同じ規則（例: 10055 の CSP）の中に別の問題（style-src の unsafe-inline と script-src の
//       unsafe-inline など）があり、pluginId で外すと許容していない問題まで黙って通る。
//     WHY 理由の無い行は誤り（終了コード 2）: 理由の無い除外は、後から見て外してよいかを判断できない（.claude/rules/tooling/security-scan.md
//       の「抑えるときは WHY を書く」を、ここでは機械で止める）。
// ZAP を起動して E2E を流す部分（zap-e2e）は Docker とブラウザが要るので、ここでは動かさない（zap.yml が毎日動かす）。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(__dirname, "..", "..");
const scriptPath = join(repoRoot, "scripts", "security", "scan.sh");

type Alert = { risk: string; alertRef: string; alert: string; url: string };

const CSP_STYLE: Alert = {
  risk: "Medium",
  alertRef: "10055-6",
  alert: "CSP: style-src unsafe-inline",
  url: "http://localhost:3100/",
};
const CSP_SCRIPT: Alert = {
  risk: "Medium",
  alertRef: "10055-5",
  alert: "CSP: script-src unsafe-inline",
  url: "http://localhost:3100/",
};
const COOKIE: Alert = {
  risk: "Low",
  alertRef: "10010",
  alert: "Cookie No HttpOnly Flag",
  url: "http://localhost:3100/api/todos",
};
const MODERN_APP: Alert = {
  risk: "Informational",
  alertRef: "10109",
  alert: "Modern Web Application",
  url: "http://localhost:3100/",
};

const IGNORE_CSP_STYLE = "10055-6\tMantine が style 属性で見た目を付けるため\n";

let dir: string;

beforeAll(() => {
  // WHY 一時ディレクトリ: 警告と除外のファイルをリポジトリの中に作ると、途中で落ちたときに作業ツリーに残る。
  dir = mkdtempSync(join(tmpdir(), "scan-zap-test-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

let counter = 0;
function judge(alerts: Alert[], ignore: string) {
  counter += 1;
  const alertsFile = join(dir, `alerts-${counter}.json`);
  const ignoreFile = join(dir, `ignore-${counter}.tsv`);
  writeFileSync(alertsFile, JSON.stringify({ alerts }));
  writeFileSync(ignoreFile, ignore);
  return spawnSync("bash", [scriptPath, "zap-alerts", alertsFile, ignoreFile], {
    encoding: "utf8",
  });
}

describe("scan.sh zap-alerts（must pass）", () => {
  it("警告が 0 件なら通る", () => {
    // given: 前提なし
    // when
    const result = judge([], "");

    // then
    expect(result.status).toBe(0);
  });

  it("Informational だけなら、表示して通る", () => {
    // given: 前提なし
    // when
    const result = judge([MODERN_APP, MODERN_APP], "");

    // then
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Informational 10109 Modern Web Application http://localhost:3100/",
    );
  });

  it("除外のファイルの alertRef と同じ警告は、何件あっても外して通る", () => {
    // given: 前提なし
    // when
    const result = judge([CSP_STYLE, CSP_STYLE, MODERN_APP], IGNORE_CSP_STYLE);

    // then
    expect(result.status).toBe(0);
  });

  it("除外のファイルのコメント行と空行は読み飛ばす", () => {
    // given: 前提なし
    // when
    const result = judge(
      [CSP_STYLE],
      `# alertRef<TAB>WHY\n\n${IGNORE_CSP_STYLE}`,
    );

    // then
    expect(result.status).toBe(0);
  });
});

describe("scan.sh zap-alerts（must reject）", () => {
  it("Medium の警告が 1 件あれば、危険度・alertRef・名前・URL を出して失敗する", () => {
    // given: 前提なし
    // when
    const result = judge([CSP_STYLE], "");

    // then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Medium 10055-6 CSP: style-src unsafe-inline http://localhost:3100/",
    );
  });

  it("Low の警告でも失敗する", () => {
    // given: 前提なし
    // when
    const result = judge([COOKIE], "");

    // then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Low 10010 Cookie No HttpOnly Flag");
  });

  it("同じ規則の別の alertRef は外さない（pluginId でまとめて外さない）", () => {
    // given: 前提なし
    // when
    const result = judge([CSP_STYLE, CSP_SCRIPT], IGNORE_CSP_STYLE);

    // then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("10055-5 CSP: script-src unsafe-inline");
    expect(result.stderr).not.toContain("10055-6");
  });

  it("除外した警告・Informational・外していない警告が混ざっていれば、外していない警告だけで失敗する", () => {
    // given: 前提なし
    // when
    const result = judge(
      [CSP_STYLE, MODERN_APP, COOKIE, CSP_SCRIPT],
      IGNORE_CSP_STYLE,
    );

    // then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Low 10010");
    expect(result.stderr).toContain("Medium 10055-5");
    expect(result.stderr).not.toContain("10055-6");
  });

  it("除外のファイルに pluginId（10055）を書いても、alertRef の 10055-6 は外さない（前方一致にしない）", () => {
    // given: 前提なし
    // when
    const result = judge([CSP_STYLE], "10055\tCSP の規則をまとめて外す\n");

    // then
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Medium 10055-6");
  });

  it.each([
    ["理由の無い行", "10055-6\n"],
    ["タブの後ろが空白だけの行", "10055-6\t  \n"],
  ])("除外のファイルに%sがあれば、警告を見る前に誤りにする", (_, ignore) => {
    // given: 前提なし（ignore は test.each の引数）
    // when
    const result = judge([], ignore);

    // then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("10055-6");
  });

  it("警告のファイルが ZAP の形（alerts の配列）でなければ、通さずに誤りにする", () => {
    // given
    counter += 1;
    const alertsFile = join(dir, `alerts-${counter}.json`);
    const ignoreFile = join(dir, `ignore-${counter}.tsv`);
    writeFileSync(alertsFile, JSON.stringify({ code: "bad_view" }));
    writeFileSync(ignoreFile, "");

    // when
    const result = spawnSync(
      "bash",
      [scriptPath, "zap-alerts", alertsFile, ignoreFile],
      { encoding: "utf8" },
    );

    // then
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a ZAP alerts response");
  });
});

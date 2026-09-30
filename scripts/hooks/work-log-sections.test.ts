// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは文字列の判定と子プロセスの node だけで
//   DOM を使わない。
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  findSectionsWithoutMechanization,
  runCli,
} from "./work-log-sections.mjs";

// 作業ログ（docs/work-logs/*.md）の diff から、追加された項目（`## ` の見出し）のうち `- 機械化:` の行が無いものを探す判定の仕様。
// Issue #178。Stop フック（require-work-log.sh）と CI（check-work-logs-diff.sh）が同じ判定を使う。
// WHY と限界は .claude/rules/work-log.md。

const scriptPath = resolve(import.meta.dirname, "work-log-sections.mjs");

// 新しいファイルの diff（git diff の見出し行つき）。
const newFileDiff = (path: string, lines: string[]) => [
  `diff --git a/${path} b/${path}`,
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  `+++ b/${path}`,
  `@@ -0,0 +1,${lines.length} @@`,
  ...lines.map((l) => `+${l}`),
];

describe("findSectionsWithoutMechanization", () => {
  describe("無しとして挙げる（must reject）", () => {
    it("見出し 1 つで `- 機械化:` の行が無ければ、その見出しを返す", () => {
      expect(
        findSectionsWithoutMechanization([
          "+## 調べた",
          "+- 理由: x",
          "+- 根拠: y",
        ]),
      ).toEqual(["調べた"]);
    });

    it("見出し 2 つで片方だけ無ければ、無い方だけを返す", () => {
      expect(
        findSectionsWithoutMechanization([
          "+## 一つ目",
          "+- 理由: x",
          "+- 機械化: 縛れない（判断の中身）",
          "+## 二つ目",
          "+- 理由: y",
        ]),
      ).toEqual(["二つ目"]);
    });

    it("次の見出しの `- 機械化:` を前の見出しに数えない（見出しの順が逆でも無い方だけ）", () => {
      expect(
        findSectionsWithoutMechanization([
          "+## 一つ目",
          "+- 理由: x",
          "+## 二つ目",
          "+- 機械化: 対象外（調査のみ）",
        ]),
      ).toEqual(["一つ目"]);
    });

    it("`- 機械化:` だけ（理由なし）は無しとして扱う", () => {
      expect(findSectionsWithoutMechanization(["+## a", "+- 機械化:"])).toEqual(
        ["a"],
      );
    });

    it("`- 機械化:` の後が空白だけなら無しとして扱う", () => {
      expect(
        findSectionsWithoutMechanization(["+## a", "+- 機械化:   \t"]),
      ).toEqual(["a"]);
    });

    it("`機械化:`（`- ` が無い）は無しとして扱う", () => {
      expect(
        findSectionsWithoutMechanization(["+## a", "+機械化: 縛れる（CI）"]),
      ).toEqual(["a"]);
    });

    it("`- 機械化 :`（コロンの前に空白）は無しとして扱う", () => {
      expect(
        findSectionsWithoutMechanization(["+## a", "+- 機械化 : 縛れる（CI）"]),
      ).toEqual(["a"]);
    });

    it("全角のコロン（`- 機械化：`）は無しとして扱う", () => {
      expect(
        findSectionsWithoutMechanization(["+## a", "+- 機械化： 縛れる（CI）"]),
      ).toEqual(["a"]);
    });

    it("見出しや本文の中に `- 機械化:` を含むだけ（行頭でない）は無しとして扱う", () => {
      expect(
        findSectionsWithoutMechanization([
          "+## a - 機械化: を足す",
          "+- 理由: `- 機械化: x` の行を必須にする",
        ]),
      ).toEqual(["a - 機械化: を足す"]);
    });

    it("`+` 以外の行（context・`-`）の `- 機械化:` は数えない", () => {
      // 削除した行・変わっていない行にある `- 機械化:` は、追加した項目のものではない。
      expect(
        findSectionsWithoutMechanization([
          "+## a",
          " - 機械化: 縛れる（元からある行）",
          "-- 機械化: 縛れる（消した行）",
        ]),
      ).toEqual(["a"]);
    });

    it("別のファイルの追加行を前のファイルの項目に数えない（ファイルの境目で項目を閉じる）", () => {
      // CI の diff は docs/work-logs/*.md の複数のファイルを含む。2 つ目のファイルの既存の項目に足した `- 機械化:` を、
      // 1 つ目のファイルで追加した項目の行と取り違えない。
      expect(
        findSectionsWithoutMechanization([
          ...newFileDiff("docs/work-logs/2026-09-29.md", ["## 昨日の項目"]),
          "diff --git a/docs/work-logs/2026-09-30.md b/docs/work-logs/2026-09-30.md",
          "index 1111111..2222222 100644",
          "--- a/docs/work-logs/2026-09-30.md",
          "+++ b/docs/work-logs/2026-09-30.md",
          "@@ -3,0 +4 @@",
          "+- 機械化: 縛れない（既存の項目への追記）",
        ]),
      ).toEqual(["昨日の項目"]);
    });

    it("見出しの前後の空白を除いて返し、`## ` だけの見出しは `##` として返す", () => {
      expect(
        findSectionsWithoutMechanization(["+##   前後に空白  ", "+## "]),
      ).toEqual(["前後に空白", "##"]);
    });
  });

  describe("挙げない（must pass）", () => {
    it("見出し 1 つで `- 機械化:` の行があれば空", () => {
      expect(
        findSectionsWithoutMechanization([
          "+## 調べた",
          "+- 理由: x",
          "+- 機械化: 縛れる（Stop フック）",
        ]),
      ).toEqual([]);
    });

    it("入れ子の箇条書き（`  - 機械化:`）でもよい", () => {
      expect(
        findSectionsWithoutMechanization([
          "+## a",
          "+- 判断:",
          "+  - 機械化: 縛れない（理由）",
        ]),
      ).toEqual([]);
    });

    it("コロンの後に空白が無くても、空白以外が 1 文字あればよい", () => {
      expect(
        findSectionsWithoutMechanization(["+## a", "+- 機械化:対象外"]),
      ).toEqual([]);
    });

    it("見出しの無い追加行だけ（既存の項目への追記）なら空", () => {
      expect(
        findSectionsWithoutMechanization([
          " ## 既存の項目",
          " - 理由: x",
          "+- 追記: y",
        ]),
      ).toEqual([]);
    });

    it("`###` や `#` の見出しは項目として数えない", () => {
      expect(
        findSectionsWithoutMechanization(["+# 2026-09-30", "+### 小見出し"]),
      ).toEqual([]);
    });

    it("`-` の行・context の行の `## ` は見出しとして数えない", () => {
      expect(
        findSectionsWithoutMechanization(["-## 消した項目", " ## 既存の項目"]),
      ).toEqual([]);
    });

    it("`+++`（ファイル名の行）などの diff の見出し行を追加行と誤認しない", () => {
      expect(
        findSectionsWithoutMechanization(
          newFileDiff("docs/work-logs/2026-09-30.md", [
            "# 2026-09-30",
            "",
            "## a",
            "- 機械化: 縛れる（CI）",
          ]),
        ),
      ).toEqual([]);
    });

    it("空の入力なら空", () => {
      expect(findSectionsWithoutMechanization([])).toEqual([]);
    });

    it("CRLF の行でも見出しと `- 機械化:` を読める", () => {
      expect(
        findSectionsWithoutMechanization(["+## a\r", "+- 機械化: x\r"]),
      ).toEqual([]);
    });
  });
});

describe("runCli（node scripts/hooks/work-log-sections.mjs として動くとき）", () => {
  const tmp = mkdtempSync(join(tmpdir(), "work-log-sections-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  async function runInProcess(entryPath: string | undefined, input: Buffer[]) {
    const output = new PassThrough();
    let written = "";
    output.on("data", (d: Buffer) => {
      written += d.toString("utf8");
    });
    const ran = await runCli(
      pathToFileURL(scriptPath).href,
      entryPath,
      Readable.from(input),
      output,
    );
    return { ran, written };
  }

  it("このファイルが入口のときだけ stdin の diff を読み、無い見出しを 1 行ずつ出す", async () => {
    const diff = "+## a\n+- 機械化: x\n+## b\n+## c\n";
    expect(await runInProcess(scriptPath, [Buffer.from(diff)])).toEqual({
      ran: true,
      written: "b\nc\n",
    });
  });

  it("無い見出しが無ければ何も出さない", async () => {
    expect(
      await runInProcess(scriptPath, [Buffer.from("+## a\n+- 機械化: x\n")]),
    ).toEqual({ ran: true, written: "" });
  });

  it("マルチバイト文字の途中で stdin の塊が切れても読める", async () => {
    const bytes = Buffer.from("+## 見出し\n");
    expect(
      await runInProcess(scriptPath, [bytes.subarray(0, 5), bytes.subarray(5)]),
    ).toEqual({ ran: true, written: "見出し\n" });
  });

  it("入口がシンボリックリンク経由でも、このファイルなら処理する", async () => {
    const link = join(tmp, "link.mjs");
    symlinkSync(scriptPath, link);
    expect(await runInProcess(link, [Buffer.from("+## a\n")])).toEqual({
      ran: true,
      written: "a\n",
    });
  });

  it("import されただけ（入口が別のファイル・入口が無い）なら stdin を読まない", async () => {
    expect(
      await runInProcess(resolve(import.meta.dirname, "guard-git.sh"), [
        Buffer.from("+## a\n"),
      ]),
    ).toEqual({ ran: false, written: "" });
    expect(await runInProcess(undefined, [Buffer.from("+## a\n")])).toEqual({
      ran: false,
      written: "",
    });
  });

  it("node で実行すると stdin の diff から無い見出しを stdout に出して 0 で終わる", () => {
    const result = spawnSync("node", [scriptPath], {
      input: "+## a\n+- 理由: x\n+## b\n+- 機械化: y\n",
      encoding: "utf8",
    });
    expect(result).toMatchObject({ status: 0, stdout: "a\n", stderr: "" });
  });
});

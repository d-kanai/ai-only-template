// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは bash を子プロセスで
//   起動するだけで DOM を使わない。Node 環境で動かし、jsdom の初期化コストと無関係な差異を避ける。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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

const repoRoot = resolve(__dirname, "..");
const scriptPath = join(repoRoot, "scripts", "cloud-session-start.sh");

// 期待値も .tool-versions から読む。スクリプトと同じ「唯一の情報源」を見ることで、
// 版を上げたときにテストの直書き値だけが古くなる事故を防ぐ。
function readToolVersion(tool: string): string {
  const content = readFileSync(join(repoRoot, ".tool-versions"), "utf8");
  const line = content.split("\n").find((l) => l.trim().startsWith(`${tool} `));
  if (!line) throw new Error(`.tool-versions に ${tool} の行がない`);
  return line.trim().split(/\s+/)[1];
}

const nodeVersion = readToolVersion("nodejs");
const pnpmVersion = readToolVersion("pnpm");
const nodeTarballUrl = `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-linux-`;

// 実インストール経路のテストで PATH の先頭に置く偽コマンド。
// - curl: 本物の nodejs.org に行かず、URL のファイル名に対応するフィクスチャを -o の先にコピーする。
//   受け取った引数を 1 行ずつ CURL_LOG に記録し、要求 URL やタイムアウト指定を検証できるようにする。
//   フィクスチャが無ければ curl -f と同じく 22 で失敗する。
// - uname: `uname -m` だけ FAKE_UNAME_M（既定 x86_64）を返す。実行マシン（Apple Silicon の arm64 など）に
//   テスト結果が左右されないようにするため。
// - npm / pnpm: 万一スクリプトが本物の npm / pnpm に届いても、ネットワークや実リポジトリに触れないよう失敗させる。
const FAKE_CURL = `#!/bin/bash
echo "$*" >> "$CURL_LOG"
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    http*) url="$1" ;;
  esac
  shift
done
src="$FIXTURE_DIR/$(basename "$url")"
[ -f "$src" ] || exit 22
cp "$src" "$out"
`;
const FAKE_UNAME = `#!/bin/bash
if [ "\${1:-}" = "-m" ]; then echo "\${FAKE_UNAME_M:-x86_64}"; else exec /usr/bin/uname "$@"; fi
`;
const FAKE_FAIL = `#!/bin/bash
echo "fake $(basename "$0") $*" >&2
exit 1
`;

describe("scripts/cloud-session-start.sh", () => {
  let tmp: string;
  let home: string;
  // 実行マシンの本物の /opt が書き込み可能かどうか（CI・他の開発機で異なる）にテスト結果が左右されないよう、
  // /opt の代わりの場所を CLOUD_SESSION_START_OPT_DIR で渡す。既定は存在しない（= 書けない）パスにする。
  let optDir: string;
  let envFile: string;
  let fakeBin: string;
  let fixtureDir: string;
  let curlLog: string;

  // 実行元（ローカル / CI / クラウド）の CLAUDE_CODE_REMOTE や CLAUDE_ENV_FILE がテストに漏れると、
  // 本物のインストールが走ったり実セッションの env ファイルに書き込んだりしうる。
  // そのため親の環境から関係する変数を取り除いた上で、テストごとに必要な値だけを足す。
  // 値が undefined のキーは「その変数を渡さない」を意味する（HOME 未設定のテスト用）。
  // 型を NodeJS.ProcessEnv にしているのは、Next.js の型定義が ProcessEnv の NODE_ENV を必須にしており、
  // Record<string, string> だと `next build` の型チェックで spawnSync の env に渡せないため。
  function runScript(
    args: string[],
    extraEnv: Record<string, string | undefined>,
  ) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.CLAUDE_CODE_REMOTE;
    delete env.CLAUDE_ENV_FILE;
    delete env.CLOUD_SESSION_START_DRY_RUN;
    Object.assign(env, {
      CLAUDE_PROJECT_DIR: repoRoot,
      HOME: home,
      CLOUD_SESSION_START_OPT_DIR: optDir,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FIXTURE_DIR: fixtureDir,
      CURL_LOG: curlLog,
    });
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return spawnSync("bash", [scriptPath, ...args], { env, encoding: "utf8" });
  }

  function curlCalls(): string[] {
    return existsSync(curlLog)
      ? readFileSync(curlLog, "utf8").split("\n").filter(Boolean)
      : [];
  }

  // 既存インストールの検出はファイルの有無（実行可能か）だけで行うので、中身はダミーでよい。
  function placeFakeNode(nodeDir: string) {
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    writeFileSync(join(nodeDir, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  }

  // nodejs.org の配布物と同じ構成（node-v<版>-<platform>/bin/node）の tar.xz と SHASUMS256.txt を作る。
  // node はダミー（実行すると失敗する）なので、その後の npm install -g pnpm は失敗する前提。
  function buildNodeFixture(
    platform: "linux-x64" | "linux-arm64",
    shasums: "ok" | "mismatch" | "missing",
  ) {
    const name = `node-v${nodeVersion}-${platform}`;
    const stage = join(tmp, "stage");
    mkdirSync(join(stage, name, "bin"), { recursive: true });
    writeFileSync(join(stage, name, "bin", "node"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    const tarball = join(fixtureDir, `${name}.tar.xz`);
    const tar = spawnSync("tar", ["-cJf", tarball, "-C", stage, name], {
      encoding: "utf8",
    });
    if (tar.status !== 0) {
      // スクリプトは tar -xJf で展開するので、xz を扱えない環境ではスクリプト自体も動かない。
      throw new Error(`tar -cJf に失敗（xz が必要）: ${tar.stderr}`);
    }
    const sha = createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex");
    const lines = {
      ok: `${sha}  ${name}.tar.xz\n`,
      mismatch: `${"0".repeat(64)}  ${name}.tar.xz\n`,
      missing: `${sha}  node-v${nodeVersion}-darwin-x64.tar.xz\n`,
    };
    writeFileSync(join(fixtureDir, "SHASUMS256.txt"), lines[shasums]);
  }

  const remoteEnv = () => ({
    CLAUDE_CODE_REMOTE: "true",
    CLAUDE_ENV_FILE: envFile,
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cloud-session-start-"));
    home = join(tmp, "home");
    mkdirSync(home);
    optDir = join(tmp, "opt-not-writable");
    envFile = join(tmp, "claude-env");
    // 既存の内容を消さず追記（>>）すること・何も書かないことを確認するため、先に 1 行入れておく。
    writeFileSync(envFile, "export EXISTING=1\n");
    fakeBin = join(tmp, "fakebin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "curl"), FAKE_CURL, { mode: 0o755 });
    writeFileSync(join(fakeBin, "uname"), FAKE_UNAME, { mode: 0o755 });
    writeFileSync(join(fakeBin, "npm"), FAKE_FAIL, { mode: 0o755 });
    writeFileSync(join(fakeBin, "pnpm"), FAKE_FAIL, { mode: 0o755 });
    fixtureDir = join(tmp, "fixtures");
    mkdirSync(fixtureDir);
    curlLog = join(tmp, "curl.log");
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("フックとして何もしない場合", () => {
    // DRY_RUN を付けるのは、変異などで CLAUDE_CODE_REMOTE の判定が外れたときに本物のダウンロードや
    // pnpm install を走らせないため。DRY_RUN でも実行予定が stdout に出るので、判定漏れは検出できる。
    it("CLAUDE_CODE_REMOTE が未設定なら何もせず exit 0（ローカルのセッションに影響しない）", () => {
      const result = runScript([], {
        CLOUD_SESSION_START_DRY_RUN: "1",
        CLAUDE_ENV_FILE: envFile,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
    });

    it("CLAUDE_CODE_REMOTE=false なら何もせず exit 0", () => {
      const result = runScript([], {
        CLAUDE_CODE_REMOTE: "false",
        CLOUD_SESSION_START_DRY_RUN: "1",
        CLAUDE_ENV_FILE: envFile,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
    });

    it.each([
      ["空", ""],
      ["未設定", undefined],
    ])(
      "HOME が%sなら warn を出して何もせず exit 0（インストール先が /.local/node-<版> になるのを防ぐ）",
      (_label, homeValue) => {
        const result = runScript([], {
          ...remoteEnv(),
          CLOUD_SESSION_START_DRY_RUN: "1",
          HOME: homeValue,
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("HOME");
        expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
      },
    );
  });

  describe("--print-plan", () => {
    it(".tool-versions の Node / pnpm の版とインストール先を表示して exit 0（/opt に書けなければ $HOME/.local）", () => {
      const result = runScript(["--print-plan"], {});
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`nodejs ${nodeVersion}`);
      expect(result.stdout).toContain(`pnpm ${pnpmVersion}`);
      expect(result.stdout).toContain(
        join(home, ".local", `node-${nodeVersion}`),
      );
    });

    it("/opt に書き込めるなら /opt/node-<版> に入れる", () => {
      optDir = join(tmp, "opt-writable");
      mkdirSync(optDir);
      const result = runScript(["--print-plan"], {});
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(join(optDir, `node-${nodeVersion}`));
      expect(result.stdout).not.toContain(join(home, ".local"));
    });

    it(".tool-versions が CRLF でも版に \\r を含めない", () => {
      const project = join(tmp, "project");
      mkdirSync(project);
      writeFileSync(
        join(project, ".tool-versions"),
        `nodejs ${nodeVersion}\r\npnpm ${pnpmVersion}\r\n`,
      );
      const result = runScript(["--print-plan"], {
        CLAUDE_PROJECT_DIR: project,
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`nodejs ${nodeVersion}\n`);
      expect(result.stdout).toContain(`pnpm ${pnpmVersion}\n`);
      expect(result.stdout).not.toContain("\r");
    });
  });

  // フック（引数なし、CLAUDE_CODE_REMOTE=true）の Node / pnpm の導入は一時停止中（スクリプトの main の WHY コメント）。
  // クラウド環境の Network access が nodejs.org を拒否して毎回失敗し、pnpm install まで進まなかったため、
  // フックは PATH 上の pnpm（VM 既定）で pnpm install だけを行う。nodejs.org を許可して導入を戻すときは、
  // このブロックの期待（ダウンロード予定を出さない・PATH を書かない）も戻す。
  describe("フック（Node / pnpm の導入は一時停止中）", () => {
    const pnpmInstallPlan = `[dry-run] (cd ${repoRoot} && pnpm install --frozen-lockfile)\n`;

    it("DRY_RUN: nodejs.org からの取得・pnpm の導入の予定を出さず、pnpm install の予定だけを出し、CLAUDE_ENV_FILE に書かない", () => {
      const result = runScript([], {
        ...remoteEnv(),
        CLOUD_SESSION_START_DRY_RUN: "1",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain(nodeTarballUrl);
      expect(result.stdout).not.toContain("SHASUMS256.txt");
      expect(result.stdout).not.toContain("npm install -g pnpm");
      expect(result.stdout).toBe(pnpmInstallPlan);
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
    });

    it.each([
      ["$HOME/.local", () => join(home, ".local", `node-${nodeVersion}`)],
      ["/opt", () => join(optDir, `node-${nodeVersion}`)],
    ])(
      "DRY_RUN: 既存インストール（%s）があっても使わず（PATH を書かず）、pnpm install の予定だけを出す",
      (_label, nodeDirOf) => {
        const nodeDir = nodeDirOf();
        placeFakeNode(nodeDir);

        const result = runScript([], {
          ...remoteEnv(),
          CLOUD_SESSION_START_DRY_RUN: "1",
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toBe(pnpmInstallPlan);
        expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
      },
    );

    it("実行: curl を 1 回も呼ばず、PATH 上の pnpm で pnpm install --frozen-lockfile を実行する。失敗しても warn だけで exit 0", () => {
      // 取得できる配布物を置いておく。導入処理が動けば curl が呼ばれ、$HOME/.local に展開されるので検出できる。
      buildNodeFixture("linux-x64", "ok");

      const result = runScript([], remoteEnv());

      expect(result.status).toBe(0);
      expect(curlCalls()).toEqual([]);
      expect(existsSync(join(home, ".local"))).toBe(false);
      // 偽の pnpm（fakeBin）が受け取った引数を stderr に出すので、PATH 上の pnpm が呼ばれたことを確認できる。
      expect(result.stderr).toContain("fake pnpm install --frozen-lockfile");
      expect(result.stderr).toContain("pnpm install --frozen-lockfile failed");
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
    });
  });

  describe("DRY_RUN（--install-only）", () => {
    it("--install-only は CLAUDE_CODE_REMOTE が無くてもインストール予定を出し、CLAUDE_ENV_FILE に書かず pnpm install もしない（setup script 用）", () => {
      const result = runScript(["--install-only"], {
        CLAUDE_ENV_FILE: envFile,
        CLOUD_SESSION_START_DRY_RUN: "1",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(nodeTarballUrl);
      expect(result.stdout).toContain(`npm install -g pnpm@${pnpmVersion}`);
      expect(result.stdout).not.toContain("pnpm install --frozen-lockfile");
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
    });
  });

  // 偽の curl でダウンロードを差し替え、取得 → SHASUMS 検証 → 展開 → 配置 の実処理を通す。
  // フックでは導入を一時停止しているため、導入処理が今も動くことは setup script 用の --install-only で確かめる。
  // setup script と同じく CLAUDE_CODE_REMOTE は渡さない。CLAUDE_ENV_FILE は「書かれない」ことを確かめるために渡す。
  describe("実インストール経路（--install-only、偽の curl）", () => {
    const nodeDirIn = () => join(home, ".local", `node-${nodeVersion}`);
    const installOnlyEnv = () => ({ CLAUDE_ENV_FILE: envFile });

    it("正常: 展開して bin/node を配置し、PATH は書かない。ダミー node で pnpm 導入が失敗しても warn だけで exit 0", () => {
      buildNodeFixture("linux-x64", "ok");

      const result = runScript(["--install-only"], installOnlyEnv());

      expect(result.status).toBe(0);
      expect(existsSync(join(nodeDirIn(), "bin", "node"))).toBe(true);
      // ダウンロード用の一時ディレクトリが残っていない
      expect(readdirSync(join(home, ".local"))).toEqual([
        `node-${nodeVersion}`,
      ]);
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
      expect(result.stderr).toContain(`failed to install pnpm@${pnpmVersion}`);
    });

    it("curl に接続タイムアウト 15 秒と、tarball は 240 秒・SHASUMS256.txt は 60 秒の全体タイムアウトを付ける（最悪でもフックの 600 秒打ち切りより十分前に終える）", () => {
      buildNodeFixture("linux-x64", "ok");

      runScript(["--install-only"], installOnlyEnv());

      const calls = curlCalls();
      const tarballCall = calls.find((c) => c.includes(".tar.xz"));
      const shasumsCall = calls.find((c) => c.includes("SHASUMS256.txt"));
      expect(tarballCall).toContain("--connect-timeout 15");
      expect(tarballCall).toContain("--max-time 240");
      expect(shasumsCall).toContain("--connect-timeout 15");
      expect(shasumsCall).toContain("--max-time 60");
    });

    it.each([
      ["SHASUMS のハッシュが一致しない", "mismatch"],
      ["SHASUMS に対象の行が無い", "missing"],
    ] as const)(
      "%s: 展開せず、一時ディレクトリも残さず、PATH も書かずに exit 0",
      (_label, shasums) => {
        buildNodeFixture("linux-x64", shasums);

        const result = runScript(["--install-only"], installOnlyEnv());

        expect(result.status).toBe(0);
        expect(result.stderr).toContain("sha256 mismatch");
        expect(readdirSync(join(home, ".local"))).toEqual([]);
        expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
      },
    );

    it("uname -m が aarch64 なら linux-arm64 の配布物を取得する", () => {
      buildNodeFixture("linux-arm64", "ok");

      const result = runScript(["--install-only"], {
        ...installOnlyEnv(),
        FAKE_UNAME_M: "aarch64",
      });

      expect(result.status).toBe(0);
      const urls = curlCalls().join("\n");
      expect(urls).toContain(`node-v${nodeVersion}-linux-arm64.tar.xz`);
      expect(urls).not.toContain("linux-x64");
      expect(existsSync(join(nodeDirIn(), "bin", "node"))).toBe(true);
    });

    it("uname -m が x86_64 / aarch64 以外なら warn を出してダウンロードせず、PATH も書かずに exit 0", () => {
      buildNodeFixture("linux-x64", "ok");

      const result = runScript(["--install-only"], {
        ...installOnlyEnv(),
        FAKE_UNAME_M: "armv7l",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("armv7l");
      expect(curlCalls()).toEqual([]);
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
    });

    it("bin/node が無い壊れた node-<版> ディレクトリがあれば、置き換えてから配置する（入れ子にしない）", () => {
      buildNodeFixture("linux-x64", "ok");
      mkdirSync(nodeDirIn(), { recursive: true });
      writeFileSync(join(nodeDirIn(), "leftover"), "broken");

      const result = runScript(["--install-only"], installOnlyEnv());

      expect(result.status).toBe(0);
      expect(existsSync(join(nodeDirIn(), "bin", "node"))).toBe(true);
      expect(
        existsSync(join(nodeDirIn(), `node-v${nodeVersion}-linux-x64`)),
      ).toBe(false);
      expect(existsSync(join(nodeDirIn(), "leftover"))).toBe(false);
    });
  });
});

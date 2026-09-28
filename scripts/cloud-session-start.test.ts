// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストは bash を子プロセスで
//   起動するだけで DOM を使わない。Node 環境で動かし、jsdom の初期化コストと無関係な差異を避ける。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const REGISTRY = "https://registry.npmjs.org";
type Platform = "linux-x64" | "linux-arm64";
type Integrity = "ok" | "mismatch" | "missing";
const nodeRegistryMetaUrl = (platform: Platform) =>
  `${REGISTRY}/node-${platform}/${nodeVersion}`;
const pnpmMetaUrl = `${REGISTRY}/pnpm/${pnpmVersion}`;
const pnpmExeMetaUrl = (platform: Platform) =>
  `${REGISTRY}/@pnpm/exe.${platform}/${pnpmVersion}`;

// @pnpm/exe.<platform> に入っているネイティブバイナリの代わり。--version には .tool-versions の版を返し、
// それ以外（pnpm install）は引数を stderr に出すだけにする。スクリプトが入れた pnpm で
// pnpm install まで進んだことを stderr で確かめられるようにするため。
const FAKE_NATIVE_PNPM = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${pnpmVersion}"; else echo "fake native pnpm $*" >&2; fi
`;

// 実インストール経路のテストで PATH の先頭に置く偽コマンド。
// - curl: 本物の nodejs.org / npm レジストリに行かず、URL から https:// を除いたパス
//   （例: fixtures/registry.npmjs.org/pnpm/<版>）にあるフィクスチャを -o の先にコピーする。ファイル名だけで引くと
//   pnpm/<版> と @pnpm/exe.<platform>/<版> のメタデータのように、別の URL が同じ名前になって区別できないため。
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
src="$FIXTURE_DIR/\${url#https://}"
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

// Postgres の起動（docker compose）のテストで PATH の先頭に置く偽コマンド。
// WHY 偽物にするか: この VM や GitHub Actions には本物の docker / dockerd があり、テストから本物のデーモンを
//   起動したりコンテナを立てたりしないため。どのテストでも既定で fakeBin に置く。
// - docker: 呼ばれたときのカレントディレクトリと引数を 1 行ずつ DOCKER_LOG に記録する（compose をリポジトリ直下で
//   実行したかを確かめるため）。`docker info` はデーモンが動いている印のファイル（FAKE_DOCKER_READY）があるときだけ
//   成功する。`docker compose pull` は最初の FAKE_COMPOSE_PULL_FAILS 回（既定 0）だけ失敗する（回数は
//   FAKE_COMPOSE_PULL_COUNT のファイルで数える。再試行を確かめるため）。それ以外の `docker compose` は
//   FAKE_COMPOSE_EXIT（既定 0）で終わる。
// - dockerd: 呼ばれたこと（"dockerd <引数>"。引数なしでも空行にならないよう名前を付ける）を DOCKERD_LOG に記録し、stdout に 1 行出す（ログファイルへのリダイレクトを確かめるため）。
//   FAKE_DOCKERD_STARTS が 0 でなければ FAKE_DOCKER_READY を作り、「起動したらデーモンが使えるようになる」を再現する。
const FAKE_DOCKER = `#!/bin/bash
echo "$PWD $*" >> "$DOCKER_LOG"
case "$1" in
  info) [ -f "$FAKE_DOCKER_READY" ] ;;
  compose)
    if [ "$2" = "pull" ]; then
      n=$(( $(cat "$FAKE_COMPOSE_PULL_COUNT" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$FAKE_COMPOSE_PULL_COUNT"
      [ "$n" -gt "\${FAKE_COMPOSE_PULL_FAILS:-0}" ]
      exit
    fi
    exit "\${FAKE_COMPOSE_EXIT:-0}" ;;
  *) exit 1 ;;
esac
`;
// pull の再試行の間隔を確かめるための偽 sleep。待たずに、引数（秒数）を SLEEP_LOG に記録するだけ。
// WHY 再試行のテストでだけ置く: dockerd の起動待ち（sleep 1 を挟んで docker info を繰り返す）のテストに置くと、
//   待たずに docker info を連打することになるため。
const FAKE_SLEEP = `#!/bin/bash
echo "$*" >> "$SLEEP_LOG"
`;
const FAKE_DOCKERD = `#!/bin/bash
echo "dockerd $*" >> "$DOCKERD_LOG"
echo "fake dockerd started"
if [ "\${FAKE_DOCKERD_STARTS:-1}" != "0" ]; then touch "$FAKE_DOCKER_READY"; fi
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
  let dockerLog: string;
  let dockerdLog: string;
  let dockerReady: string;

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
    delete env.CLOUD_SESSION_START_DOCKER_WAIT_SECONDS;
    Object.assign(env, {
      CLAUDE_PROJECT_DIR: repoRoot,
      HOME: home,
      CLOUD_SESSION_START_OPT_DIR: optDir,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FIXTURE_DIR: fixtureDir,
      CURL_LOG: curlLog,
      DOCKER_LOG: dockerLog,
      DOCKERD_LOG: dockerdLog,
      FAKE_DOCKER_READY: dockerReady,
      FAKE_COMPOSE_PULL_COUNT: join(tmp, "compose-pull-count"),
      SLEEP_LOG: join(tmp, "sleep.log"),
      // dockerd のログは $TMPDIR（既定 /tmp）に書く。実行マシンの本物の /tmp/dockerd.log を上書きしないよう、
      // テストごとの一時ディレクトリを渡す。
      TMPDIR: tmp,
    });
    for (const [key, value] of Object.entries(extraEnv)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
    return spawnSync("bash", [scriptPath, ...args], { env, encoding: "utf8" });
  }

  function logLines(file: string): string[] {
    return existsSync(file)
      ? readFileSync(file, "utf8").split("\n").filter(Boolean)
      : [];
  }

  function curlCalls(): string[] {
    return logLines(curlLog);
  }

  // 既存インストールの検出はファイルの有無（実行可能か）だけで行うので、中身はダミーでよい。
  function placeFakeNode(nodeDir: string) {
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    writeFileSync(join(nodeDir, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  }

  // nodejs.org の配布物と同じ構成（node-v<版>-<platform>/bin/node）の tar.xz と SHASUMS256.txt を作る。
  // node はダミー（実行すると失敗する）。pnpm はレジストリのフィクスチャ（buildPnpmFixtures）が無ければ取得に失敗する。
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
    const distDir = join(fixtureDir, "nodejs.org", "dist", `v${nodeVersion}`);
    mkdirSync(distDir, { recursive: true });
    const tarball = join(distDir, `${name}.tar.xz`);
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
    writeFileSync(join(distDir, "SHASUMS256.txt"), lines[shasums]);
  }

  // npm レジストリと同じ構成のフィクスチャを作る: 版のメタデータ（<name>/<版>。dist.integrity と dist.tarball を持つ JSON）と、
  // package/ 以下に files を入れた tarball（<name>/-/<スコープを除いた name>-<版>.tgz）。
  // integrity は ok = tarball の sha512（base64）、mismatch = 別の内容の sha512、missing = メタデータに書かない。
  function buildRegistryFixture(
    name: string,
    version: string,
    files: Record<string, string>,
    integrity: Integrity = "ok",
  ) {
    const stage = mkdtempSync(join(tmp, "stage-"));
    for (const [rel, content] of Object.entries(files)) {
      const file = join(stage, "package", rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content, { mode: 0o755 });
    }
    const unscoped = name.split("/").pop();
    const tgzPath = `${name}/-/${unscoped}-${version}.tgz`;
    const tgz = join(fixtureDir, "registry.npmjs.org", tgzPath);
    mkdirSync(dirname(tgz), { recursive: true });
    const tar = spawnSync("tar", ["-czf", tgz, "-C", stage, "package"], {
      encoding: "utf8",
    });
    if (tar.status !== 0) throw new Error(`tar -czf に失敗: ${tar.stderr}`);

    const sha512 = (data: Buffer | string) =>
      `sha512-${createHash("sha512").update(data).digest("base64")}`;
    const dist: Record<string, string> = {
      tarball: `${REGISTRY}/${tgzPath}`,
    };
    if (integrity === "ok") dist.integrity = sha512(readFileSync(tgz));
    if (integrity === "mismatch") dist.integrity = sha512("other content");
    writeFileSync(
      join(fixtureDir, "registry.npmjs.org", name, version),
      JSON.stringify({ name, version, dist }),
    );
  }

  // node-bin-gen の node-linux-<arch> と同じく、package/bin/node だけを持つ（npm は同梱されない）。
  function buildRegistryNodeFixture(platform: Platform, integrity: Integrity) {
    buildRegistryFixture(
      `node-${platform}`,
      nodeVersion,
      { "bin/node": "#!/bin/sh\nexit 1\n", "package.json": "{}\n" },
      integrity,
    );
  }

  // pnpm 12 の配布物と同じ構成: pnpm パッケージの package/pnpm は placeholder（ネイティブバイナリで置き換えられる前提の
  // スクリプト）で、ネイティブバイナリは @pnpm/exe.<platform> の package/pnpm にある。
  function buildPnpmFixtures(
    platform: Platform = "linux-x64",
    exeIntegrity: Integrity = "ok",
  ) {
    buildRegistryFixture("pnpm", pnpmVersion, {
      pnpm: "#!/bin/sh\necho placeholder >&2\nexit 1\n",
      "bin/pnpm.mjs": "// dummy\n",
      "package.json": "{}\n",
    });
    buildRegistryFixture(
      `@pnpm/exe.${platform}`,
      pnpmVersion,
      { pnpm: FAKE_NATIVE_PNPM },
      exeIntegrity,
    );
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
    writeFileSync(join(fakeBin, "docker"), FAKE_DOCKER, { mode: 0o755 });
    writeFileSync(join(fakeBin, "dockerd"), FAKE_DOCKERD, { mode: 0o755 });
    dockerLog = join(tmp, "docker.log");
    dockerdLog = join(tmp, "dockerd-args.log");
    // 既定は「デーモンが起動済み」。Postgres の起動を主題にしない既存のテストで、デーモンの起動待ちが入らないようにするため。
    dockerReady = join(tmp, "docker-ready");
    writeFileSync(dockerReady, "");
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

    it("nodejs.org に届かないときに使う npm レジストリの URL（Node と pnpm）も表示する", () => {
      const result = runScript(["--print-plan"], {});
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(nodeRegistryMetaUrl("linux-x64"));
      expect(result.stdout).toContain(pnpmMetaUrl);
      expect(result.stdout).toContain(pnpmExeMetaUrl("linux-x64"));
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

  describe("DRY_RUN", () => {
    it("CLAUDE_CODE_REMOTE=true（未インストール）なら、インストール予定を表示し CLAUDE_ENV_FILE に PATH を追記する", () => {
      const result = runScript([], {
        ...remoteEnv(),
        CLOUD_SESSION_START_DRY_RUN: "1",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(nodeTarballUrl);
      expect(result.stdout).toContain(`SHASUMS256.txt`);
      expect(result.stdout).toContain(nodeRegistryMetaUrl("linux-x64"));
      expect(result.stdout).toContain(pnpmMetaUrl);
      expect(result.stdout).toContain(pnpmExeMetaUrl("linux-x64"));
      expect(result.stdout).not.toContain("npm install -g");
      expect(result.stdout).toContain("pnpm install --frozen-lockfile");

      const nodeBin = join(home, ".local", `node-${nodeVersion}`, "bin");
      expect(readFileSync(envFile, "utf8")).toBe(
        `export EXISTING=1\nexport PATH="${nodeBin}:$PATH"\n`,
      );
    });

    it("--install-only は CLAUDE_CODE_REMOTE が無くてもインストール予定を出し、CLAUDE_ENV_FILE に書かず pnpm install もしない（setup script 用）", () => {
      const result = runScript(["--install-only"], {
        CLAUDE_ENV_FILE: envFile,
        CLOUD_SESSION_START_DRY_RUN: "1",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(nodeTarballUrl);
      expect(result.stdout).toContain(nodeRegistryMetaUrl("linux-x64"));
      expect(result.stdout).toContain(pnpmMetaUrl);
      expect(result.stdout).toContain(pnpmExeMetaUrl("linux-x64"));
      expect(result.stdout).not.toContain("npm install -g");
      expect(result.stdout).not.toContain("pnpm install --frozen-lockfile");
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
    });

    it.each([
      ["$HOME/.local", () => join(home, ".local", `node-${nodeVersion}`)],
      ["/opt", () => join(optDir, `node-${nodeVersion}`)],
    ])(
      "既存インストール（%s）があればダウンロード予定を出さず、その bin を PATH に追記して pnpm install する",
      (_label, nodeDirOf) => {
        const nodeDir = nodeDirOf();
        placeFakeNode(nodeDir);

        const result = runScript([], {
          ...remoteEnv(),
          CLOUD_SESSION_START_DRY_RUN: "1",
        });

        expect(result.status).toBe(0);
        expect(result.stdout).not.toContain(nodeTarballUrl);
        expect(result.stdout).not.toContain("SHASUMS256.txt");
        expect(result.stdout).not.toContain(nodeRegistryMetaUrl("linux-x64"));
        expect(result.stdout).toContain("pnpm install --frozen-lockfile");
        expect(readFileSync(envFile, "utf8")).toBe(
          `export EXISTING=1\nexport PATH="${join(nodeDir, "bin")}:$PATH"\n`,
        );
      },
    );
  });

  // 偽の curl でダウンロードを差し替え、取得 → 検証 → 展開 → 配置 の実処理を通す。
  describe("実インストール経路（偽の curl）", () => {
    const nodeDirIn = () => join(home, ".local", `node-${nodeVersion}`);
    const envWithPath = () =>
      `export EXISTING=1\nexport PATH="${join(nodeDirIn(), "bin")}:$PATH"\n`;

    it("正常: 展開して bin/node を配置し PATH を追記する。nodejs.org で取れればレジストリには行かない。pnpm が取れなくても warn だけで exit 0", () => {
      buildNodeFixture("linux-x64", "ok");

      const result = runScript([], remoteEnv());

      expect(result.status).toBe(0);
      expect(existsSync(join(nodeDirIn(), "bin", "node"))).toBe(true);
      // ダウンロード用の一時ディレクトリが残っていない
      expect(readdirSync(join(home, ".local"))).toEqual([
        `node-${nodeVersion}`,
      ]);
      expect(readFileSync(envFile, "utf8")).toBe(envWithPath());
      expect(curlCalls().join("\n")).not.toContain("node-linux-x64");
      expect(result.stderr).toContain(`failed to install pnpm@${pnpmVersion}`);
    });

    it("curl に接続タイムアウト 15 秒と、取得物ごとの全体タイムアウトを付け、最悪ケースの合計をフックの 600 秒打ち切りより十分小さく（400 秒以下に）する", () => {
      // nodejs.org の SHASUMS 不一致でレジストリにフォールバックさせ、Node・pnpm の取得 8 回をすべて通す。
      buildNodeFixture("linux-x64", "mismatch");
      buildRegistryNodeFixture("linux-x64", "ok");
      buildPnpmFixtures();

      runScript([], remoteEnv());

      const calls = curlCalls();
      const expected: [string, (c: string) => boolean, number][] = [
        ["nodejs.org tarball", (c) => c.endsWith(".tar.xz"), 60],
        ["SHASUMS256.txt", (c) => c.endsWith("SHASUMS256.txt"), 20],
        [
          "node メタデータ",
          (c) => c.endsWith(nodeRegistryMetaUrl("linux-x64")),
          20,
        ],
        [
          "node tarball",
          (c) => c.endsWith(`node-linux-x64-${nodeVersion}.tgz`),
          60,
        ],
        ["pnpm メタデータ", (c) => c.endsWith(pnpmMetaUrl), 20],
        ["pnpm tarball", (c) => c.endsWith(`pnpm-${pnpmVersion}.tgz`), 20],
        [
          "@pnpm/exe メタデータ",
          (c) => c.endsWith(pnpmExeMetaUrl("linux-x64")),
          20,
        ],
        [
          "@pnpm/exe tarball",
          (c) => c.endsWith(`exe.linux-x64-${pnpmVersion}.tgz`),
          60,
        ],
      ];
      expect(calls).toHaveLength(expected.length);
      let worstCase = 0;
      for (const [label, match, maxTime] of expected) {
        const call = calls.find(match);
        expect(call, label).toBeDefined();
        expect(call, label).toContain("--connect-timeout 15");
        expect(call, label).toContain(`--max-time ${maxTime}`);
        // --max-time は接続を含む全体の上限なので実際の最悪値は max-time の和だが、
        // 既存の考え方に合わせて接続タイムアウトも足した保守的な値で上限を確かめる。
        worstCase += 15 + maxTime;
      }
      expect(worstCase).toBeLessThanOrEqual(400);
    });

    it.each([
      ["SHASUMS のハッシュが一致しない", "mismatch"],
      ["SHASUMS に対象の行が無い", "missing"],
    ] as const)(
      "%s（レジストリにも無い）: 展開せず、一時ディレクトリも残さず、PATH も書かずに exit 0",
      (_label, shasums) => {
        buildNodeFixture("linux-x64", shasums);

        const result = runScript([], remoteEnv());

        expect(result.status).toBe(0);
        expect(result.stderr).toContain("sha256 mismatch");
        expect(readdirSync(join(home, ".local"))).toEqual([]);
        expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
      },
    );

    it("uname -m が aarch64 なら linux-arm64 の配布物（Node と @pnpm/exe）を取得する", () => {
      buildNodeFixture("linux-arm64", "ok");
      buildPnpmFixtures("linux-arm64");

      const result = runScript([], { ...remoteEnv(), FAKE_UNAME_M: "aarch64" });

      expect(result.status).toBe(0);
      const urls = curlCalls().join("\n");
      expect(urls).toContain(`node-v${nodeVersion}-linux-arm64.tar.xz`);
      expect(urls).toContain(pnpmExeMetaUrl("linux-arm64"));
      expect(urls).not.toContain("linux-x64");
      expect(existsSync(join(nodeDirIn(), "bin", "node"))).toBe(true);
      expect(existsSync(join(nodeDirIn(), "bin", "pnpm"))).toBe(true);
    });

    it("uname -m が x86_64 / aarch64 以外なら warn を出してダウンロードせず、PATH も書かずに exit 0", () => {
      buildNodeFixture("linux-x64", "ok");

      const result = runScript([], { ...remoteEnv(), FAKE_UNAME_M: "armv7l" });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("armv7l");
      expect(curlCalls()).toEqual([]);
      expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
    });

    it("bin/node が無い壊れた node-<版> ディレクトリがあれば、置き換えてから配置する（入れ子にしない）", () => {
      buildNodeFixture("linux-x64", "ok");
      mkdirSync(nodeDirIn(), { recursive: true });
      writeFileSync(join(nodeDirIn(), "leftover"), "broken");

      const result = runScript([], remoteEnv());

      expect(result.status).toBe(0);
      expect(existsSync(join(nodeDirIn(), "bin", "node"))).toBe(true);
      expect(
        existsSync(join(nodeDirIn(), `node-v${nodeVersion}-linux-x64`)),
      ).toBe(false);
      expect(existsSync(join(nodeDirIn(), "leftover"))).toBe(false);
    });
  });

  // クラウドのネットワークポリシーで nodejs.org が 403 になる（2026-09-28 実測）ときの経路。
  // nodejs.org のフィクスチャを置かないことで、偽の curl が 22 で失敗する = 403 と同じ扱いになる。
  describe("npm レジストリへのフォールバック（nodejs.org に届かない）", () => {
    const nodeDirIn = () => join(home, ".local", `node-${nodeVersion}`);

    it("レジストリの node-linux-x64 を integrity 検証して展開し、bin/node を配置して PATH を追記する", () => {
      buildRegistryNodeFixture("linux-x64", "ok");

      const result = runScript([], remoteEnv());

      expect(result.status).toBe(0);
      const urls = curlCalls().join("\n");
      expect(urls).toContain(nodeTarballUrl);
      expect(urls).toContain(nodeRegistryMetaUrl("linux-x64"));
      expect(urls).toContain(`node-linux-x64-${nodeVersion}.tgz`);
      expect(existsSync(join(nodeDirIn(), "bin", "node"))).toBe(true);
      expect(readdirSync(join(home, ".local"))).toEqual([
        `node-${nodeVersion}`,
      ]);
      expect(readFileSync(envFile, "utf8")).toBe(
        `export EXISTING=1\nexport PATH="${join(nodeDirIn(), "bin")}:$PATH"\n`,
      );
      expect(result.stderr).toContain("npm registry");
    });

    it.each([
      ["integrity が一致しない", "mismatch"],
      ["メタデータに integrity が無い", "missing"],
    ] as const)(
      "%s: 展開せず、一時ディレクトリも残さず、PATH も書かずに exit 0",
      (_label, integrity) => {
        buildRegistryNodeFixture("linux-x64", integrity);

        const result = runScript([], remoteEnv());

        expect(result.status).toBe(0);
        expect(result.stderr).toContain("integrity");
        expect(readdirSync(join(home, ".local"))).toEqual([]);
        expect(readFileSync(envFile, "utf8")).toBe("export EXISTING=1\n");
      },
    );

    it("uname -m が aarch64 なら node-linux-arm64 を取得する", () => {
      buildRegistryNodeFixture("linux-arm64", "ok");

      const result = runScript([], { ...remoteEnv(), FAKE_UNAME_M: "aarch64" });

      expect(result.status).toBe(0);
      const urls = curlCalls().join("\n");
      expect(urls).toContain(nodeRegistryMetaUrl("linux-arm64"));
      expect(urls).not.toContain("node-linux-x64");
      expect(existsSync(join(nodeDirIn(), "bin", "node"))).toBe(true);
    });
  });

  // pnpm は Node の入手経路によらず、常にレジストリの tarball から入れる（レジストリの Node には npm が無いため）。
  describe("pnpm の導入（npm レジストリの tarball）", () => {
    const nodeDirIn = () => join(home, ".local", `node-${nodeVersion}`);

    it("pnpm と @pnpm/exe.linux-x64 を integrity 検証して lib/node_modules/pnpm に置き、ネイティブバイナリを bin/pnpm から実行できるようにして pnpm install する（npm は使わない）", () => {
      buildNodeFixture("linux-x64", "ok");
      buildPnpmFixtures();

      const result = runScript([], remoteEnv());

      expect(result.status).toBe(0);
      const pnpmBin = join(nodeDirIn(), "bin", "pnpm");
      expect(lstatSync(pnpmBin).isSymbolicLink()).toBe(true);
      const version = spawnSync(pnpmBin, ["--version"], { encoding: "utf8" });
      expect(version.stdout.trim()).toBe(pnpmVersion);
      // 一時ディレクトリが残っていない
      expect(readdirSync(join(nodeDirIn(), "lib", "node_modules"))).toEqual([
        "pnpm",
      ]);
      expect(result.stderr).not.toContain("fake npm");
      expect(result.stderr).toContain(
        "fake native pnpm install --frozen-lockfile",
      );
    });

    it("@pnpm/exe の integrity が一致しなければ bin/pnpm を作らず一時ディレクトリも残さない（Node の PATH は書く）", () => {
      buildNodeFixture("linux-x64", "ok");
      buildPnpmFixtures("linux-x64", "mismatch");

      const result = runScript([], remoteEnv());

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("integrity mismatch");
      expect(result.stderr).toContain(`failed to install pnpm@${pnpmVersion}`);
      expect(existsSync(join(nodeDirIn(), "bin", "pnpm"))).toBe(false);
      expect(readdirSync(join(nodeDirIn(), "lib", "node_modules"))).toEqual([]);
      expect(readFileSync(envFile, "utf8")).toBe(
        `export EXISTING=1\nexport PATH="${join(nodeDirIn(), "bin")}:$PATH"\n`,
      );
    });

    it("同じ版の pnpm が既にあれば何も取得しない（冪等）", () => {
      placeFakeNode(nodeDirIn());
      writeFileSync(join(nodeDirIn(), "bin", "pnpm"), FAKE_NATIVE_PNPM, {
        mode: 0o755,
      });

      const result = runScript([], remoteEnv());

      expect(result.status).toBe(0);
      expect(curlCalls()).toEqual([]);
      expect(result.stderr).toContain(
        "fake native pnpm install --frozen-lockfile",
      );
    });
  });

  // SessionStart フックで dockerd を起動し、compose.yaml の Postgres を立てる（rules/code/env.md の「クラウドセッション」）。
  describe("Postgres の起動（docker compose）", () => {
    const nodeDirIn = () => join(home, ".local", `node-${nodeVersion}`);
    const composePull = `${repoRoot} compose pull`;
    const composeUp = `${repoRoot} compose up -d --wait --wait-timeout 120`;
    // Node / pnpm の導入を速い経路（インストール済み）にして、Postgres の起動だけを見る。
    const placeInstalledNodeAndPnpm = () => {
      placeFakeNode(nodeDirIn());
      writeFileSync(join(nodeDirIn(), "bin", "pnpm"), FAKE_NATIVE_PNPM, {
        mode: 0o755,
      });
    };
    // docker / dockerd の有無を切り替えるための PATH。fakeBin は使わず、スクリプトが使うコマンドだけを置く。
    // WHY: 本物の docker / dockerd が /usr/bin にある環境（この VM・GitHub Actions）でも「見つからない」を再現するため。
    const limitedPath = (withDocker: boolean) => {
      const dir = join(tmp, "limited-bin");
      mkdirSync(dir);
      for (const tool of ["bash", "awk", "dirname"]) {
        const found = spawnSync("bash", ["-c", `command -v ${tool}`], {
          encoding: "utf8",
        }).stdout.trim();
        writeFileSync(join(dir, tool), `#!/bin/sh\nexec ${found} "$@"\n`, {
          mode: 0o755,
        });
      }
      if (withDocker) {
        writeFileSync(join(dir, "docker"), FAKE_DOCKER, { mode: 0o755 });
      }
      return dir;
    };

    it("ローカル（CLAUDE_CODE_REMOTE が true でない）では docker を一切呼ばない", () => {
      const result = runScript([], {
        CLOUD_SESSION_START_DRY_RUN: "1",
        CLAUDE_ENV_FILE: envFile,
      });
      expect(result.status).toBe(0);
      expect(logLines(dockerLog)).toEqual([]);
      expect(logLines(dockerdLog)).toEqual([]);
    });

    it("--install-only（setup script）では docker を一切呼ばない", () => {
      const result = runScript(["--install-only"], {
        CLOUD_SESSION_START_DRY_RUN: "1",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("docker");
      expect(logLines(dockerLog)).toEqual([]);
      expect(logLines(dockerdLog)).toEqual([]);
    });

    it("DRY_RUN でデーモンが動いていなければ、dockerd の起動予定と docker compose pull / up の予定を表示し、実際には起動しない", () => {
      rmSync(dockerReady);
      const result = runScript([], {
        ...remoteEnv(),
        CLOUD_SESSION_START_DRY_RUN: "1",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("dockerd");
      expect(result.stdout).toContain(join(tmp, "dockerd.log"));
      expect(result.stdout).toContain(
        `(cd ${repoRoot} && docker compose pull)`,
      );
      expect(result.stdout).toContain(
        `(cd ${repoRoot} && docker compose up -d --wait --wait-timeout 120)`,
      );
      expect(logLines(dockerdLog)).toEqual([]);
      expect(logLines(dockerLog)).toEqual([`${process.cwd()} info`]);
    });

    it("DRY_RUN でデーモンが動いていれば、dockerd の起動予定は出さず docker compose pull / up の予定だけを表示する", () => {
      const result = runScript([], {
        ...remoteEnv(),
        CLOUD_SESSION_START_DRY_RUN: "1",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain("dockerd");
      expect(result.stdout).toContain(
        `(cd ${repoRoot} && docker compose pull)`,
      );
      expect(result.stdout).toContain(
        `(cd ${repoRoot} && docker compose up -d --wait --wait-timeout 120)`,
      );
      expect(logLines(dockerLog)).not.toContain(composeUp);
    });

    it("デーモンが動いていれば dockerd は起動せず、リポジトリ直下で docker compose pull → up -d --wait --wait-timeout 120 の順に実行する", () => {
      placeInstalledNodeAndPnpm();
      const result = runScript([], remoteEnv());
      expect(result.status).toBe(0);
      expect(logLines(dockerdLog)).toEqual([]);
      const calls = logLines(dockerLog);
      expect(calls.filter((c) => c === composePull)).toHaveLength(1);
      expect(calls.indexOf(composeUp)).toBeGreaterThan(
        calls.indexOf(composePull),
      );
      expect(result.stderr).not.toContain("cloud-session-start:");
    });

    it("docker compose pull が 2 回失敗しても、2 秒・4 秒待って 3 回目で成功すれば up に進む", () => {
      placeInstalledNodeAndPnpm();
      writeFileSync(join(fakeBin, "sleep"), FAKE_SLEEP, { mode: 0o755 });
      const result = runScript([], {
        ...remoteEnv(),
        FAKE_COMPOSE_PULL_FAILS: "2",
      });
      expect(result.status).toBe(0);
      const calls = logLines(dockerLog);
      expect(calls.filter((c) => c === composePull)).toHaveLength(3);
      expect(calls).toContain(composeUp);
      expect(logLines(join(tmp, "sleep.log"))).toEqual(["2", "4"]);
      expect(result.stderr).not.toContain("docker compose pull failed");
    });

    it("docker compose pull が 3 回とも失敗したら、warn を出して up は実行せず exit 0（4 回目は試さない）", () => {
      placeInstalledNodeAndPnpm();
      writeFileSync(join(fakeBin, "sleep"), FAKE_SLEEP, { mode: 0o755 });
      const result = runScript([], {
        ...remoteEnv(),
        FAKE_COMPOSE_PULL_FAILS: "3",
      });
      expect(result.status).toBe(0);
      const calls = logLines(dockerLog);
      expect(calls.filter((c) => c === composePull)).toHaveLength(3);
      expect(calls).not.toContain(composeUp);
      // 最後の失敗の後は待たない
      expect(logLines(join(tmp, "sleep.log"))).toEqual(["2", "4"]);
      expect(result.stderr).toContain("docker compose pull failed");
    });

    it("デーモンが動いていなければ dockerd をバックグラウンドで起動し（出力は $TMPDIR/dockerd.log）、docker info が通ってから docker compose up を実行する", () => {
      placeInstalledNodeAndPnpm();
      rmSync(dockerReady);
      const result = runScript([], remoteEnv());
      expect(result.status).toBe(0);
      // 既定のソケット・データ置き場で使うので、引数なしで起動する（rules/code/env.md の実測）
      expect(logLines(dockerdLog)).toEqual(["dockerd "]);
      expect(readFileSync(join(tmp, "dockerd.log"), "utf8")).toContain(
        "fake dockerd started",
      );
      const calls = logLines(dockerLog);
      expect(calls).toContain(composeUp);
      // compose は docker info が通った後に呼ぶ
      const lastInfo = calls.lastIndexOf(`${process.cwd()} info`);
      expect(calls.indexOf(composeUp)).toBeGreaterThan(lastInfo);
      expect(result.stderr).not.toContain("cloud-session-start:");
    });

    it("dockerd を起動しても待ち時間内に docker info が通らなければ、warn を出して compose は実行せず exit 0", () => {
      placeInstalledNodeAndPnpm();
      rmSync(dockerReady);
      const started = Date.now();
      const result = runScript([], {
        ...remoteEnv(),
        FAKE_DOCKERD_STARTS: "0",
        CLOUD_SESSION_START_DOCKER_WAIT_SECONDS: "1",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("docker daemon did not become ready");
      expect(result.stderr).toContain(join(tmp, "dockerd.log"));
      expect(logLines(dockerLog)).not.toContain(composeUp);
      // 待ち時間（1 秒）で諦める。既定の 30 秒まで待たない
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("docker compose up が失敗しても warn を出して exit 0", () => {
      placeInstalledNodeAndPnpm();
      const result = runScript([], { ...remoteEnv(), FAKE_COMPOSE_EXIT: "1" });
      expect(result.status).toBe(0);
      expect(logLines(dockerLog)).toContain(composeUp);
      expect(result.stderr).toContain(
        "docker compose up -d --wait --wait-timeout 120 failed",
      );
    });

    it("Node の取得に失敗しても Postgres は起動する（Postgres は Node に依存しない）", () => {
      // フィクスチャを置かないので、nodejs.org もレジストリも 22 で失敗する。
      const result = runScript([], remoteEnv());
      expect(result.status).toBe(0);
      expect(existsSync(nodeDirIn())).toBe(false);
      expect(logLines(dockerLog)).toContain(composeUp);
    });

    it("docker が無ければ warn を出して何もせず exit 0", () => {
      placeInstalledNodeAndPnpm();
      const result = runScript([], {
        ...remoteEnv(),
        CLOUD_SESSION_START_DRY_RUN: "1",
        PATH: limitedPath(false),
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("docker not found");
      expect(result.stdout).not.toContain("docker compose");
    });

    it("デーモンが動いておらず dockerd も無ければ、待たずに warn を出して compose は実行せず exit 0", () => {
      placeInstalledNodeAndPnpm();
      rmSync(dockerReady);
      const result = runScript([], {
        ...remoteEnv(),
        PATH: limitedPath(true),
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("dockerd not found");
      expect(logLines(dockerLog)).not.toContain(composeUp);
    });
  });
});

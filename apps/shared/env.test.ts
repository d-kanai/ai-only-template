// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { DotEnvFile, EnvReader, env, toolEnv } from "./env";

// 必須の変数がすべて正しい値で揃った source。各テストはここから 1 つずつ崩して使う。
const VALID = {
  DATABASE_URL: "postgresql://u:p@db.example:5432/x",
  DATABASE_POOL_MAX: "10",
  DATABASE_POOL_IDLE_TIMEOUT_MS: "10000",
  DATABASE_CONNECTION_TIMEOUT_MS: "5000",
  DATABASE_STATEMENT_TIMEOUT_MS: "10000",
  DATABASE_LOCK_TIMEOUT_MS: "3000",
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "30000",
  GCP_PROJECT_ID: "my-project",
};

const REQUIRED_NAMES = Object.keys(VALID);

// EnvReader.read が投げたエラーのメッセージを取り出す（投げなければテストを失敗させる）。
function errorMessageOf(source: Record<string, string | undefined>): string {
  try {
    EnvReader.read(source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("EnvReader.read がエラーを投げなかった");
}

describe("EnvReader.read", () => {
  test("必須の変数がすべて正しければ、数は number にして返す", () => {
    // given: 前提なし（VALID はモジュールの定数）
    // when
    const parsed = EnvReader.read(VALID);

    // then
    expect(parsed).toEqual({
      DATABASE_URL: "postgresql://u:p@db.example:5432/x",
      DATABASE_POOL_MAX: 10,
      DATABASE_POOL_IDLE_TIMEOUT_MS: 10_000,
      DATABASE_CONNECTION_TIMEOUT_MS: 5_000,
      DATABASE_STATEMENT_TIMEOUT_MS: 10_000,
      DATABASE_LOCK_TIMEOUT_MS: 3_000,
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: 30_000,
      GCP_PROJECT_ID: "my-project",
    });
  });

  test("必須の変数以外は返さない（関係のない環境変数を env に混ぜない）", () => {
    // given
    const source = { ...VALID, PATH: "/usr/bin", E2E_PORT: "3100" };

    // when
    const keys = Object.keys(EnvReader.read(source)).sort();

    // then
    expect(keys).toEqual([...REQUIRED_NAMES].sort());
  });

  test("アイドル・接続待ちの 0 は受け付ける（0 以上の整数）", () => {
    // given
    const source = {
      ...VALID,
      DATABASE_POOL_IDLE_TIMEOUT_MS: "0",
      DATABASE_CONNECTION_TIMEOUT_MS: "0",
    };

    // when
    const parsed = EnvReader.read(source);

    // then
    expect(parsed).toMatchObject({
      DATABASE_POOL_IDLE_TIMEOUT_MS: 0,
      DATABASE_CONNECTION_TIMEOUT_MS: 0,
    });
  });

  test("DB 側のタイムアウト（文・ロック待ち・トランザクション中のアイドル）の 0（無効）は受け付ける", () => {
    // given
    const source = {
      ...VALID,
      DATABASE_STATEMENT_TIMEOUT_MS: "0",
      DATABASE_LOCK_TIMEOUT_MS: "0",
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: "0",
    };

    // when
    const parsed = EnvReader.read(source);

    // then
    expect(parsed).toMatchObject({
      DATABASE_STATEMENT_TIMEOUT_MS: 0,
      DATABASE_LOCK_TIMEOUT_MS: 0,
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: 0,
    });
  });

  test("アイドル・接続待ちに整数でない値を書くと、0 以上の整数が必要だと英語で伝える", () => {
    // given
    const source = { ...VALID, DATABASE_POOL_IDLE_TIMEOUT_MS: "-1" };

    // when
    const message = errorMessageOf(source);

    // then
    expect(message).toContain(
      "DATABASE_POOL_IDLE_TIMEOUT_MS: must be an integer >= 0 (got: -1)",
    );
  });

  test.each(REQUIRED_NAMES)(
    "%s が無ければ、その名前を含むエラーにする（既定値で補わない）",
    (name) => {
      // given
      const source = { ...VALID, [name]: undefined };

      // when
      const message = errorMessageOf(source);

      // then
      expect(message).toContain(name);
      // 欠けていない変数の名前は出さない（どれを直せばよいかを 1 つに絞れるようにする）。
      for (const other of REQUIRED_NAMES.filter((n) => n !== name)) {
        expect(message).not.toContain(`${other}:`);
      }
    },
  );

  test.each(REQUIRED_NAMES)(
    "%s が空文字でも、未設定と同じくエラーにする",
    (name) => {
      // given
      const source = { ...VALID, [name]: "" };

      // when
      const message = errorMessageOf(source);

      // then
      expect(message).toContain(name);
    },
  );

  test.each(REQUIRED_NAMES)(
    "%s が空白だけ（前後の空白を除くと空）でも、未設定と同じくエラーにする",
    (name) => {
      // given
      const source = { ...VALID, [name]: "  \t" };

      // when
      const message = errorMessageOf(source);

      // then
      expect(message).toContain(`${name}: is not set`);
    },
  );

  test.each([
    ["DATABASE_POOL_MAX", "abc"],
    ["DATABASE_POOL_MAX", "0"],
    ["DATABASE_POOL_MAX", "1.5"],
    ["DATABASE_POOL_MAX", "-1"],
    ["DATABASE_POOL_IDLE_TIMEOUT_MS", "-1"],
    ["DATABASE_POOL_IDLE_TIMEOUT_MS", "1e3"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", "10s"],
    ["DATABASE_CONNECTION_TIMEOUT_MS", " 5"],
    ["DATABASE_STATEMENT_TIMEOUT_MS", "-1"],
    ["DATABASE_LOCK_TIMEOUT_MS", "3s"],
    ["DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS", "1.5"],
  ])(
    "%s=%s のように数として使えない値は、名前と値を含むエラーにする",
    (name, value) => {
      // given
      const source = { ...VALID, [name]: value };

      // when
      const message = errorMessageOf(source);

      // then
      expect(message).toContain(name);
      expect(message).toContain(`(got: ${value})`);
    },
  );

  test("欠けている・不正な変数が複数あれば、最初の 1 件で止めずにすべての名前を 1 つのエラーに並べる", () => {
    // given
    const source = {
      DATABASE_POOL_MAX: "abc",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "-1",
    };

    // when
    const message = errorMessageOf(source);

    // then
    for (const name of REQUIRED_NAMES) {
      expect(message).toContain(`${name}:`);
    }
  });

  test("エラーは 1 行目に要旨、続けて問題を 1 行 1 件、最後に .env.example を .env にコピーする手順を書く", () => {
    // given
    const source = {
      ...VALID,
      DATABASE_URL: undefined,
      DATABASE_POOL_MAX: "0",
    };

    // when
    const lines = errorMessageOf(source).split("\n");

    // then
    expect(lines).toEqual([
      "Environment variables are missing or invalid.",
      "  - DATABASE_URL: is not set",
      "  - DATABASE_POOL_MAX: must be an integer >= 1 (got: 0)",
      expect.stringContaining("cp .env.example .env"),
    ]);
  });
});

describe("EnvReader.readTool", () => {
  test("何も無ければ、どのフラグも無効（ツールのフラグは無いのが正常で、エラーにしない）", () => {
    // given: 前提なし
    // when
    const flags = EnvReader.readTool({});

    // then
    expect(flags).toEqual({
      CI: false,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: undefined,
      STRYKER_MUTATOR_WORKER: false,
      E2E_PORT: undefined,
      NODE_ENV: undefined,
    });
  });

  test.each([
    ["1", 1],
    ["3616", 3616],
    ["65535", 65_535],
  ])("E2E_PORT=%s は %s（ポートの範囲 1〜65535 の中の整数）", (value, port) => {
    // given: 前提なし（value は test.each の引数）
    // when
    const flags = EnvReader.readTool({ E2E_PORT: value });

    // then
    expect(flags.E2E_PORT).toBe(port);
  });

  test("E2E_PORT が空文字なら未設定と同じ undefined（apps/e2e/playwright.config.ts が既定の 3100 を使う）", () => {
    // given: 前提なし
    // when
    const flags = EnvReader.readTool({ E2E_PORT: "" });

    // then
    expect(flags.E2E_PORT).toBeUndefined();
  });

  test.each([
    [
      "0",
      "0 はポートとして使えない（OS が空きポートを選ぶ意味になり、テストとサーバでずれる）",
    ],
    ["65536", "範囲外"],
    ["-1", "負"],
    ["3100.5", "小数"],
    ["abc", "数でない"],
    [" 3100", "空白を含む"],
    ["３１００", "全角数字"],
  ])(
    "E2E_PORT=%s は不正（%s）なので、任意でも名前と値を含むエラーにする",
    (value) => {
      // given: 前提なし（value は test.each の引数）
      // when
      // toThrow ではなく投げた値そのものを比べる（toThrow は投げた値が undefined でも通りうる。.claude/rules/quality/testing.md）。
      let thrown: unknown;
      try {
        EnvReader.readTool({ E2E_PORT: value });
      } catch (error) {
        thrown = error;
      }

      // then
      expect(thrown).toEqual(
        new Error(
          [
            "Environment variable values are invalid.",
            `  - E2E_PORT: must be an integer from 1 to 65535 (got: ${value})`,
          ].join("\n"),
        ),
      );
    },
  );

  test.each([
    ["true", true],
    ["1", true],
    ["0", true],
    ["false", true],
    ["", false],
  ])(
    "CI=%s なら CI は %s（空でなければ有効。Playwright の !process.env.CI と同じ）",
    (value, expected) => {
      // given: 前提なし（value は test.each の引数）
      // when
      const flags = EnvReader.readTool({ CI: value });

      // then
      expect(flags.CI).toBe(expected);
    },
  );

  test.each([
    ["/opt/pw-browsers/chromium", "/opt/pw-browsers/chromium"],
    ["", undefined],
  ])("PLAYWRIGHT_CHROMIUM_EXECUTABLE=%s なら %s", (value, expected) => {
    // given: 前提なし（value は test.each の引数）
    // when
    const flags = EnvReader.readTool({ PLAYWRIGHT_CHROMIUM_EXECUTABLE: value });

    // then
    expect(flags.PLAYWRIGHT_CHROMIUM_EXECUTABLE).toBe(expected);
  });

  test.each([
    ["1", true],
    ["", false],
  ])("STRYKER_MUTATOR_WORKER=%s なら %s", (value, expected) => {
    // given: 前提なし（value は test.each の引数）
    // when
    const flags = EnvReader.readTool({ STRYKER_MUTATOR_WORKER: value });

    // then
    expect(flags.STRYKER_MUTATOR_WORKER).toBe(expected);
  });

  test.each([
    ["development", "development"],
    ["production", "production"],
    ["", undefined],
  ])("NODE_ENV=%s なら %s", (value, expected) => {
    // given: 前提なし（value は test.each の引数）
    // when
    const flags = EnvReader.readTool({ NODE_ENV: value });

    // then
    expect(flags.NODE_ENV).toBe(expected);
  });
});

describe("DotEnvFile.load", () => {
  // WHY beforeAll で作る（describe の本体で作らない）: describe の本体はテストを絞り込んだ実行（Stryker など）でも必ず
  //   実行されるが、その describe のテストが 1 つも動かないと afterAll も動かず、一時ディレクトリが残るため。
  let dir: string;
  // テストごとに別の名前にし、実行中の他のテストの環境変数と重ならないようにする。
  const name = `ENV_TEST_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env[`${name}_A`];
    delete process.env[`${name}_B`];
  });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "env-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("ファイルが無ければ何もせず false を返す（.env を置かずに環境変数だけで動かせる）", () => {
    // given: beforeAll で一時ディレクトリを作ってあり、missing.env は置いていない
    // when
    const loaded = DotEnvFile.load(join(dir, "missing.env"));

    // then
    expect(loaded).toBe(false);
  });

  test("ファイルがあれば読み込んで true を返し、環境に既にある変数はファイルの値で上書きしない", () => {
    // given
    const file = join(dir, "values.env");
    writeFileSync(file, `${name}_A=from-file\n${name}_B=from-file\n`);
    vi.stubEnv(`${name}_A`, "from-environment");

    // when
    const loaded = DotEnvFile.load(file);

    // then
    expect(loaded).toBe(true);
    expect(process.env[`${name}_A`]).toBe("from-environment");
    expect(process.env[`${name}_B`]).toBe("from-file");
  });

  test("読めない（ファイルが無い以外の理由の）ときはエラーにする", () => {
    // given
    const directory = join(dir, "directory.env");
    mkdirSync(directory);

    // when
    const action = () => DotEnvFile.load(directory);

    // then
    expect(action).toThrow();
  });
});

describe("DotEnvFile.findRepoRoot / DotEnvFile.loadFromRepoRoot（リポジトリ直下の .env の探し方）", () => {
  // 一時ディレクトリに「pnpm-workspace.yaml のあるリポジトリ直下」と、その下の apps/backend を作って確かめる。
  // WHY beforeAll で作る: DotEnvFile.load の describe と同じ（describe の本体で作ると、テストが動かないときに残る）。
  let repo: string;
  let nested: string;
  let outside: string;
  const name = `ENV_ROOT_TEST_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "env-root-test-"));
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(repo, ".env"), `${name}_ROOT=from-repo-root\n`);
    nested = join(repo, "apps", "backend");
    mkdirSync(nested, { recursive: true });
    outside = mkdtempSync(join(tmpdir(), "env-root-test-outside-"));
    writeFileSync(join(outside, ".env"), `${name}_CWD=from-cwd\n`);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  afterEach(() => {
    delete process.env[`${name}_ROOT`];
    delete process.env[`${name}_CWD`];
  });

  test("サブディレクトリから探すと、上にある pnpm-workspace.yaml のディレクトリ（リポジトリ直下）を返す", () => {
    // given: beforeAll でリポジトリ直下の下に apps/backend を作ってある
    // when
    const root = DotEnvFile.findRepoRoot(nested);

    // then
    expect(root).toBe(repo);
  });

  test("リポジトリ直下から探すと、そのディレクトリを返す", () => {
    // given: beforeAll でリポジトリ直下を作ってある
    // when
    const root = DotEnvFile.findRepoRoot(repo);

    // then
    expect(root).toBe(repo);
  });

  test("上のどこにも pnpm-workspace.yaml が無ければ、探し始めたディレクトリを返す", () => {
    // given: beforeAll で pnpm-workspace.yaml の無い一時ディレクトリを作ってある
    // when
    const root = DotEnvFile.findRepoRoot(outside);

    // then
    expect(root).toBe(outside);
  });

  test("サブディレクトリ（apps/backend）から呼んでも、リポジトリ直下の .env を読む", () => {
    // given: beforeAll でリポジトリ直下に .env を置いてある
    // when
    const loaded = DotEnvFile.loadFromRepoRoot(nested);

    // then
    expect(loaded).toBe(true);
    expect(process.env[`${name}_ROOT`]).toBe("from-repo-root");
  });

  test("リポジトリ直下が見つからなければ、カレントディレクトリの .env を読む", () => {
    // given: beforeAll で pnpm-workspace.yaml の無い一時ディレクトリに .env を置いてある
    // when
    const loaded = DotEnvFile.loadFromRepoRoot(outside);

    // then
    expect(loaded).toBe(true);
    expect(process.env[`${name}_CWD`]).toBe("from-cwd");
  });

  test("リポジトリ直下に .env が無ければ false を返す（サブディレクトリの .env は読まない）", () => {
    // given
    const bare = mkdtempSync(join(tmpdir(), "env-root-test-bare-"));
    try {
      writeFileSync(join(bare, "pnpm-workspace.yaml"), "packages: []\n");
      const sub = join(bare, "apps", "frontend");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, ".env"), `${name}_CWD=from-sub\n`);

      // when
      const loaded = DotEnvFile.loadFromRepoRoot(sub);

      // then
      expect(loaded).toBe(false);
      expect(process.env[`${name}_CWD`]).toBeUndefined();
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe("env / toolEnv（モジュールを読み込んだ時点の値）", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  test("env は process.env を EnvReader.read で検証した値、toolEnv は EnvReader.readTool で読んだ値", () => {
    // given: 前提なし（env / toolEnv は import 時点の値）
    // when
    const expectedEnv = EnvReader.read(process.env);
    const expectedToolEnv = EnvReader.readTool(process.env);

    // then
    expect(env).toEqual(expectedEnv);
    expect(toolEnv).toEqual(expectedToolEnv);
  });

  test("読み込み時にリポジトリ直下の .env を読み、環境に無い必須の変数を補う", async () => {
    // given
    vi.stubEnv("DATABASE_POOL_MAX", undefined);
    vi.resetModules();

    // when
    const reloaded = await import("./env");

    // then
    expect(reloaded.env.DATABASE_POOL_MAX).toBeGreaterThanOrEqual(1);
  });

  test("toolEnv は読み込み時の環境変数のツールのフラグを読む（CI が設定されていれば CI は true）", async () => {
    // given
    // WHY 読み込み直して確かめる: 手元では CI も STRYKER_MUTATOR_WORKER も無いので、上の比較だけでは toolEnv が
    //   常に「フラグ無し」を返しても通ってしまう。
    vi.stubEnv("CI", "1");
    vi.stubEnv("STRYKER_MUTATOR_WORKER", "1");
    vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "/opt/pw-browsers/chromium");
    vi.stubEnv("E2E_PORT", "3456");
    vi.stubEnv("NODE_ENV", "development");
    vi.resetModules();

    // when
    const reloaded = await import("./env");

    // then
    expect(reloaded.toolEnv).toEqual({
      CI: true,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/opt/pw-browsers/chromium",
      STRYKER_MUTATOR_WORKER: true,
      E2E_PORT: 3456,
      NODE_ENV: "development",
    });
  });

  test("読み込み時に E2E_PORT が不正なら、任意の変数でも読み込みそのものがエラーになる", async () => {
    // given
    vi.stubEnv("E2E_PORT", "70000");
    vi.resetModules();

    // when
    const loading = import("./env");

    // then
    await expect(loading).rejects.toBeInstanceOf(Error);
    await expect(loading).rejects.toMatchObject({
      message: expect.stringContaining(
        "E2E_PORT: must be an integer from 1 to 65535 (got: 70000)",
      ),
    });
  });

  test("読み込み時に必須の変数が不正なら、読み込みそのものがエラーになる（起動エラー）", async () => {
    // given
    // 環境にある値は .env で上書きされないので、不正な値のまま検証される。
    vi.stubEnv("DATABASE_POOL_MAX", "abc");
    vi.resetModules();

    // when
    const loading = import("./env");

    // then
    // rejects.toThrow("文字列") は reject された値が undefined でも通るので、Error であることと message を別に確かめる（.claude/rules/quality/testing.md）。
    await expect(loading).rejects.toBeInstanceOf(Error);
    await expect(loading).rejects.toMatchObject({
      message: expect.stringContaining("DATABASE_POOL_MAX"),
    });
  });
});

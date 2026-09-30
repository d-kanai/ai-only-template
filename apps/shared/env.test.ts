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
import {
  env,
  findRepoRoot,
  loadDotEnvFile,
  loadRepoDotEnv,
  readEnv,
  readToolEnv,
  toolEnv,
} from "./env";

// 必須の変数がすべて正しい値で揃った source。各テストはここから 1 つずつ崩して使う。
const VALID = {
  DATABASE_URL: "postgresql://u:p@db.example:5432/x",
  DATABASE_POOL_MAX: "10",
  DATABASE_POOL_IDLE_TIMEOUT_MS: "10000",
  DATABASE_CONNECTION_TIMEOUT_MS: "5000",
  GCP_PROJECT_ID: "my-project",
};

const REQUIRED_NAMES = Object.keys(VALID);

// readEnv が投げたエラーのメッセージを取り出す（投げなければテストを失敗させる）。
function errorMessageOf(source: Record<string, string | undefined>): string {
  try {
    readEnv(source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("readEnv がエラーを投げなかった");
}

describe("readEnv", () => {
  test("必須の変数がすべて正しければ、数は number にして返す", () => {
    expect(readEnv(VALID)).toEqual({
      DATABASE_URL: "postgresql://u:p@db.example:5432/x",
      DATABASE_POOL_MAX: 10,
      DATABASE_POOL_IDLE_TIMEOUT_MS: 10_000,
      DATABASE_CONNECTION_TIMEOUT_MS: 5_000,
      GCP_PROJECT_ID: "my-project",
    });
  });

  test("必須の変数以外は返さない（関係のない環境変数を env に混ぜない）", () => {
    expect(
      Object.keys(
        readEnv({ ...VALID, PATH: "/usr/bin", E2E_PORT: "3100" }),
      ).sort(),
    ).toEqual([...REQUIRED_NAMES].sort());
  });

  test("アイドル・接続待ちの 0 は受け付ける（0 以上の整数）", () => {
    expect(
      readEnv({
        ...VALID,
        DATABASE_POOL_IDLE_TIMEOUT_MS: "0",
        DATABASE_CONNECTION_TIMEOUT_MS: "0",
      }),
    ).toMatchObject({
      DATABASE_POOL_IDLE_TIMEOUT_MS: 0,
      DATABASE_CONNECTION_TIMEOUT_MS: 0,
    });
  });

  test("アイドル・接続待ちに整数でない値を書くと、0 以上の整数が必要だと英語で伝える", () => {
    expect(
      errorMessageOf({ ...VALID, DATABASE_POOL_IDLE_TIMEOUT_MS: "-1" }),
    ).toContain(
      "DATABASE_POOL_IDLE_TIMEOUT_MS: must be an integer >= 0 (got: -1)",
    );
  });

  test.each(REQUIRED_NAMES)(
    "%s が無ければ、その名前を含むエラーにする（既定値で補わない）",
    (name) => {
      const message = errorMessageOf({ ...VALID, [name]: undefined });
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
      expect(errorMessageOf({ ...VALID, [name]: "" })).toContain(name);
    },
  );

  test.each(REQUIRED_NAMES)(
    "%s が空白だけ（前後の空白を除くと空）でも、未設定と同じくエラーにする",
    (name) => {
      expect(errorMessageOf({ ...VALID, [name]: "  \t" })).toContain(
        `${name}: is not set`,
      );
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
  ])(
    "%s=%s のように数として使えない値は、名前と値を含むエラーにする",
    (name, value) => {
      const message = errorMessageOf({ ...VALID, [name]: value });
      expect(message).toContain(name);
      expect(message).toContain(`(got: ${value})`);
    },
  );

  test("欠けている・不正な変数が複数あれば、最初の 1 件で止めずにすべての名前を 1 つのエラーに並べる", () => {
    const message = errorMessageOf({
      DATABASE_POOL_MAX: "abc",
      DATABASE_POOL_IDLE_TIMEOUT_MS: "-1",
    });
    for (const name of REQUIRED_NAMES) {
      expect(message).toContain(`${name}:`);
    }
  });

  test("エラーは 1 行目に要旨、続けて問題を 1 行 1 件、最後に .env.example を .env にコピーする手順を書く", () => {
    const lines = errorMessageOf({
      ...VALID,
      DATABASE_URL: undefined,
      DATABASE_POOL_MAX: "0",
    }).split("\n");

    expect(lines).toEqual([
      "Environment variables are missing or invalid.",
      "  - DATABASE_URL: is not set",
      "  - DATABASE_POOL_MAX: must be an integer >= 1 (got: 0)",
      expect.stringContaining("cp .env.example .env"),
    ]);
  });
});

describe("readToolEnv", () => {
  test("何も無ければ、どのフラグも無効（ツールのフラグは無いのが正常で、エラーにしない）", () => {
    expect(readToolEnv({})).toEqual({
      CI: false,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: undefined,
      STRYKER_MUTATOR_WORKER: false,
      E2E_PORT: undefined,
    });
  });

  test.each([
    ["1", 1],
    ["3616", 3616],
    ["65535", 65_535],
  ])("E2E_PORT=%s は %s（ポートの範囲 1〜65535 の中の整数）", (value, port) => {
    expect(readToolEnv({ E2E_PORT: value }).E2E_PORT).toBe(port);
  });

  test("E2E_PORT が空文字なら未設定と同じ undefined（apps/e2e/playwright.config.ts が既定の 3100 を使う）", () => {
    expect(readToolEnv({ E2E_PORT: "" }).E2E_PORT).toBeUndefined();
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
      // toThrow ではなく投げた値そのものを比べる（toThrow は投げた値が undefined でも通りうる。.claude/rules/testing.md）。
      let thrown: unknown;
      try {
        readToolEnv({ E2E_PORT: value });
      } catch (error) {
        thrown = error;
      }
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
      expect(readToolEnv({ CI: value }).CI).toBe(expected);
    },
  );

  test.each([
    ["/opt/pw-browsers/chromium", "/opt/pw-browsers/chromium"],
    ["", undefined],
  ])("PLAYWRIGHT_CHROMIUM_EXECUTABLE=%s なら %s", (value, expected) => {
    expect(
      readToolEnv({ PLAYWRIGHT_CHROMIUM_EXECUTABLE: value })
        .PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    ).toBe(expected);
  });

  test.each([
    ["1", true],
    ["", false],
  ])("STRYKER_MUTATOR_WORKER=%s なら %s", (value, expected) => {
    expect(
      readToolEnv({ STRYKER_MUTATOR_WORKER: value }).STRYKER_MUTATOR_WORKER,
    ).toBe(expected);
  });
});

describe("loadDotEnvFile", () => {
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
    expect(loadDotEnvFile(join(dir, "missing.env"))).toBe(false);
  });

  test("ファイルがあれば読み込んで true を返し、環境に既にある変数はファイルの値で上書きしない", () => {
    const file = join(dir, "values.env");
    writeFileSync(file, `${name}_A=from-file\n${name}_B=from-file\n`);
    vi.stubEnv(`${name}_A`, "from-environment");

    expect(loadDotEnvFile(file)).toBe(true);

    expect(process.env[`${name}_A`]).toBe("from-environment");
    expect(process.env[`${name}_B`]).toBe("from-file");
  });

  test("読めない（ファイルが無い以外の理由の）ときはエラーにする", () => {
    const directory = join(dir, "directory.env");
    mkdirSync(directory);

    expect(() => loadDotEnvFile(directory)).toThrow();
  });
});

describe("findRepoRoot / loadRepoDotEnv（リポジトリ直下の .env の探し方）", () => {
  // 一時ディレクトリに「pnpm-workspace.yaml のあるリポジトリ直下」と、その下の apps/backend を作って確かめる。
  // WHY beforeAll で作る: loadDotEnvFile の describe と同じ（describe の本体で作ると、テストが動かないときに残る）。
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
    expect(findRepoRoot(nested)).toBe(repo);
  });

  test("リポジトリ直下から探すと、そのディレクトリを返す", () => {
    expect(findRepoRoot(repo)).toBe(repo);
  });

  test("上のどこにも pnpm-workspace.yaml が無ければ、探し始めたディレクトリを返す", () => {
    expect(findRepoRoot(outside)).toBe(outside);
  });

  test("サブディレクトリ（apps/backend）から呼んでも、リポジトリ直下の .env を読む", () => {
    expect(loadRepoDotEnv(nested)).toBe(true);

    expect(process.env[`${name}_ROOT`]).toBe("from-repo-root");
  });

  test("リポジトリ直下が見つからなければ、カレントディレクトリの .env を読む", () => {
    expect(loadRepoDotEnv(outside)).toBe(true);

    expect(process.env[`${name}_CWD`]).toBe("from-cwd");
  });

  test("リポジトリ直下に .env が無ければ false を返す（サブディレクトリの .env は読まない）", () => {
    const bare = mkdtempSync(join(tmpdir(), "env-root-test-bare-"));
    try {
      writeFileSync(join(bare, "pnpm-workspace.yaml"), "packages: []\n");
      const sub = join(bare, "apps", "frontend");
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, ".env"), `${name}_CWD=from-sub\n`);

      expect(loadRepoDotEnv(sub)).toBe(false);
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

  test("env は process.env を readEnv で検証した値、toolEnv は readToolEnv で読んだ値", () => {
    expect(env).toEqual(readEnv(process.env));
    expect(toolEnv).toEqual(readToolEnv(process.env));
  });

  test("読み込み時にリポジトリ直下の .env を読み、環境に無い必須の変数を補う", async () => {
    vi.stubEnv("DATABASE_POOL_MAX", undefined);
    vi.resetModules();

    const reloaded = await import("./env");

    expect(reloaded.env.DATABASE_POOL_MAX).toBeGreaterThanOrEqual(1);
  });

  test("toolEnv は読み込み時の環境変数のツールのフラグを読む（CI が設定されていれば CI は true）", async () => {
    // WHY 読み込み直して確かめる: 手元では CI も STRYKER_MUTATOR_WORKER も無いので、上の比較だけでは toolEnv が
    //   常に「フラグ無し」を返しても通ってしまう。
    vi.stubEnv("CI", "1");
    vi.stubEnv("STRYKER_MUTATOR_WORKER", "1");
    vi.stubEnv("PLAYWRIGHT_CHROMIUM_EXECUTABLE", "/opt/pw-browsers/chromium");
    vi.stubEnv("E2E_PORT", "3456");
    vi.resetModules();

    const reloaded = await import("./env");

    expect(reloaded.toolEnv).toEqual({
      CI: true,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: "/opt/pw-browsers/chromium",
      STRYKER_MUTATOR_WORKER: true,
      E2E_PORT: 3456,
    });
  });

  test("読み込み時に E2E_PORT が不正なら、任意の変数でも読み込みそのものがエラーになる", async () => {
    vi.stubEnv("E2E_PORT", "70000");
    vi.resetModules();

    const loading = import("./env");
    await expect(loading).rejects.toBeInstanceOf(Error);
    await expect(loading).rejects.toMatchObject({
      message: expect.stringContaining(
        "E2E_PORT: must be an integer from 1 to 65535 (got: 70000)",
      ),
    });
  });

  test("読み込み時に必須の変数が不正なら、読み込みそのものがエラーになる（起動エラー）", async () => {
    // 環境にある値は .env で上書きされないので、不正な値のまま検証される。
    vi.stubEnv("DATABASE_POOL_MAX", "abc");
    vi.resetModules();

    // rejects.toThrow("文字列") は reject された値が undefined でも通るので、Error であることと message を別に確かめる（.claude/rules/testing.md）。
    const loading = import("./env");
    await expect(loading).rejects.toBeInstanceOf(Error);
    await expect(loading).rejects.toMatchObject({
      message: expect.stringContaining("DATABASE_POOL_MAX"),
    });
  });
});

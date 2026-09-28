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
  loadDotEnvFile,
  readEnv,
  readToolEnv,
  toolEnv,
} from "@/backend/shared/infra/env";

// 必須の変数がすべて正しい値で揃った source。各テストはここから 1 つずつ崩して使う。
const VALID = {
  DATABASE_URL: "postgresql://u:p@db.example:5432/x",
  DATABASE_POOL_MAX: "10",
  DATABASE_POOL_IDLE_TIMEOUT_MS: "10000",
  DATABASE_CONNECTION_TIMEOUT_MS: "5000",
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
    });
  });

  test("必須の変数以外は返さない（関係のない環境変数を env に混ぜない）", () => {
    expect(Object.keys(readEnv({ ...VALID, PATH: "/usr/bin" })).sort()).toEqual(
      [...REQUIRED_NAMES].sort(),
    );
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
      expect(message).toContain(`値: ${value}`);
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
      "環境変数が足りないか、値が正しくありません。",
      "  - DATABASE_URL: 設定されていません",
      "  - DATABASE_POOL_MAX: 1 以上の整数で指定してください（値: 0）",
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
    });
  });

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

    const reloaded = await import("@/backend/shared/infra/env");

    expect(reloaded.env.DATABASE_POOL_MAX).toBeGreaterThanOrEqual(1);
  });

  test("読み込み時に必須の変数が不正なら、読み込みそのものがエラーになる（起動エラー）", async () => {
    // 環境にある値は .env で上書きされないので、不正な値のまま検証される。
    vi.stubEnv("DATABASE_POOL_MAX", "abc");
    vi.resetModules();

    await expect(import("@/backend/shared/infra/env")).rejects.toThrow(
      "DATABASE_POOL_MAX",
    );
  });
});

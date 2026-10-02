// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは子プロセスを起動するだけで DOM を使わないため、
//   jsdom の初期化を省き、ブラウザ相当の globals が Node の API と混ざる余地をなくすため node 環境で動かす。
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect } from "vitest";
import pkg from "../package.json";
import { casesByName } from "./case-table";

// Biome と Lefthook の導入（.claude/rules/quality/lint.md）を仕様として固定するテスト。
// 設定ファイルの中身を文字列で照合するのではなく、実際に biome / lefthook を起動して「違反が検出されること」を確かめる。
// 設定を壊した（例: linter を無効にした、pre-commit から biome を消した）ときにテストで気づけるようにするため。
// .feature（lint.feature）と step の実装（このファイル）に分けた（Issue #282）。

const repoRoot = join(import.meta.dirname, "..");

// WHY: Biome の recommended には既定 severity が warn / info のルールが多く（noUnusedVariables は warn、useTemplate は info）、
//   biome check は error がなければ終了コード 0 になる。warn は放置されるため、`--error-on-warnings` で warn でも失敗させる
//   （info は biome.json 側で error に上げている）。pnpm lint / pnpm check / pre-commit と同じ引数で検査するため定数にしている。
const ERROR_ON_WARNINGS = "--error-on-warnings";

// WHY コマンド文字列を「含むか」ではなく、`&&` で区切ったコマンドごとに `biome check` とその引数として読む:
//   `biome check . && echo --error-on-warnings` のように、別のコマンドの引数に置かれたフラグや、`biome lint` / `biome format` に
//   付いたフラグを「付いている」と誤判定しないため（Issue #50）。
// 許す起動の仕方は `biome ...`（package.json の scripts。node_modules/.bin が PATH に入る）と `pnpm exec biome ...`（lefthook）だけ。
//   npx などは pnpm のみを使う方針（.claude/rules/tooling/env.md）から外れるので、許可しない。
// WHY `&&` 以外のつなぎ（`||` / `;` / 改行 / `|` / 単独の `&`）を含むコマンドは丸ごと拒否する:
//   どれも biome check の失敗をコマンド全体の失敗にしない書き方になりうる。`biome check ... || true` は失敗を打ち消し、
//   `; exit 0` と改行は後ろのコマンドの終了コードになり、`| cat` はパイプの最後のコマンドの終了コードになり、
//   末尾の `&` はバックグラウンドにして終了コードを見ない。`true || biome check ...` では biome check が実行されない。
//   `&&` は前が失敗すればそこで止まって失敗になるので、つなげても失敗は消えない（許可する）。
//   区切りの文字がクォートの中にある場合も拒否する（多く検出する方向。今の scripts / lefthook.yml には無い）。
const COMMAND_CHAIN = "&&";
const UNSAFE_CHAIN = /[|;&\n]/;

// WHY warn を効かなくするフラグを拒否する: `--diagnostic-level=error` は warn 以下の診断を出さず、`--only` / `--skip` は
//   実行するルールを絞るため、`--error-on-warnings` が付いていても warn の違反で終了コード 0 になる（Issue #50 の reviewer が実測）。
//   `--flag=value` と `--flag value` の両方の書き方を拒否する。
const WARNING_SUPPRESSING_FLAGS = ["--diagnostic-level", "--only", "--skip"];

function suppressesWarnings(arg: string): boolean {
  return WARNING_SUPPRESSING_FLAGS.some(
    (flag) => arg === flag || arg.startsWith(`${flag}=`),
  );
}

function isBiomeCheckWithErrorOnWarnings(segment: string): boolean {
  const words = segment.trim().split(/\s+/);
  const args =
    words[0] === "pnpm" && words[1] === "exec" ? words.slice(2) : words;
  return (
    args[0] === "biome" &&
    args[1] === "check" &&
    args.includes(ERROR_ON_WARNINGS) &&
    !args.some(suppressesWarnings)
  );
}

function runsBiomeCheckWithErrorOnWarnings(command: string): boolean {
  const segments = command.split(COMMAND_CHAIN);
  if (segments.some((segment) => UNSAFE_CHAIN.test(segment))) return false;
  return segments.some(isBiomeCheckWithErrorOnWarnings);
}

function pnpmExec(command: string, args: string[]) {
  // WHY: `pnpm exec` 経由にするのは、開発者やフックと同じ経路（package.json で固定した版の node_modules/.bin）で起動するため。
  //   cwd をリポジトリ直下にして、リポジトリの biome.json / lefthook.yml が読まれるようにする。
  return spawnSync("pnpm", ["exec", command, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}

let lintDir: string;

beforeAll(() => {
  // WHY: 違反ファイルをリポジトリ内に置くと、テストが途中で落ちたときに作業ツリーへ残り、
  //   `pnpm lint` や git の差分を汚す。OS の一時ディレクトリに置いて afterAll で消す。
  //   リポジトリ外のファイルでも、cwd（リポジトリ直下）の biome.json が適用されることを確認済み。
  lintDir = mkdtempSync(join(tmpdir(), "lint-test-"));
});

afterAll(() => {
  rmSync(lintDir, { recursive: true, force: true });
});

function checkSource(fileName: string, lines: string[]) {
  const file = join(lintDir, fileName);
  writeFileSync(file, [...lines, ""].join("\n"));
  const result = pnpmExec("biome", ["check", ERROR_ON_WARNINGS, file]);
  return { status: result.status, output: result.stdout + result.stderr };
}

// complexity/noStaticOnlyClass の override（Issue #262）: apps/backend/**・apps/shared/**・apps/e2e/** と、apps/frontend_customer の
//   features/**・shared/**・test-support/** のうち *.tsx・*.jsx・*.hook.*・*.test.* 以外だけ off にする。どれも最上位に関数を置かず（apps/e2e は
//   spec 以外の補助。database.ts の E2eDatabase。frontend は React 以外のモジュール。todo-api.ts の TodoApi）、状態の無い補助を
//   static だけのクラスにする（ADR docs/adr/architecture/20261002-class-based-backend.md・20261002-class-based-shared-and-test-support.md・
//   20261002-class-based-frontend-modules.md）。範囲は rule-tests/architecture.test.ts の規則 class-based の対象と同じにする。
//   frontend の React の component（*.tsx・*.jsx）・hook（*.hook.*）・app/・直下のファイル（Next の規約）は関数のままなので、
//   static だけのクラスは recommended どおり警告（--error-on-warnings で失敗）のままにする。
// WHY 一時ディレクトリにリポジトリの biome.json を写して、その下の apps/... に置いたファイルを検査する: overrides の includes は
//   設定ファイルのディレクトリからの相対パスで照合され、リポジトリの外のファイル（noProcessEnv の検査の一時ファイル）には
//   apps/backend/** が一致しない。リポジトリの中の apps/backend に一時ファイルを置くと、並行して走る architecture.test.ts の
//   置き場所の検査に拾われ、途中で落ちれば作業ツリーにも残る。biome.json はテストのたびに読むので、設定を変えればこの検査に効く。
// WHY コメント 1 行だけの .gitignore を置く: biome.json の vcs.useIgnoreFile が true で、ignore ファイルの無いディレクトリでは
//   「couldn't find an ignore file」で設定エラーになり、違反の有無と関係なく非 0 で終わる。空の .gitignore も無いものとして
//   同じエラーになった（Biome 2.5.13、2026-10-02 実測）。
// WHY node_modules/.bin/biome を直接起動する: cwd を一時ディレクトリにするため、pnpm exec はリポジトリの workspace を見つけられない。
let staticOnlyClassDir: string;

beforeAll(() => {
  staticOnlyClassDir = mkdtempSync(join(tmpdir(), "lint-static-only-class-"));
  copyFileSync(
    join(repoRoot, "biome.json"),
    join(staticOnlyClassDir, "biome.json"),
  );
  writeFileSync(
    join(staticOnlyClassDir, ".gitignore"),
    "# lint.test.ts の一時ディレクトリ\n",
  );
});

afterAll(() => {
  rmSync(staticOnlyClassDir, { recursive: true, force: true });
});

function checkAt(path: string, lines: string[]) {
  const file = join(staticOnlyClassDir, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [...lines, ""].join("\n"));
  const result = spawnSync(
    join(repoRoot, "node_modules/.bin/biome"),
    ["check", ERROR_ON_WARNINGS, path],
    { cwd: staticOnlyClassDir, encoding: "utf8" },
  );
  return { status: result.status, output: result.stdout + result.stderr };
}

const STATIC_ONLY_CLASS = [
  "export class Paths {",
  "  static of(name: string): string {",
  "    return name;",
  "  }",
  "}",
];

const feature = await loadFeature("./lint.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("biome check（pnpm lint と同じ引数）", ({ And }) => {
    And(
      "未使用変数と == を含むファイルは非 0 で終わり、ルール名が出力される",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const { status, output } = checkSource("violation.ts", [
          "export function isAnswer(value: number): boolean {",
          "  const unused = 1;",
          "  return value == 42;",
          "}",
        ]);

        // then
        expect(status, output).not.toBe(0);
        expect(output).toContain("noUnusedVariables");
        expect(output).toContain("noDoubleEquals");
      },
    );

    // severity の方針（すべて error 扱い）を、既定 severity ごとの代表ルールで確かめる。
    // 1 ファイル 1 違反にして、他のルールの error に引きずられて非 0 になっているのではないことを保証する。
    And(
      "既定 severity が warn・info の recommended ルールと recommended 外で追加したルールは、その違反だけでも非 0 で終わる（noUnusedVariables・useTemplate・noConsole）",
      () => {
        // given
        const cases: [string, string, string[]][] = [
          [
            "既定 severity が warn の recommended ルール",
            "noUnusedVariables",
            [
              "export function answer(): number {",
              "  const unused = 1;",
              "  return 42;",
              "}",
            ],
          ],
          [
            "既定 severity が info の recommended ルール",
            "useTemplate",
            [
              "export function greet(name: string): string {",
              '  return "Hello, " + name;',
              "}",
            ],
          ],
          [
            "recommended 外で追加したルール",
            "noConsole",
            [
              "export function debug(value: number): void {",
              "  console.log(value);",
              "}",
            ],
          ],
        ];

        for (const [kind, rule, lines] of cases) {
          // when
          const { status, output } = checkSource(`${rule}.ts`, lines);

          // then
          expect(status, `${kind}\n${output}`).not.toBe(0);
          expect(output, kind).toContain(rule);
        }
      },
    );

    // style/noProcessEnv（Issue #59）: process.env を読んでよいのは apps/shared/env.ts とテストだけ
    //   （.claude/rules/tooling/env.md の「環境変数」）。既定 severity が info なので、biome.json で error にしている。
    // WHY 一時ディレクトリに置いたファイルで must-reject を確かめる: overrides の includes はリポジトリ直下からの相対パスで
    //   照合され、リポジトリの外のファイルは env.ts と同じ名前（.../apps/shared/env.ts）でも一致しない（2026-09-28 実測）。
    //   そのため「env.ts という名前なら何でも許す」ような緩い overrides になっていないことも、同じ仕組みで確かめられる。
    And(
      "env.ts 以外のファイル・リポジトリの外の env.ts という名前のファイル・E2E の spec で process.env を読むと非 0 で終わり、noProcessEnv が出力される",
      () => {
        // given
        const cases: [string, string][] = [
          ["env.ts 以外のファイル", "config.ts"],
          [
            "リポジトリの外にある env.ts という名前のファイル（overrides はパスで照合する）",
            "env.ts",
          ],
          ["E2E の spec（テストの overrides の対象外）", "todo.spec.ts"],
        ];

        for (const [kind, fileName] of cases) {
          // when
          const { status, output } = checkSource(fileName, [
            "export const url = process.env.DATABASE_URL;",
          ]);

          // then
          expect(status, `${kind}\n${output}`).not.toBe(0);
          expect(output, kind).toContain("noProcessEnv");
        }
      },
    );

    And(
      "テスト（x.test.ts・x.test.tsx）では process.env を読んでも 0 で終わる（子プロセスに PATH を渡すなどで使う）",
      () => {
        // given
        const cases: [string][] = [["x.test.ts"], ["x.test.tsx"]];

        for (const [fileName] of cases) {
          // when
          const { status, output } = checkSource(fileName, [
            "export const path = process.env.PATH;",
          ]);

          // then
          expect(status, `${fileName}\n${output}`).toBe(0);
        }
      },
    );

    And(
      "apps/shared/env.ts は process.env を読んでいても 0 で終わる（環境変数の唯一の入口）",
      () => {
        // given
        const envModule = "apps/shared/env.ts";

        // when
        const result = pnpmExec("biome", [
          "check",
          ERROR_ON_WARNINGS,
          envModule,
        ]);

        // then
        // 前提: env.ts が実際に process.env を読んでいること（読んでいなければ、この検査は何も確かめていない）。
        expect(readFileSync(join(repoRoot, envModule), "utf8")).toContain(
          "process.env",
        );
        expect(result.status, result.stdout + result.stderr).toBe(0);
      },
    );

    // suspicious/noConsole（Issue #85）: console を書いてよいのは apps/shared/logger.ts（ログの唯一の出口）と
    //   テストだけ（.claude/rules/code/backend.md の「ログ」）。allow は空にし、console.error / console.warn も違反にする。
    // WHY noProcessEnv と同じく一時ディレクトリのファイルで must-reject を確かめる: overrides の includes はリポジトリ直下からの
    //   相対パスで照合されるので、リポジトリの外の logger.ts という名前のファイルが通らないことで、「logger.ts という名前なら
    //   何でも許す」緩い overrides になっていないことも確かめられる。
    And(
      "console.log・console.error・console.warn を logger.ts 以外のファイル（リポジトリの外の logger.ts という名前のファイル・E2E の spec を含む）に書くと非 0 で終わり、noConsole が出力される",
      () => {
        // given
        const cases: [string, string, string][] = [
          ["console.log", "logger.ts 以外のファイル", "config.ts"],
          [
            "console.error",
            "logger.ts 以外のファイル（allow で許していない）",
            "report.ts",
          ],
          [
            "console.warn",
            "logger.ts 以外のファイル（allow で許していない）",
            "retry.ts",
          ],
          [
            "console.error",
            "リポジトリの外にある logger.ts という名前のファイル（overrides はパスで照合する）",
            "logger.ts",
          ],
          [
            "console.log",
            "E2E の spec（テストの overrides の対象外）",
            "todo.spec.ts",
          ],
        ];

        for (const [call, kind, fileName] of cases) {
          // when
          const { status, output } = checkSource(fileName, [
            "export function report(value: unknown): void {",
            `  ${call}(value);`,
            "}",
          ]);

          // then
          expect(status, `${call} を ${kind}\n${output}`).not.toBe(0);
          expect(output, `${call} を ${kind}`).toContain("noConsole");
        }
      },
    );

    And(
      "テスト（x.test.ts・x.test.tsx）では console を書いても 0 で終わる（vi.spyOn(console, ...) で出力を抑える・確かめる）",
      () => {
        // given
        const cases: [string][] = [["x.test.ts"], ["x.test.tsx"]];

        for (const [fileName] of cases) {
          // when
          const { status, output } = checkSource(fileName, [
            "export function report(value: unknown): void {",
            "  console.log(value);",
            "  console.error(value);",
            "}",
          ]);

          // then
          expect(status, `${fileName}\n${output}`).toBe(0);
        }
      },
    );

    And(
      "apps/shared/logger.ts は console を書いていても 0 で終わる（ログの唯一の出口）",
      () => {
        // given
        const loggerModule = "apps/shared/logger.ts";
        // 前提: logger.ts が実際に console を使っていること（使っていなければ、この検査は何も確かめていない）。
        const source = readFileSync(join(repoRoot, loggerModule), "utf8");

        // when
        const result = pnpmExec("biome", [
          "check",
          ERROR_ON_WARNINGS,
          loggerModule,
        ]);

        // then
        expect(source).toContain("console.log(");
        expect(source).toContain("console.error(");
        expect(result.status, result.stdout + result.stderr).toBe(0);
      },
    );

    // must pass: 上の代表ルールごとに、許可される書き方が通ることを確かめる。ルールが何でも違反にする設定
    //   になっていないことを検出するため。noConsole の must pass は上の logger.ts とテストの検査。
    And(
      "代表ルールの許可される書き方は 0 で終わる（noUnusedVariables: 宣言した変数を使う・useTemplate: テンプレートリテラルで連結する）",
      () => {
        // given
        const cases: [string, string, string[]][] = [
          [
            "noUnusedVariables",
            "宣言した変数を使う",
            [
              "export function answer(): number {",
              "  const used = 42;",
              "  return used;",
              "}",
            ],
          ],
          [
            "useTemplate",
            "テンプレートリテラルで連結する",
            [
              "export function greet(name: string): string {",
              // WHY テンプレートリテラルで書く: 文字列リテラルに `${` を書くと noTemplateCurlyInString に掛かるため、エスケープして書く。
              `  return \`Hello, \${name}\`;`,
              "}",
            ],
          ],
        ];

        for (const [rule, how, lines] of cases) {
          // when
          const { status, output } = checkSource(`allowed-${rule}.ts`, lines);

          // then
          expect(status, `${rule}: ${how}\n${output}`).toBe(0);
        }
      },
    );

    And("違反のないファイルは 0 で終わる", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const { status, output } = checkSource("clean.ts", [
        "export function isAnswer(value: number): boolean {",
        "  return value === 42;",
        "}",
      ]);

      // then
      expect(status, output).toBe(0);
    });
  });

  // noStaticOnlyClass の override の WHY と一時ディレクトリの置き方は、モジュールの最上位の staticOnlyClassDir の前のコメント。
  Scenario(
    "biome check の noStaticOnlyClass は apps/backend・apps/shared・apps/e2e と frontend の React 以外のモジュールだけで off（Issue #262）",
    ({ And }) => {
      And(
        "apps/backend・apps/shared・apps/e2e・frontend の React 以外のモジュールでは static だけのクラスが 0 で終わる（backend の shared/error・features の infra・test-support、apps/shared、apps/e2e、frontend の features・shared・test-support の .ts と .mts）",
        () => {
          // given
          const cases: [string][] = [
            ["apps/backend/shared/error/static-only.ts"],
            ["apps/backend/features/todo/internal/infra/static-only.ts"],
            ["apps/shared/static-only.ts"],
            ["apps/backend/test-support/static-only.ts"],
            ["apps/e2e/static-only.ts"],
            ["apps/frontend_customer/features/todo/api/static-only.ts"],
            ["apps/frontend_customer/shared/i18n/static-only.ts"],
            [
              "apps/frontend_customer/shared/request-log/nested/static-only.mts",
            ],
            ["apps/frontend_customer/test-support/static-only.ts"],
          ];

          for (const [path] of cases) {
            // when
            const { status, output } = checkAt(path, STATIC_ONLY_CLASS);

            // then
            expect(status, `${path}\n${output}`).toBe(0);
          }
        },
      );

      And(
        "apps/backend・apps/shared・apps/e2e・frontend の React 以外のモジュールの外では static だけのクラスが非 0 で終わり、noStaticOnlyClass が出力される（前方一致だけが同じ別ディレクトリ・frontend の component と hook とテスト・frontend の app/ と直下・リポジトリ直下）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "apps/shared-x/static-only.ts",
              "名前の前方一致だけが同じ別ディレクトリ",
            ],
            [
              "apps/frontend_customer/features/todo/components/static-only.tsx",
              "frontend の React の component",
            ],
            [
              "apps/frontend_customer/shared/ui/static-only.jsx",
              "frontend の React の component",
            ],
            [
              "apps/frontend_customer/features/todo/screens/x/static-only.hook.ts",
              "frontend の React の hook",
            ],
            [
              "apps/frontend_customer/features/todo/api/static-only.test.ts",
              "frontend のテスト（規則 class-based の対象外）",
            ],
            ["apps/frontend_customer/app/static-only.ts", "frontend の app/"],
            ["apps/frontend_customer/static-only.ts", "frontend の直下"],
            [
              "apps/frontend_customer/features-x/static-only.ts",
              "名前の前方一致だけが同じ別ディレクトリ",
            ],
            [
              "apps/backend-x/static-only.ts",
              "名前の前方一致だけが同じ別ディレクトリ",
            ],
            [
              "apps/e2e-x/static-only.ts",
              "名前の前方一致だけが同じ別ディレクトリ",
            ],
            ["static-only.ts", "リポジトリ直下"],
          ];

          for (const [path] of cases) {
            // when
            const { status, output } = checkAt(path, STATIC_ONLY_CLASS);

            // then
            expect(status, `${path}\n${output}`).not.toBe(0);
            expect(output, path).toContain("noStaticOnlyClass");
          }
        },
      );

      // WHY: 上の非 0 が、設定の読み込みの失敗など noStaticOnlyClass 以外の理由ではないことを示す（同じ場所でインスタンスのメンバーを
      //   持つクラスは通る）。
      And(
        "apps/frontend_customer の app/ でもインスタンスのメンバーを持つクラスは 0 で終わる",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const { status, output } = checkAt(
            "apps/frontend_customer/app/instance-class.ts",
            [
              "export class Paths {",
              "  of(name: string): string {",
              "    return name;",
              "  }",
              "}",
            ],
          );

          // then
          expect(status, output).toBe(0);
        },
      );

      And(
        "リポジトリの apps/backend/shared/drizzle/drizzle.config.ts（static だけのクラス DrizzleConfigPath）は 0 で終わる",
        () => {
          // given
          const configFile = "apps/backend/shared/drizzle/drizzle.config.ts";
          // 前提: static だけのクラスを実際に持つこと（持たなければ、この検査は何も確かめていない）。
          const source = readFileSync(join(repoRoot, configFile), "utf8");

          // when
          const result = pnpmExec("biome", [
            "check",
            ERROR_ON_WARNINGS,
            configFile,
          ]);

          // then
          expect(source).toContain("class DrizzleConfigPath {");
          expect(source).toContain("  static fromConfigDir(");
          expect(result.status, result.stdout + result.stderr).toBe(0);
        },
      );
    },
  );

  Scenario(
    "--error-on-warnings 付きの biome check かの判定（runsBiomeCheckWithErrorOnWarnings）",
    ({ And }) => {
      And(
        "--error-on-warnings 付きの biome check は許可する（フラグの位置・--write・pnpm exec と lefthook の引数・&& でつなぐ）",
        () => {
          // given
          const cases: [string][] = [
            ["biome check --error-on-warnings ."],
            ["biome check --write --error-on-warnings ."],
            ["biome check . --error-on-warnings"],
            [
              "pnpm exec biome check --error-on-warnings --no-errors-on-unmatched --files-ignore-unknown=true {staged_files}",
            ],
            ["pnpm install && biome check --error-on-warnings ."],
          ];

          // when
          const result = casesByName(cases, ([command]) =>
            runsBiomeCheckWithErrorOnWarnings(command),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => true));
        },
      );

      And(
        "--error-on-warnings が無い・check でない・別のコマンドの引数・npx・失敗を打ち消すつなぎ・warn を効かなくするフラグ・空文字は拒否する（||・;・改行・|・&・--diagnostic-level・--only・--skip）",
        () => {
          // given
          const cases: [string, string][] = [
            ["biome check .", "--error-on-warnings が無い"],
            ["biome check --write .", "--error-on-warnings が無い（自動修正）"],
            ["biome lint --error-on-warnings .", "check ではなく lint"],
            ["biome format --error-on-warnings .", "check ではなく format"],
            [
              "biome check . && echo --error-on-warnings",
              "フラグが別のコマンドの引数にある",
            ],
            [
              "echo biome check --error-on-warnings",
              "biome check が別のコマンドの引数にある",
            ],
            [
              "npx biome check --error-on-warnings .",
              "npx で起動する（pnpm のみ）",
            ],
            [
              "biome check --error-on-warnings . || true",
              "|| で失敗を打ち消す",
            ],
            [
              "true || biome check --error-on-warnings .",
              "|| の後ろで実行されない",
            ],
            [
              "biome check --error-on-warnings . ; exit 0",
              "; の後ろのコマンドの終了コードになる",
            ],
            [
              "biome check --error-on-warnings .; exit 0",
              "; の後ろのコマンドの終了コードになる（空白なし）",
            ],
            [
              "biome check --error-on-warnings .\nexit 0",
              "改行の後ろのコマンドの終了コードになる",
            ],
            [
              "biome check --error-on-warnings . | cat",
              "パイプの最後のコマンドの終了コードになる",
            ],
            [
              "biome check --error-on-warnings . &",
              "& でバックグラウンドにして終了コードを見ない",
            ],
            [
              "biome check --error-on-warnings --diagnostic-level=error .",
              "--diagnostic-level=error で warn を出さない",
            ],
            [
              "biome check --error-on-warnings --diagnostic-level error .",
              "--diagnostic-level（空白区切り）",
            ],
            [
              "biome check --error-on-warnings --only=suspicious/noConsole .",
              "--only で他のルールを止める",
            ],
            [
              "biome check --error-on-warnings --only suspicious/noConsole .",
              "--only（空白区切り）",
            ],
            [
              "biome check --error-on-warnings --skip=correctness/noUnusedVariables .",
              "--skip でルールを止める",
            ],
            [
              "biome check --error-on-warnings --skip correctness .",
              "--skip（空白区切り）",
            ],
            ["", "空文字"],
          ];

          // when
          const result = casesByName(cases, ([command]) =>
            runsBiomeCheckWithErrorOnWarnings(command),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => false));
        },
      );
    },
  );

  Scenario("package.json scripts", ({ And }) => {
    And(
      "lint と check は --error-on-warnings 付きで biome check を実行する",
      () => {
        // given
        const cases: [string, string][] = [
          ["lint", pkg.scripts.lint],
          ["check", pkg.scripts.check],
        ];

        // when
        const result = casesByName(cases, ([, script]) => ({
          script,
          allowed: runsBiomeCheckWithErrorOnWarnings(script),
        }));

        // then
        expect(result).toEqual(
          casesByName(cases, ([, script]) => ({ script, allowed: true })),
        );
      },
    );
  });

  Scenario("lefthook.yml", ({ And }) => {
    And(
      "pre-commit で --error-on-warnings 付きの biome check を実行するコマンドが定義されている",
      () => {
        // given: 前提なし（リポジトリの lefthook.yml を読む）
        // when
        // WHY: YAML を自前でパースせず `lefthook dump` を使うのは、Lefthook 自身が解釈した結果
        //   （インデント崩れなどで意図と違う構造になっていないか）を検査するため。
        const result = pnpmExec("lefthook", ["dump", "--format", "json"]);
        const config = JSON.parse(result.stdout) as {
          "pre-commit"?: { commands?: Record<string, { run?: string }> };
        };
        const runs = Object.values(config["pre-commit"]?.commands ?? {}).map(
          (command) => command.run ?? "",
        );

        // then
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(runs.filter(runsBiomeCheckWithErrorOnWarnings)).toHaveLength(1);
      },
    );
  });
});

// 環境変数の唯一の入口（Issue #59）。アプリ・テスト・ツールの設定ファイルは、process.env を直接読まずにここの env / toolEnv を使う。
// 規則と WHY は rules/code/env.md の「環境変数」。process.env を直接読むと Biome（style/noProcessEnv）と
// architecture.test.ts（規則 env-direct-access）で失敗する。process.env に触ってよいのはこのファイルだけ
// （例外はルート直下の instrumentation.ts が Next.js の規約の NEXT_RUNTIME を読む 1 か所だけ）。
//
// WHY 1 か所にまとめる: 変数ごとに読む場所が散らばると、既定値や検証（数として使えるか）が場所ごとにずれ、
//   どの変数が必要かを一覧できない。ここで型を付けて検証した値だけを配ると、使う側は string | undefined を扱わずに済む。
// WHY すべて必須で既定値を持たない: 既定値があると、.env の書き忘れや CI の設定漏れが黙って既定値で動き、
//   意図しない DB（手元の開発用 DB など）に接続しても気づけない。値は .env.example に置き、コードには置かない。
// WHY モジュールの読み込み時に検証する（遅延させない）: 欠けた変数に、その変数を初めて使うリクエストの途中で気づくのではなく、
//   next build / next start / vitest / playwright / drizzle-kit の起動時に分かるようにする。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

type EnvSource = Record<string, string | undefined>;

// アプリの設定。すべて必須。名前は環境変数と同じにし、grep で .env.example・文書と突き合わせられるようにする。
export type Env = {
  // Postgres の接続先。
  DATABASE_URL: string;
  // プールの最大接続数（1 以上）。
  DATABASE_POOL_MAX: number;
  // 使われない接続を閉じるまでの時間（ミリ秒、0 以上）。
  DATABASE_POOL_IDLE_TIMEOUT_MS: number;
  // 接続待ちの上限（ミリ秒、0 以上。0 は無制限）。
  DATABASE_CONNECTION_TIMEOUT_MS: number;
};

// 開発ツールの切り替え（任意）。アプリの設定ではなく、テストや CI の実行のしかたを変えるだけのフラグ。
// WHY Env と分ける: これらは設定されていないのが正常（手元では CI も PLAYWRIGHT_CHROMIUM_EXECUTABLE も無い）。
//   必須にすると .env.example に「CI=」のような嘘の値を置くことになり、それを .env にコピーすると CI として動いてしまう。
// ここに足してよいのは、ツール（CI・Playwright・Stryker など）が設定するか、ツールの動かし方を切り替えるフラグだけ。
//   アプリの設定（接続先・上限値など）は必ず Env に足し、必須にする。
export type ToolEnv = {
  // CI で動いているか。Playwright の reuseExistingServer を切り替える（playwright.config.ts）。
  // 空でなければ true（Playwright の公式の例 `!process.env.CI` と同じ扱い）。lefthook の postinstall は "0" / "false" を
  //   無効として扱うが、ここではフックの導入には使わないので合わせない。
  CI: boolean;
  // E2E で使う Chromium の実行ファイル（クラウド VM 用。playwright.config.ts）。空なら未設定と同じ。
  PLAYWRIGHT_CHROMIUM_EXECUTABLE: string | undefined;
  // Stryker（mutation testing）の worker の中で動いているか。Stryker が子プロセスに渡す（@stryker-mutator/core 10.0.0 の
  //   child-process-proxy.js）。テスト用スキーマの後始末を止めるのに使う（backend/shared/infra/database.test-support.ts）。
  STRYKER_MUTATOR_WORKER: boolean;
};

// 必須の変数の検証。欠けていれば "未設定"、値が不正なら理由を返し、正しければ値を返す。
type Check<T> = { value: T } | { problem: string };

function requiredString(raw: string): Check<string> {
  return { value: raw };
}

// WHY 数として使えない値はエラーにする: Number("abc") は NaN になり、プールに渡すと上限やタイムアウトが効かない
//   （意図しない無制限になりうる）まま動いてしまう。起動時に分かるように止める。
// WHY /^\d+$/ で判定する: Number() は "1e3"・" 5"・"0x10" も数にしてしまい、書き間違いを見逃すため。
function nonNegativeInteger(raw: string): Check<number> {
  if (!/^\d+$/.test(raw)) {
    return { problem: `0 以上の整数で指定してください（値: ${raw}）` };
  }
  return { value: Number(raw) };
}

// 接続数 0 のプールはクエリを永久に待たせるだけなので、1 以上に限る。
function positiveInteger(raw: string): Check<number> {
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    return { problem: `1 以上の整数で指定してください（値: ${raw}）` };
  }
  return { value: Number(raw) };
}

const PARSERS: { [K in keyof Env]: (raw: string) => Check<Env[K]> } = {
  DATABASE_URL: requiredString,
  DATABASE_POOL_MAX: positiveInteger,
  DATABASE_POOL_IDLE_TIMEOUT_MS: nonNegativeInteger,
  DATABASE_CONNECTION_TIMEOUT_MS: nonNegativeInteger,
};

// source（本番は process.env）から Env を読む。純粋関数にして、テストで偽の source を渡せるようにしている。
// WHY 全件を検査してからまとめて投げる: 1 件ずつ止めると、直して起動し直すたびに次の 1 件が見つかり、何度も往復する。
// WHY 空文字と空白だけの値も未設定と同じに扱う: `DATABASE_URL=` や `DATABASE_URL=  ` のように値を書き忘れた行は、
//   値が無いのと同じ意味のため（空白だけの接続先を渡しても、接続時に分かりにくいエラーになるだけ）。
//   値そのものは trim せずに渡す（前後の空白を黙って直すと、.env と実際の値がずれるため。数の検証は空白を含むとエラー）。
export function readEnv(source: EnvSource): Env {
  const values: Partial<Record<keyof Env, unknown>> = {};
  const problems: string[] = [];
  for (const name of Object.keys(PARSERS) as (keyof Env)[]) {
    const raw = source[name];
    if (raw === undefined || raw.trim() === "") {
      problems.push(`${name}: 設定されていません`);
      continue;
    }
    const checked = PARSERS[name](raw);
    if ("problem" in checked) {
      problems.push(`${name}: ${checked.problem}`);
      continue;
    }
    values[name] = checked.value;
  }
  if (problems.length > 0) {
    throw new Error(
      [
        "環境変数が足りないか、値が正しくありません。",
        ...problems.map((problem) => `  - ${problem}`),
        "リポジトリ直下で cp .env.example .env を実行して .env を作り、値を確かめてください（rules/code/env.md の「環境変数」）。",
      ].join("\n"),
    );
  }
  return values as Env;
}

// 空文字は未設定と同じに扱う（`CI=` と書いたときに有効にしない）。未設定（undefined）はそのまま返る。
function nonEmpty(raw: string | undefined): string | undefined {
  return raw === "" ? undefined : raw;
}

export function readToolEnv(source: EnvSource): ToolEnv {
  return {
    CI: nonEmpty(source.CI) !== undefined,
    PLAYWRIGHT_CHROMIUM_EXECUTABLE: nonEmpty(
      source.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    ),
    STRYKER_MUTATOR_WORKER:
      nonEmpty(source.STRYKER_MUTATOR_WORKER) !== undefined,
  };
}

// path の .env を process.env に読み込む。読み込んだら true、ファイルが無ければ false。
// WHY Node の process.loadEnvFile を使う（dotenv などを足さない）: Node 20.12 / 21.7 以降に標準である。依存を増やさない。
// WHY 環境変数を優先する: process.loadEnvFile は、すでに process.env にある変数をファイルの値で上書きしない（2026-09-28、
//   Node 24.21.0 で実測）。CI やコマンドの前に付けた値（DATABASE_URL=... pnpm db:migrate）が .env より優先される。
// WHY ファイルが無いとき（ENOENT）だけ握りつぶす: .env を置かずに環境変数だけで渡す動かし方（本番など）を許すため。
//   必須の変数が足りなければ、この後の readEnv が名前を挙げて止める。それ以外のエラー（読めない、形式が壊れているなど）は、
//   黙って進むと原因が分からなくなるので投げる。
export function loadDotEnvFile(path: string): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

// start から上に向かって pnpm-workspace.yaml のあるディレクトリ（リポジトリ直下）を探す。見つからなければ start を返す。
// WHY pnpm-workspace.yaml を目印にする: リポジトリ直下にだけあり、apps/frontend・apps/backend には無い（Issue #68）。
//   .git は worktree ではファイルになり、git の無いコピー（Stryker のサンドボックスなど）には無いので使わない。
// WHY 見つからなければ start を返す: リポジトリの外（.env と環境変数だけを置いた実行環境など）でも、以前と同じく
//   カレントディレクトリの .env を読めるようにする。
export function findRepoRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) {
      return start;
    }
    dir = parent;
  }
  return dir;
}

// cwd から探したリポジトリ直下の .env を読む。読み込んだら true、ファイルが無ければ false（loadDotEnvFile と同じ）。
// WHY リポジトリ直下の .env を 1 つだけ読む（Issue #68 のユーザー判断）: .env は app ごとに置かず、リポジトリ直下に 1 つにする。
//   pnpm のスクリプト（next / vitest / playwright / drizzle-kit）は今はリポジトリ直下で動くが、workspace パッケージ化
//   （Issue #68 の段階 2）の pnpm --filter はパッケージのディレクトリ（apps/backend など）で動くため、カレントディレクトリの
//   .env を読むだけでは見つからない。
// WHY このファイルの場所から探さない（import.meta.dirname を使わない）: Next のビルドでバンドルされると元の場所を指さないため。
export function loadRepoDotEnv(cwd: string): boolean {
  return loadDotEnvFile(join(findRepoRoot(cwd), ".env"));
}

// next dev / build / start apps/frontend では、Next.js は apps/frontend の .env を探すが、そこには置かない（リポジトリ直下に
//   1 つだけ）。Next.js が読まなくても、ここでリポジトリ直下の .env を読む。
loadRepoDotEnv(process.cwd());

export const env: Env = readEnv(process.env);

export const toolEnv: ToolEnv = readToolEnv(process.env);

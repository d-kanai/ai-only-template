// 環境変数の唯一の入口（Issue #59）。アプリ・テスト・ツールの設定ファイルは、process.env を直接読まずにここの env / toolEnv を使う。
// 規則と WHY は .claude/rules/env.md の「環境変数」。process.env を直接読むと Biome（style/noProcessEnv）と
// rule-tests/architecture.test.ts（規則 env-direct-access）で失敗する。process.env に触ってよいのはこのファイルだけ
// （例外は apps/frontend_customer/instrumentation.ts が Next.js の規約の NEXT_RUNTIME を読む 1 か所だけ）。
// 置き場所は frontend と backend で共通の workspace パッケージ apps/shared（@repo/shared/env。Issue #90 で apps/backend/shared/infra/
// から移した。frontend 直下の instrumentation-node.ts・backend・apps/e2e/・vitest.global-setup.ts が使う。.claude/rules/shared.md）。
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
  // DB 側で 1 つの文を打ち切るまでの時間（ミリ秒、0 以上。0 は送らず DB 側の既定に従う）。Postgres の statement_timeout。
  DATABASE_STATEMENT_TIMEOUT_MS: number;
  // DB 側で行ロックなどを待つ上限（ミリ秒、0 以上。0 は送らず DB 側の既定に従う）。Postgres の lock_timeout。
  DATABASE_LOCK_TIMEOUT_MS: number;
  // トランザクションを開いたまま何もしていない接続を DB が切るまでの時間（ミリ秒、0 以上。0 は送らず DB 側の既定に従う）。
  //   Postgres の idle_in_transaction_session_timeout。
  DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: number;
  // GCP のプロジェクト ID。リクエストログの trace（projects/<ID>/traces/<trace-id>。Cloud Logging の特別フィールド
  //   logging.googleapis.com/trace）に入れる（Issue #209。apps/frontend_customer/proxy.ts）。
  // WHY 環境変数で受け取る: Cloud Run が自動で付ける環境変数（PORT・K_SERVICE など。
  //   https://docs.cloud.google.com/run/docs/container-contract の Environment variables）にプロジェクト ID は無い。メタデータ
  //   サーバからは取れるが、起動時の通信が要り、手元・CI では取れない。infra（infra/modules/app/run.tf）が var.project_id を渡す。
  GCP_PROJECT_ID: string;
};

// 開発ツールの切り替え（任意）。アプリの設定ではなく、テストや CI の実行のしかたを変えるだけのフラグ。
// WHY Env と分ける: これらは設定されていないのが正常（手元では CI も PLAYWRIGHT_CHROMIUM_EXECUTABLE も無い）。
//   必須にすると .env.example に「CI=」のような嘘の値を置くことになり、それを .env にコピーすると CI として動いてしまう。
// ここに足してよいのは、ツール（CI・Playwright・Stryker など）が設定するか、ツールの動かし方を切り替えるフラグだけ。
//   アプリの設定（接続先・上限値など）は必ず Env に足し、必須にする。
export type ToolEnv = {
  // CI で動いているか。Playwright の reuseExistingServer を切り替える（apps/e2e/playwright.config.ts）。
  // 空でなければ true（Playwright の公式の例 `!process.env.CI` と同じ扱い）。lefthook の postinstall は "0" / "false" を
  //   無効として扱うが、ここではフックの導入には使わないので合わせない。
  CI: boolean;
  // E2E で使う Chromium の実行ファイル（クラウド VM 用。apps/e2e/playwright.config.ts）。空なら未設定と同じ。
  PLAYWRIGHT_CHROMIUM_EXECUTABLE: string | undefined;
  // Stryker（mutation testing）の worker の中で動いているか。Stryker が子プロセスに渡す（@stryker-mutator/core 10.0.0 の
  //   child-process-proxy.js）。テスト用スキーマの後始末を止めるのに使う（apps/backend/test-support/database.ts）。
  STRYKER_MUTATOR_WORKER: boolean;
  // E2E（Playwright）が本番ビルドを起動するポート（1〜65535。apps/e2e/playwright.config.ts）。未設定なら undefined で、
  //   apps/e2e/playwright.config.ts が既定の 3100 を使う。ツールの動かし方（E2E のポート）の切り替え。
  // WHY Env（必須）でなくここ: E2E 専用で、アプリ（next start）は使わない。必須にすると本番や既存の .env にテスト用の
  //   変数を要求し、足すまで全コマンドが止まる（Issue #64 の reviewer 指摘）。
  // WHY 任意でも不正な値はエラーにする: 0 や範囲外を黙って既定値にすると、worktree ごとに分けたつもりのポートが
  //   3100 に戻り、reuseExistingServer で別の worktree のサーバを検証してしまう（.claude/rules/worktree.md）。
  E2E_PORT: number | undefined;
};

// 必須の変数の検証。欠けていれば "未設定"、値が不正なら理由を返し、正しければ値を返す。
type Check<T> = { value: T } | { problem: string };

// 変数の値の検証と読み取り（Env・ToolEnv）。
// WHY クラスの static メソッドにする（Issue #262）: apps/shared も最上位に関数を置かない（規則 class-based。ADR
//   docs/adr/architecture/20261002-class-based-shared-and-test-support.md）。状態を持たないので static。
export class EnvReader {
  // source（本番は process.env）から Env を読む。純粋なメソッドにして、テストで偽の source を渡せるようにしている。
  // WHY 全件を検査してからまとめて投げる: 1 件ずつ止めると、直して起動し直すたびに次の 1 件が見つかり、何度も往復する。
  // WHY 空文字と空白だけの値も未設定と同じに扱う: `DATABASE_URL=` や `DATABASE_URL=  ` のように値を書き忘れた行は、
  //   値が無いのと同じ意味のため（空白だけの接続先を渡しても、接続時に分かりにくいエラーになるだけ）。
  //   値そのものは trim せずに渡す（前後の空白を黙って直すと、.env と実際の値がずれるため。数の検証は空白を含むとエラー）。
  static read(source: EnvSource): Env {
    const parsers = EnvReader.parsers();
    const values: Partial<Record<keyof Env, unknown>> = {};
    const problems: string[] = [];
    for (const name of Object.keys(parsers) as (keyof Env)[]) {
      const raw = source[name];
      if (raw === undefined || raw.trim() === "") {
        problems.push(`${name}: is not set`);
        continue;
      }
      const checked = parsers[name](raw);
      if ("problem" in checked) {
        problems.push(`${name}: ${checked.problem}`);
        continue;
      }
      values[name] = checked.value;
    }
    if (problems.length > 0) {
      throw new Error(
        [
          "Environment variables are missing or invalid.",
          ...problems.map((problem) => `  - ${problem}`),
          "Run cp .env.example .env at the repository root to create .env, then check the values (see .claude/rules/env.md).",
        ].join("\n"),
      );
    }
    return values as Env;
  }

  // WHY 不正な値は投げる（read と同じく、読み込み時の起動エラーにする）: 任意の変数でも、書いた値が黙って無視されると
  //   意図と違う動き（E2E_PORT なら既定の 3100 に戻る）に気づけないため。
  static readTool(source: EnvSource): ToolEnv {
    const problems: string[] = [];
    const e2ePort = EnvReader.optionalNumber(
      "E2E_PORT",
      source.E2E_PORT,
      (raw) => EnvReader.portNumber(raw),
      problems,
    );
    if (problems.length > 0) {
      throw new Error(
        [
          "Environment variable values are invalid.",
          ...problems.map((problem) => `  - ${problem}`),
        ].join("\n"),
      );
    }
    return {
      CI: EnvReader.nonEmpty(source.CI) !== undefined,
      PLAYWRIGHT_CHROMIUM_EXECUTABLE: EnvReader.nonEmpty(
        source.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      ),
      STRYKER_MUTATOR_WORKER:
        EnvReader.nonEmpty(source.STRYKER_MUTATOR_WORKER) !== undefined,
      E2E_PORT: e2ePort,
    };
  }

  private static requiredString(raw: string): Check<string> {
    return { value: raw };
  }

  // WHY 数として使えない値はエラーにする: Number("abc") は NaN になり、プールに渡すと上限やタイムアウトが効かない
  //   （意図しない無制限になりうる）まま動いてしまう。起動時に分かるように止める。
  // WHY /^\d+$/ で判定する: Number() は "1e3"・" 5"・"0x10" も数にしてしまい、書き間違いを見逃すため。
  private static nonNegativeInteger(raw: string): Check<number> {
    if (!/^\d+$/.test(raw)) {
      return { problem: `must be an integer >= 0 (got: ${raw})` };
    }
    return { value: Number(raw) };
  }

  // 接続数 0 のプールはクエリを永久に待たせるだけなので、1 以上に限る。
  private static positiveInteger(raw: string): Check<number> {
    if (!/^\d+$/.test(raw) || Number(raw) === 0) {
      return { problem: `must be an integer >= 1 (got: ${raw})` };
    }
    return { value: Number(raw) };
  }

  // TCP のポートとして使える 1〜65535 に限る。
  // WHY 0 を拒否する: 0 は「OS が空きポートを選ぶ」意味になり、webServer と baseURL（テスト側）の番号がずれる。
  private static portNumber(raw: string): Check<number> {
    if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65_535) {
      return { problem: `must be an integer from 1 to 65535 (got: ${raw})` };
    }
    return { value: Number(raw) };
  }

  // 変数ごとの検証。
  // WHY 表をメソッドの中で作る（最上位の定数・static フィールドにしない）: 最上位の値は Stryker の static な変異になり、
  //   ignoreStatic で検査から外れる（.claude/rules/testing.md の mutation testing）。クラスの static フィールドの初期化も読み込み時に
  //   1 回だけ評価されるので、同じく外れるおそれがある（未確認。ADR docs/adr/architecture/20261002-class-based-backend.md）。
  private static parsers(): {
    [K in keyof Env]: (raw: string) => Check<Env[K]>;
  } {
    return {
      DATABASE_URL: (raw) => EnvReader.requiredString(raw),
      DATABASE_POOL_MAX: (raw) => EnvReader.positiveInteger(raw),
      DATABASE_POOL_IDLE_TIMEOUT_MS: (raw) => EnvReader.nonNegativeInteger(raw),
      DATABASE_CONNECTION_TIMEOUT_MS: (raw) =>
        EnvReader.nonNegativeInteger(raw),
      DATABASE_STATEMENT_TIMEOUT_MS: (raw) => EnvReader.nonNegativeInteger(raw),
      DATABASE_LOCK_TIMEOUT_MS: (raw) => EnvReader.nonNegativeInteger(raw),
      DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: (raw) =>
        EnvReader.nonNegativeInteger(raw),
      GCP_PROJECT_ID: (raw) => EnvReader.requiredString(raw),
    };
  }

  // 空文字は未設定と同じに扱う（`CI=` と書いたときに有効にしない）。未設定（undefined）はそのまま返る。
  private static nonEmpty(raw: string | undefined): string | undefined {
    return raw === "" ? undefined : raw;
  }

  // 任意の数の変数: 未設定・空文字なら undefined、値があれば parse で検証し、不正なら problems に積む。
  private static optionalNumber(
    name: string,
    raw: string | undefined,
    parse: (raw: string) => Check<number>,
    problems: string[],
  ): number | undefined {
    const value = EnvReader.nonEmpty(raw);
    if (value === undefined) {
      return undefined;
    }
    const checked = parse(value);
    if ("problem" in checked) {
      problems.push(`${name}: ${checked.problem}`);
      return undefined;
    }
    return checked.value;
  }
}

// .env のファイルの読み込み（process.env に入れる）。
// WHY EnvReader と分ける: こちらはファイルと process.env を変える（副作用がある）。EnvReader は渡された source を読むだけの
//   純粋なメソッドで、テストは偽の source を渡す。名前で副作用の有無が分かるようにする。
export class DotEnvFile {
  // path の .env を process.env に読み込む。読み込んだら true、ファイルが無ければ false。
  // WHY Node の process.loadEnvFile を使う（dotenv などを足さない）: Node 20.12 / 21.7 以降に標準である。依存を増やさない。
  // WHY 環境変数を優先する: process.loadEnvFile は、すでに process.env にある変数をファイルの値で上書きしない（2026-09-28、
  //   Node 24.21.0 で実測）。CI やコマンドの前に付けた値（DATABASE_URL=... pnpm db:migrate）が .env より優先される。
  // WHY ファイルが無いとき（ENOENT）だけ握りつぶす: .env を置かずに環境変数だけで渡す動かし方（本番など）を許すため。
  //   必須の変数が足りなければ、この後の EnvReader.read が名前を挙げて止める。それ以外のエラー（読めない、形式が壊れているなど）は、
  //   黙って進むと原因が分からなくなるので投げる。
  static load(path: string): boolean {
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
  // WHY pnpm-workspace.yaml を目印にする: リポジトリ直下にだけあり、apps/frontend_customer・apps/backend には無い（Issue #68）。
  //   .git は worktree ではファイルになり、git の無いコピー（Stryker のサンドボックスなど）には無いので使わない。
  // WHY 見つからなければ start を返す: リポジトリの外（.env と環境変数だけを置いた実行環境など）でも、以前と同じく
  //   カレントディレクトリの .env を読めるようにする。
  static findRepoRoot(start: string): string {
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

  // cwd から探したリポジトリ直下の .env を読む。読み込んだら true、ファイルが無ければ false（DotEnvFile.load と同じ）。
  // WHY リポジトリ直下の .env を 1 つだけ読む（Issue #68 のユーザー判断）: .env は app ごとに置かず、リポジトリ直下に 1 つにする。
  //   vitest はリポジトリ直下で動くが、workspace パッケージの script（pnpm --filter @repo/frontend-customer build /
  //   pnpm --filter @repo/backend db:migrate・pnpm --filter @repo/e2e test（playwright。Issue #84）など。Issue #68 の段階 2）は
  //   パッケージのディレクトリ（apps/frontend_customer・apps/backend・apps/e2e）で
  //   動くため、カレントディレクトリの .env を読むだけでは見つからない。
  // WHY このファイルの場所から探さない（import.meta.dirname を使わない）: Next のビルドでバンドルされると元の場所を指さないため。
  static loadFromRepoRoot(cwd: string): boolean {
    return DotEnvFile.load(join(DotEnvFile.findRepoRoot(cwd), ".env"));
  }
}

// apps/frontend_customer の next dev / build / start では、Next.js は apps/frontend_customer の .env を探すが、そこには置かない（リポジトリ直下に
//   1 つだけ）。Next.js が読まなくても、ここでリポジトリ直下の .env を読む。
DotEnvFile.loadFromRepoRoot(process.cwd());

export const env: Env = EnvReader.read(process.env);

export const toolEnv: ToolEnv = EnvReader.readTool(process.env);

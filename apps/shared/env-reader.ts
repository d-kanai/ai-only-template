// 環境変数の値の検証と読み取り（Env・ToolEnv の型と EnvReader）。env.ts（環境変数の唯一の入口）が process.env を渡して使う。
// WHY env.ts から分けた（Issue #384）: 本番のコードは 1 ファイル 1 クラス（Biome の style/noExcessiveClassesPerFile）にする。
// WHY 分けるのが EnvReader（DotEnvFile ではない）: EnvReader は渡された source を読むだけの純粋なメソッドで、process.env に
//   触らない。process.env を読むコード（env / toolEnv の組み立て）と .env の読み込み（DotEnvFile）は env.ts に残す（Biome の
//   style/noProcessEnv の override と rule-tests/architecture.test.ts の env-direct-access が env.ts だけを許す）。
// exports には置かない内部のファイルで、apps/shared の中から相対パスで読む（.claude/rules/code/shared.md）。外からは Env・ToolEnv の
//   型を env.ts（@repo/shared/env）から読む。

export type EnvSource = Record<string, string | undefined>;

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
  //   3100 に戻り、reuseExistingServer で別の worktree のサーバを検証してしまう（.claude/rules/tooling/worktree.md）。
  E2E_PORT: number | undefined;
  // Next が起動のしかたで決める実行のモード（next dev は "development"、next build / next start は "production"）。空なら未設定と同じ。
  //   画面の Content-Security-Policy に、開発のときだけ 'unsafe-eval' を足すのに使う（apps/frontend_customer/proxy.ts。Issue #106）。
  // WHY Env（必須）でなくここ: 値を決めるのはツール（Next）で、.env に書く設定ではない（.env に書くと next dev でも production になる）。
  NODE_ENV: string | undefined;
  // E2E のブラウザと API の通信を通すプロキシ（例: http://127.0.0.1:8090）。空なら未設定と同じで、プロキシを通さない。
  //   CI では scripts/security/scan.sh zap-e2e が ZAP を起動してこの値を渡し、E2E が実際に触った画面と API の通信を ZAP の
  //   受け身の検査（passive scan）にかける（Issue #364。apps/e2e/playwright.config.ts）。
  // WHY Env（必須）でなくここ: E2E の動かし方の切り替えで、アプリは使わない。手元のふだんの E2E は ZAP なしで動かす。
  E2E_PROXY: string | undefined;
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
          "Run cp .env.example .env at the repository root to create .env, then check the values (see .claude/rules/tooling/env.md).",
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
      NODE_ENV: EnvReader.nonEmpty(source.NODE_ENV),
      E2E_PROXY: EnvReader.nonEmpty(source.E2E_PROXY),
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
  //   ignoreStatic で検査から外れる（.claude/rules/quality/testing.md の mutation testing）。クラスの static フィールドの初期化も読み込み時に
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

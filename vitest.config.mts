import react from "@vitejs/plugin-react";
import {
  configDefaults,
  coverageConfigDefaults,
  defineConfig,
} from "vitest/config";

// Next.js 公式の Vitest ガイド（https://nextjs.org/docs/app/guides/testing/vitest）の構成をベースにしている。
export default defineConfig({
  // react: テスト対象の .tsx を React の JSX として変換するため。
  plugins: [react()],
  resolve: {
    // tsconfigPaths: tsconfig の paths を Vitest（Vite）側でも解決させるため。
    //   Next.js は tsconfig の paths を自前で解決するが、Vite は既定では解決しない（vite 8.3.1 の型定義で @default false）。
    //   解決するのは frontend の "@/*"（apps/frontend/*）。paths はリポジトリ直下の tsconfig.json と
    //   apps/frontend/tsconfig.json の両方に同じ行き先で書いている（どちらが使われても同じファイルになる）。
    //   frontend から backend を指す "@repo/backend/..." は paths ではなく、workspace パッケージとして Vite の通常の解決
    //   （node_modules/@repo/backend → apps/backend と、apps/backend/package.json の exports）で解決する（Issue #68 の段階 2）。
    //   backend の中は相対パスだけなので paths を使わない（rule-tests/architecture.test.ts の backend-relative-only）。
    //   これがないとテスト対象を "@/..." で import したときに解決に失敗する（apps/frontend/features/ のテストが
    //   "@/features/..." を import しており、解決できなければそれらのテストが失敗することで担保）。
    //   Next.js 公式ガイドは vite-tsconfig-paths プラグインを案内しているが、Vite 8 には同等の標準オプションがある。
    //   プラグインの依存 tsconfck@3.1.6 は任意 peer として typescript ^5.0.0 を宣言しており、本リポジトリの
    //   TypeScript 7 では `pnpm peers check` が unmet peer と報告した（2026-09-28 に確認）。TS 7 との組み合わせが
    //   サポートされる保証がないため、プラグインを使わずこの標準オプションを使う。
    tsconfigPaths: true,
  },
  test: {
    // jsdom: コンポーネントを render して DOM（見出しの role など）を検証するため、Node 上にブラウザ相当の DOM が必要。
    //   Vitest のデフォルトは "node" で document が存在しない。
    environment: "jsdom",
    // include: テストファイルの場所。apps/ の中（対象の隣に置いた *.test.ts(x)）、ルール検査テスト（rule-tests/architecture.test.ts など。
    //   Issue #86 でリポジトリ直下から移した）、scripts/ のテスト（scripts/cloud-session-start.test.ts）。
    //   WHY 既定（**/*.{test,spec}.?(c|m)[jt]s?(x)）にしない: 置き場所を明示し、apps/frontend/.next/ などの生成物や
    //   想定外の場所のテストを拾わないようにする（Issue #68 で apps/ に移したときに範囲を決め直した）。
    include: [
      "apps/**/*.test.{ts,tsx}",
      "rule-tests/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    // apps/e2e/**: Playwright の E2E テスト（apps/e2e/*.spec.ts。workspace パッケージ @repo/e2e。Issue #84 で e2e/ から移した）を
    //   Vitest の対象から外す。上の include（apps/**/*.test.{ts,tsx}）は *.spec.ts を拾わないが、E2E の置き場所に *.test.ts を
    //   置いたときや include を既定に戻したときにも拾わないよう、明示して外す。
    //   Vitest の既定 include（**/*.{test,spec}.?(c|m)[jt]s?(x)）は *.spec.ts も拾うため、除外しないと
    //   pnpm test が Playwright の test() を Vitest 上で読み込み、「test() from an async test.describe()」
    //   のエラーで失敗する（2026-09-28 に実測）。E2E は pnpm test:e2e（Playwright）で実行する。
    //   configDefaults.exclude（node_modules など Vitest の既定の除外）と結合する。exclude を指定すると既定を
    //   置き換えるため、結合しないと node_modules 配下のテストまで拾ってしまう。
    //   .stryker-tmp/**: Stryker（pnpm test:mutation）が作る作業用のサンドボックス。Stryker を途中で止めると
    //   .stryker-tmp/sandbox-*/ にリポジトリのコピー（変異を入れたコードとテスト）が残り、そのままだと pnpm test が
    //   コピーの中のテストまで拾って件数が倍になり、コピーの E2E（"apps/e2e/**" はルート相対なので効かない）で失敗する
    //   （2026-09-28 に reviewer が実測）。
    exclude: [...configDefaults.exclude, "apps/e2e/**", ".stryker-tmp/**"],
    // globalSetup: テストファイルを動かす前に 1 回だけ実行する処理（Vitest のプロセスで動く）。
    //   前の実行が残したテスト用のスキーマ（test_<UUID>）を消し、Postgres に接続できなければ分かりやすいエラーで止める
    //   （Issue #57。WHY は vitest.global-setup.ts と .claude/rules/testing.md）。
    globalSetup: ["./vitest.global-setup.ts"],
    // coverage: 単体テストのカバレッジを計測し、100% に満たなければ失敗させる（Issue #45）。
    //   `vitest run --coverage`（= pnpm test）のときだけ有効。enabled は既定の false のままにし、
    //   pnpm test:unit（vitest run）ではカバレッジを計測せず速く回せるようにしている。
    coverage: {
      // v8: Node 組み込みの V8 カバレッジを使う（Vitest の既定の provider。事前の計装が不要）。
      //   @vitest/coverage-v8 は vitest と同じ版（5.0.1）が peerDependencies で要求される。
      provider: "v8",
      // include: 計測の対象にするファイル。指定しないと「テストが import したファイル」だけが表に出て、
      //   テストが 1 度も触らないファイルが計測から漏れる（Vitest 5.0.1 の型定義「By default only files covered by
      //   tests are included」）。テストを置くべきディレクトリを明示し、触られていないファイルも 0% として数える。
      //   含めないもの（ユーザー判断。Issue #45）:
      //   - apps/frontend/app/: ルーティングだけで、テストを置かない方針（.claude/rules/frontend.md の「app/（ルーティングだけ）」）。
      //     仕様は screen と api ファイルのテストで固定し、app/ の結線は E2E（pnpm test:e2e）で確かめる。
      //   - 設定ファイル（リポジトリ直下の vitest.config.mts など、apps/frontend/next.config.ts、
      //     apps/backend/drizzle.config.ts）: ツールに渡す値を並べるだけで、単体テストで検証する振る舞いを持たない。
      //     apps/frontend 直下の Next の規約ファイル instrumentation.ts / instrumentation-node.ts（起動時の環境変数の検証。Issue #59）も
      //     含めない: next start / next dev の起動でだけ動き、プロセスを終える処理なので、起動時に止まることを実測で確かめている
      //     （.claude/rules/env.md の「環境変数」）。検証の中身は env.ts（計測の対象）のテストで固定している。
      //     同じく直下の Next の規約ファイル proxy.ts（リクエストログ。Issue #80）も含めない: next start / next dev の中で
      //     リクエストごとに Next から呼ばれるだけで、NextRequest の値を渡して 1 行を出力する結線しか持たない。1 行の中身は
      //     apps/frontend/shared/request-log/request-log.ts（計測の対象）のテストで固定し、結線（matcher・stdout・応答ヘッダ）は
      //     E2E（apps/e2e/request-log.spec.ts）で確かめる。include に apps/frontend 直下を入れていないので、exclude は要らない。
      //   - apps/e2e/: Playwright の E2E テストとその設定（apps/e2e/playwright.config.ts）。Vitest では実行しない（上の test.exclude）。
      //   - scripts/ のシェルスクリプト（.sh）: include に入れても、@vitest/coverage-v8 が JS として解析しようとして
      //     失敗し、「Failed to parse ... cloud-session-start.sh. Excluding it from coverage.」とエラーを出して結局外す
      //     （2026-09-28 に実測）。テスト（scripts/*.test.ts）が子プロセスで実行する bash の中身は計測されない。
      //   apps/frontend/shared/（feature をまたぐ部品。最初は request-log/。Issue #80）も対象にする。
      //   apps/backend/ は全体を対象にし、直下の drizzle.config.ts だけを下の exclude で外す（apps/backend/ の中は
      //   drizzle.config.ts 以外すべて 4 層の下にある。rule-tests/architecture.test.ts の backend-placement）。
      include: [
        "apps/frontend/features/**/*.{ts,tsx}",
        "apps/frontend/shared/**/*.{ts,tsx}",
        "apps/backend/**/*.{ts,tsx}",
        "scripts/**/*.ts",
      ],
      // exclude: include のうち計測から外すもの。
      //   - **/*.test.{ts,tsx}: テストそのもの。Vitest もテストの include パターンを常に除外に足すが、意図を明示する。
      //   - **/*.d.ts: 型宣言だけで実行されるコードを持たない。
      //   - apps/backend/*.config.ts: drizzle-kit の設定（上の「設定ファイル」）。
      //   coverageConfigDefaults.exclude（Vitest の既定の除外。5.0.1 では空配列）と結合し、将来の版で既定が増えても
      //   消さないようにする。なお Vitest は設定ファイル（vitest.config.*）・setupFiles・node_modules を、
      //   この設定とは別に常に除外する（5.0.1 の dist/chunks/index.*.js の resolveConfig で確認）。
      exclude: [
        ...coverageConfigDefaults.exclude,
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
        "apps/backend/*.config.ts",
      ],
      // thresholds: 4 指標すべて 100%。1 つでも下回ると vitest（pnpm test、CI の ci ジョブ）が失敗する。
      //   WHY 100: ユーザー判断（Issue #45）。テスト = 仕様なので、テストが通らないコードは仕様のないコードになる。
      //   足りないときはテストを足して埋める。`/* v8 ignore */` などのコメントで計測から逃がさない
      //   （逃がすと 100% の数字だけが残り、仕様の抜けが見えなくなるため）。計測の対象外にするのは上の include の
      //   方針に当てはまるファイルだけで、除外を増やすときは理由をここに書く。
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
      },
      // reporter: text はファイルごとの表（Uncovered Line #s を含む）、text-summary は全体の 4 指標。
      //   どちらも標準出力に出すだけで、既定にある html / clover / json のようなファイル出力はしない
      //   （いまは数値を見るだけで、レポートのファイルを使う予定がないため）。
      //   AI エージェント（Claude Code など）から実行すると、Vitest が text に skipFull: true を自動で付け、100% の
      //   ファイルを表から省く（5.0.1 の resolveConfig の isAgent 分岐）。人間の端末では全ファイルが出る。
      reporter: ["text", "text-summary"],
    },
  },
});

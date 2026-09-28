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
    // tsconfigPaths: tsconfig.json の paths（"@/*"）を Vitest（Vite）側でも解決させるため。
    //   Next.js は tsconfig の paths を自前で解決するが、Vite は既定では解決しない（vite 8.3.1 の型定義で @default false）。
    //   これがないとテスト対象を "@/..." で import したときに解決に失敗する（features/ のテストが "@/features/..."、
    //   backend/ のテストが "@/backend/..." を import しており、解決できなければそれらのテストが失敗することで担保）。
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
    // e2e/**: Playwright の E2E テスト（e2e/*.spec.ts）を Vitest の対象から外す。
    //   Vitest の既定 include（**/*.{test,spec}.?(c|m)[jt]s?(x)）は *.spec.ts も拾うため、除外しないと
    //   pnpm test が Playwright の test() を Vitest 上で読み込み、「test() from an async test.describe()」
    //   のエラーで失敗する（2026-09-28 に実測）。E2E は pnpm test:e2e（Playwright）で実行する。
    //   configDefaults.exclude（node_modules など Vitest の既定の除外）と結合する。exclude を指定すると既定を
    //   置き換えるため、結合しないと node_modules 配下のテストまで拾ってしまう。
    //   .stryker-tmp/**: Stryker（pnpm test:mutation）が作る作業用のサンドボックス。Stryker を途中で止めると
    //   .stryker-tmp/sandbox-*/ にリポジトリのコピー（変異を入れたコードとテスト）が残り、そのままだと pnpm test が
    //   コピーの中のテストまで拾って件数が倍になり、コピーの e2e/（"e2e/**" はルート相対なので効かない）で失敗する
    //   （2026-09-28 に reviewer が実測）。
    exclude: [...configDefaults.exclude, "e2e/**", ".stryker-tmp/**"],
    // globalSetup: テストファイルを動かす前に 1 回だけ実行する処理（Vitest のプロセスで動く）。
    //   前の実行が残したテスト用のスキーマ（test_<UUID>）を消し、Postgres に接続できなければ分かりやすいエラーで止める
    //   （Issue #57。WHY は vitest.global-setup.ts と rules/code/test.md）。
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
      //   - app/: ルーティングだけで、テストを置かない方針（rules/code/architecture.md の「`app/`（ルーティング）」）。
      //     仕様は screen と api ファイルのテストで固定し、app/ の結線は E2E（pnpm test:e2e）で確かめる。
      //   - ルート直下の設定ファイル（next.config.ts / playwright.config.ts など）: ツールに渡す値を並べるだけで、
      //     単体テストで検証する振る舞いを持たない。
      //   - e2e/: Playwright の E2E テストそのもの（Vitest では実行しない。上の test.exclude）。
      //   - scripts/ のシェルスクリプト（.sh）: include に入れても、@vitest/coverage-v8 が JS として解析しようとして
      //     失敗し、「Failed to parse ... cloud-session-start.sh. Excluding it from coverage.」とエラーを出して結局外す
      //     （2026-09-28 に実測）。テスト（scripts/*.test.ts）が子プロセスで実行する bash の中身は計測されない。
      //   shared/ はまだ無い（rules/code/architecture.md）が、作ったときに自動で対象になるよう入れておく。
      include: [
        "features/**/*.{ts,tsx}",
        "backend/**/*.{ts,tsx}",
        "shared/**/*.{ts,tsx}",
        "scripts/**/*.ts",
      ],
      // exclude: include のうち計測から外すもの。
      //   - **/*.test.{ts,tsx}: テストそのもの。Vitest もテストの include パターンを常に除外に足すが、意図を明示する。
      //   - **/*.d.ts: 型宣言だけで実行されるコードを持たない。
      //   coverageConfigDefaults.exclude（Vitest の既定の除外。5.0.1 では空配列）と結合し、将来の版で既定が増えても
      //   消さないようにする。なお Vitest は設定ファイル（vitest.config.*）・setupFiles・node_modules を、
      //   この設定とは別に常に除外する（5.0.1 の dist/chunks/index.*.js の resolveConfig で確認）。
      exclude: [
        ...coverageConfigDefaults.exclude,
        "**/*.test.{ts,tsx}",
        "**/*.d.ts",
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

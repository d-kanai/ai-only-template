// 環境変数の唯一の入口（Issue #59）。アプリ・テスト・ツールの設定ファイルは、process.env を直接読まずにここの env / toolEnv を使う。
// 規則と WHY は .claude/rules/tooling/env.md の「環境変数」。process.env を直接読むと Biome（style/noProcessEnv）と
// rule-tests/architecture.test.ts（規則 env-direct-access）で失敗する。process.env に触ってよいのはこのファイルだけ
// （例外は apps/frontend_customer/instrumentation.ts が Next.js の規約の NEXT_RUNTIME を読む 1 か所だけ）。
// 置き場所は frontend と backend で共通の workspace パッケージ apps/shared（@repo/shared/env。Issue #90 で apps/backend/shared/infra/
// から移した。frontend 直下の instrumentation-node.ts・backend・apps/e2e/・vitest.global-setup.ts が使う。.claude/rules/code/shared.md）。
//
// WHY 1 か所にまとめる: 変数ごとに読む場所が散らばると、既定値や検証（数として使えるか）が場所ごとにずれ、
//   どの変数が必要かを一覧できない。ここで型を付けて検証した値だけを配ると、使う側は string | undefined を扱わずに済む。
// WHY すべて必須で既定値を持たない: 既定値があると、.env の書き忘れや CI の設定漏れが黙って既定値で動き、
//   意図しない DB（手元の開発用 DB など）に接続しても気づけない。値は .env.example に置き、コードには置かない。
// WHY モジュールの読み込み時に検証する（遅延させない）: 欠けた変数に、その変数を初めて使うリクエストの途中で気づくのではなく、
//   next build / next start / vitest / playwright / drizzle-kit の起動時に分かるようにする。

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Env, EnvReader, type ToolEnv } from "./env-reader";

// 設定の型と検証（EnvReader）は ./env-reader.ts（Issue #384 で分けた）。型は今までどおりここ（@repo/shared/env）からも読める。
export type { Env, ToolEnv };

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
  //   pnpm --filter @repo/e2e test（playwright。Issue #84）など。Issue #68 の段階 2）は
  //   パッケージのディレクトリ（apps/frontend_customer・apps/e2e）で
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

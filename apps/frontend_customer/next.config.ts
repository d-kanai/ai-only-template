import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

// create-next-app@16.3.6 が生成した空の設定をベースにしている。
// 最小構成の方針により、必要になるまでデフォルト挙動から変えない（変える時は理由をここに書く）。
const nextConfig: NextConfig = {
  // agentRules: false … next dev が AI エージェント（Claude Code 等）の実行を検知すると、
  //   リポジトリ直下の CLAUDE.md / AGENTS.md に Next.js 用のルールブロックを自動追記する機能（Next 16 のデフォルト true）を止める。
  //   本リポジトリの CLAUDE.md は運用ルールそのもので、ツールに書き換えさせない方針のため無効にしている。
  //   実際に 2026-09-28、この設定なしで pnpm dev を起動したところ CLAUDE.md に
  //   "<!-- BEGIN:nextjs-agent-rules -->" ブロックが追記されたことを確認した
  //   （実装: node_modules/next/dist/server/lib/generate-agent-files.js / start-server.js）。
  agentRules: false,
  // output: "standalone" … next build が .next/standalone/ に、動かすのに要るファイルだけ（トレースした node_modules と
  //   最小のサーバ server.js）を出力する。
  //   WHY: Cloud Run のコンテナ（リポジトリ直下の Dockerfile の runtime ステージ）に、依存をすべて入れずに必要なものだけを
  //   載せるため（イメージが小さく、pnpm も devDependencies も入らない。Issue #137）。
  //   WHY next start（E2E の webServer の pnpm -w start）はそのままにするか: standalone でも next start は
  //   「"next start" does not work with "output: standalone" configuration」の警告を出すだけで、同じ .next/ から起動して動く
  //   （next 16.3.6 の node_modules/next/dist/server/next.js。警告を出して処理を続ける）。E2E は Node の本番サーバの振る舞い
  //   （画面と API）を確かめるもので、server.js に替えると .next/static のコピーなどコンテナと同じ準備を E2E 側にも持つことになる。
  //   コンテナの server.js での起動は、イメージを作って docker run で確かめる（Issue #137 の作業ログ）。
  output: "standalone",
  // outputFileTracingRoot … standalone のトレースの基準ディレクトリをリポジトリ直下（このファイルから 2 つ上）にする。
  //   WHY 直下にするか: 基準の外のファイルは standalone に入らない（next 16.3.6 同梱の
  //   node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/output.md の「Caveats」）。pnpm workspace では
  //   依存の実体（pg・next・react など）がリポジトリ直下の node_modules/.pnpm にあり、apps/frontend_customer の外にある。
  //   （@repo/backend・@repo/shared のソースは Turbopack が .next/server に束ねるので、standalone に apps/backend・apps/shared は
  //   できない。2026-09-30 実測。）
  //   WHY 明示するか: 指定しないと Next が lockfile・workspace の目印を上にたどって自動で決める（node_modules/next/dist/server/
  //   config.js の findRootDirAndLockFiles）。今のリポジトリでは自動でも直下になり、指定の有無で standalone のファイル一覧
  //   （.next を除く 1223 件）は同じだった（2026-09-30 実測）。それでも、置き場所（worktree の入れ子・コンテナの /repo）や
  //   上の階層の lockfile で変わりうる自動の決め方に頼らず、Cloud Run のイメージに入るものを設定で決める。
  //   WHY import.meta.url から求めるか（process.cwd() にしないか）: next build を実行するディレクトリに依らず、このファイルの場所で
  //   決まるようにする。
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
};

export default nextConfig;

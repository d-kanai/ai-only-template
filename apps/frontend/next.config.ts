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
  // serverExternalPackages: ["pg-cloudflare"] … Next のサーバのバンドルに含めず、node_modules から実行時に読む（外部化する）
  //   パッケージ。Cloudflare Workers に載せる（Issue #130。OpenNext の @opennextjs/cloudflare）ために足している。
  //   WHY: pg（8.23.0）の lib/stream.js は、Workers の上では require('pg-cloudflare') で TCP のソケットを作る。pg-cloudflare
  //   （1.4.0）の package.json の exports は、"workerd" 条件で本体（dist/index.js）、"default" 条件で空のファイル
  //   （dist/empty.js）を返す。Next の standalone 出力のトレースは "default" 条件で解決して dist/empty.js しか複製しないため、
  //   opennextjs-cloudflare build が "workerd" 条件で解決し直すと本体が無く、「Could not resolve "pg-cloudflare"」で止まる
  //   （2026-09-29 に実測）。外部化すると、Next はパッケージを丸ごと複製し、OpenNext が workerd 用に解決できる。
  //   対処は OpenNext の公式ドキュメント（https://opennext.js.org/cloudflare/howtos/workerd ）のとおり。
  //   Node の next start（pnpm build / pnpm start / E2E）では pg-cloudflare は "default" 条件の dist/empty.js に解決され、
  //   pg も Workers でなければ pg-cloudflare を読まないので、挙動は変わらない（pnpm build と E2E で確かめた）。
  serverExternalPackages: ["pg-cloudflare"],
};

export default nextConfig;

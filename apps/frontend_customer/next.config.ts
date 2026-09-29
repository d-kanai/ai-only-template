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
};

export default nextConfig;

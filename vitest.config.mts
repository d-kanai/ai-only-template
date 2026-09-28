import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Next.js 公式の Vitest ガイド（https://nextjs.org/docs/app/guides/testing/vitest）の構成をベースにしている。
export default defineConfig({
  // react: テスト対象の .tsx を React の JSX として変換するため。
  plugins: [react()],
  resolve: {
    // tsconfigPaths: tsconfig.json の paths（"@/*"）を Vitest（Vite）側でも解決させるため。
    //   Next.js は tsconfig の paths を自前で解決するが、Vite は既定では解決しない（vite 8.3.1 の型定義で @default false）。
    //   これがないとテスト対象を "@/..." で import したときに解決に失敗する（app/page.test.tsx で担保）。
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
  },
});

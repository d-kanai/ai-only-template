import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tsconfigPaths from "vite-tsconfig-paths";

// Next.js 公式の Vitest ガイド（https://nextjs.org/docs/app/guides/testing/vitest）の構成に合わせている。
export default defineConfig({
  // tsconfigPaths: tsconfig.json の paths（"@/*"）を Vitest（Vite）側でも解決させるため。
  //   Next.js は tsconfig の paths を自前で解決するが、Vite はデフォルトでは解決しない（vite 8.3.1 の resolve.tsconfigPaths は @default false）。
  //   これがないとテスト対象が "@/..." で import したときに解決に失敗する。
  //   なお vite 8.3.1 は実行時に「resolve.tsconfigPaths: true で代替できる」旨のメッセージを出すが、
  //   ここでは Next.js 公式ガイドの手順に合わせてプラグインを使っている（置き換えるかは別途判断）。
  // react: テスト対象の .tsx を React の JSX として変換するため。
  plugins: [tsconfigPaths(), react()],
  test: {
    // jsdom: コンポーネントを render して DOM（見出しの role など）を検証するため、Node 上にブラウザ相当の DOM が必要。
    //   Vitest のデフォルトは "node" で document が存在しない。
    environment: "jsdom",
  },
});

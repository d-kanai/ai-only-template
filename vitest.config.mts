import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

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
    exclude: [...configDefaults.exclude, "e2e/**"],
  },
});

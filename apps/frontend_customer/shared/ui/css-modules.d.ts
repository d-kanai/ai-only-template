// CSS Modules（*.module.css）と CSS の副作用 import の型（Issue #292）。
// WHY ここに書く: Next は next-env.d.ts（.gitignore で管理外、next build / next dev が生成）で同じ型を入れるが、
//   ビルド前の tsc（pnpm typecheck）とエディタには無く、テーマの `import classes from "./x.module.css"` が型エラーになる。
//   CSS を置いてよいのは shared/ui/ の下だけ（rule-tests/design-system.test.ts）なので、型もここに置く。
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare module "*.css";

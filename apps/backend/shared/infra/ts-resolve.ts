import {
  type RegisterHooksOptions,
  type ResolveHookSync,
  registerHooks,
} from "node:module";

// node で backend の TypeScript を直接動かすとき（pnpm db:backfill。Issue #194）の resolve フック。
// WHY 要るか: Node 24 は .ts を型の消去だけで直接実行できるが、ESM の解決は拡張子を補わない。apps/shared のソース
//   （logger.ts の import "./log-event" など）は拡張子を書かない相対パスで import しており（Next・Vitest・tsc の bundler 解決に
//   合わせた書き方）、そのままでは ERR_MODULE_NOT_FOUND で止まる（2026-10-01 に Node 24.21.0 で実測）。
// WHY Node の registerHooks（同期のフック）にする: 依存（tsx など）を足さずに済み、同じスレッドで動く（module.register の
//   非同期のフックは別スレッドで動き、初期化の待ちが要る）。
// 限界: registerHooks は Node 24 で実験的（@types/node 24.13.6 の @experimental）。Node の版を上げて動かなくなったら、
//   backfill.test.ts の「pnpm db:backfill の script を子プロセスで実行する」テストが失敗する。

// 既定の解決で見つからない拡張子の無い相対パスに .ts を足して解決し直す。
// WHY 相対パスだけ: パッケージ名は exports で解決するもので、.ts を足すと別のファイルを指しうる。
// WHY 見つからないとき（ERR_MODULE_NOT_FOUND）だけ: ほかの例外（specifier の形の誤りなど）を隠さない。
// WHY .ts でも見つからなければ元の例外を投げる: 書いた import の名前で見つからないと分かるようにする。
export const resolveWithTsExtension: ResolveHookSync = (
  specifier,
  context,
  nextResolve,
) => {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (!isRelative(specifier) || !isModuleNotFound(error)) {
      throw error;
    }
    try {
      return nextResolve(`${specifier}.ts`, context);
    } catch {
      throw error;
    }
  }
};

function isRelative(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function isModuleNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
  );
}

// resolveWithTsExtension をこのプロセスの resolve フックとして登録する。これより後の import に効く。
// WHY register を引数で受け取る: テストで登録するものを確かめ、Vitest のプロセスにフックを登録しないため。
export function registerTsResolve(
  register: (options: RegisterHooksOptions) => unknown = registerHooks,
): void {
  register({ resolve: resolveWithTsExtension });
}

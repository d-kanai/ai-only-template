// @vitest-environment node
import type { ResolveFnOutput, ResolveHookContext } from "node:module";
import { describe, expect, test, vi } from "vitest";
import { registerTsResolve, resolveWithTsExtension } from "./ts-resolve";

// node で backend の TypeScript を直接動かすときの resolve フック（Issue #194。pnpm db:backfill が使う）の仕様。
// WHY 要るか: apps/shared のソース（logger.ts の import "./log-event" など）は拡張子を書かない相対パスで import しており、
//   Node の ESM の解決は拡張子を補わないので ERR_MODULE_NOT_FOUND になる（2026-10-01 に Node 24.21.0 で実測）。

const CONTEXT: ResolveHookContext = {
  conditions: ["node", "import"],
  importAttributes: {},
  parentURL: "file:///repo/apps/shared/logger.ts",
};

function notFound(specifier: string): Error {
  return Object.assign(new Error(`Cannot find module '${specifier}'`), {
    code: "ERR_MODULE_NOT_FOUND",
  });
}

// 解決できる specifier の一覧を持つ nextResolve（Node の既定の解決の代わり）。一覧に無ければ ERR_MODULE_NOT_FOUND を投げる。
function nextResolveFor(resolvable: Record<string, string>) {
  return vi.fn((specifier: string): ResolveFnOutput => {
    const url = resolvable[specifier];
    if (url === undefined) {
      throw notFound(specifier);
    }
    return { url };
  });
}

describe("resolveWithTsExtension", () => {
  test("既定の解決で見つかる specifier は、そのまま返し、.ts を足して探し直さない", () => {
    const next = nextResolveFor({ "./now.ts": "file:///repo/now.ts" });

    expect(resolveWithTsExtension("./now.ts", CONTEXT, next)).toEqual({
      url: "file:///repo/now.ts",
    });
    expect(next.mock.calls).toEqual([["./now.ts", CONTEXT]]);
  });

  test("拡張子の無い相対パスが見つからなければ、.ts を足して同じ context で解決し直す", () => {
    const next = nextResolveFor({
      "./log-event.ts": "file:///repo/log-event.ts",
    });

    expect(resolveWithTsExtension("./log-event", CONTEXT, next)).toEqual({
      url: "file:///repo/log-event.ts",
    });
    expect(next.mock.calls).toEqual([
      ["./log-event", CONTEXT],
      ["./log-event.ts", CONTEXT],
    ]);
  });

  test("../ で始まる相対パスも同じに .ts を足す", () => {
    const next = nextResolveFor({
      "../infra/database.ts": "file:///repo/d.ts",
    });

    expect(resolveWithTsExtension("../infra/database", CONTEXT, next)).toEqual({
      url: "file:///repo/d.ts",
    });
  });

  // WHY パッケージ名（相対でない specifier）は探し直さない: パッケージは exports で解決するもので、.ts を足すと
  //   別のファイルを指しうる（pg.ts のようなファイルがあっても指してはいけない）。
  test("相対でない specifier（パッケージ名）が見つからなければ、探し直さずに元の例外を投げる", () => {
    const next = nextResolveFor({ "missing.ts": "file:///repo/missing.ts" });

    expect(() => resolveWithTsExtension("missing", CONTEXT, next)).toThrow(
      notFound("missing"),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  // WHY 元の例外を投げる（.ts で探し直したときの例外にしない）: 書いた import の名前（./missing）で見つからないと分かるようにする。
  test(".ts を足しても見つからなければ、元の specifier の例外を投げる", () => {
    const next = nextResolveFor({});

    expect(() => resolveWithTsExtension("./missing", CONTEXT, next)).toThrow(
      notFound("./missing"),
    );
    expect(next).toHaveBeenCalledTimes(2);
  });

  test("見つからない以外の例外（ERR_MODULE_NOT_FOUND でない）は、探し直さずにそのまま投げる", () => {
    const next = vi.fn((): ResolveFnOutput => {
      throw Object.assign(new Error("bad specifier"), {
        code: "ERR_INVALID_MODULE_SPECIFIER",
      });
    });

    expect(() => resolveWithTsExtension("./x", CONTEXT, next)).toThrow(
      Object.assign(new Error("bad specifier"), {
        code: "ERR_INVALID_MODULE_SPECIFIER",
      }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  // WHY Error でない値も見る: throw は何でも投げられる。code が同じでも Error でなければ Node の解決の失敗ではない。
  test("Error でない値が投げられたら（code が ERR_MODULE_NOT_FOUND でも）、探し直さずにそのまま投げる", () => {
    const thrown: unknown = { code: "ERR_MODULE_NOT_FOUND" };
    const next = vi.fn((): ResolveFnOutput => {
      throw thrown;
    });

    expect(() => resolveWithTsExtension("./x", CONTEXT, next)).toThrow(
      expect.objectContaining({ code: "ERR_MODULE_NOT_FOUND" }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("registerTsResolve", () => {
  test("resolveWithTsExtension を resolve フックとして登録する", () => {
    const register = vi.fn();

    registerTsResolve(register);

    expect(register.mock.calls).toEqual([
      [{ resolve: resolveWithTsExtension }],
    ]);
  });
});

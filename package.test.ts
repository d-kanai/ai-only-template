import { describe, expect, it } from "vitest";
import pkg from "./package.json";

// 依存の版は package.json 上でも完全固定する（rules/code/dependencies.md）。
// lockfile だけに頼ると、`pnpm update` や lockfile の再生成で範囲内の別の版に解決し直されうるため、
// package.json 側でも範囲指定（^ ~ >= など）を禁止し、このテストで機械的に担保する。
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

describe("package.json", () => {
  it.each([
    ["dependencies", pkg.dependencies],
    ["devDependencies", pkg.devDependencies],
  ] as const)("%s はすべて完全固定（x.y.z）で書かれている", (_field, deps) => {
    // 失敗時にどのパッケージがどの値かが出力に出るよう、条件を満たさない組だけを集めて空配列と比較する。
    const notPinned = Object.entries(deps).filter(
      ([, version]) => !EXACT_VERSION.test(version),
    );
    expect(notPinned).toEqual([]);
  });
});

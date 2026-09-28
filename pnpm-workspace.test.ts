// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストはファイルを読むだけで
//   DOM を使わない。Node 環境で動かし、jsdom の初期化コストと無関係な差異を避ける。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// yaml パーサは依存に加えない。検査したいのはトップレベルの 2 行だけで、行の正規表現で十分なため
// （依存を増やすとサプライチェーンの対象も増える）。行頭一致なのでコメント内の記述には反応しない。
const workspaceYaml = readFileSync(
  join(import.meta.dirname, "pnpm-workspace.yaml"),
  "utf8",
);

describe("pnpm-workspace.yaml のサプライチェーン保護設定", () => {
  // WHY 5 日（7200 分）: 悪意あるリリースは公開から数日以内に検知・削除されることが多く、1 日では短い。
  //   一方、開発機の safe-chain と同じ 14 日に揃えると Next.js などの更新に 2 週間遅れで追随することになるため、
  //   ユーザーの判断で 5 日にした（Issue #32）。pnpm 側の設定は safe-chain の有無（クラウドセッション・CI）に
  //   関係なく効く防御なので、値が意図せず下がっていないことをテストで担保する。
  it("minimumReleaseAge は 7200 分（5 日）", () => {
    expect(workspaceYaml).toMatch(/^minimumReleaseAge: 7200$/m);
  });

  // WHY strict: 非 strict だと条件を満たす版がないときに古い版へ黙ってフォールバックし、
  //   lockfile の内容が意図しない版に変わりうる。失敗させて人間・AI に気づかせる。
  it("minimumReleaseAgeStrict は true", () => {
    expect(workspaceYaml).toMatch(/^minimumReleaseAgeStrict: true$/m);
  });
});

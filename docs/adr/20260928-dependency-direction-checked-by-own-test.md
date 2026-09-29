# 依存の向きは Biome や dependency-cruiser ではなく、自前のテスト（rule-tests/architecture.test.ts）で検査する

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #47 / PR #48 / `.claude/rules/architecture-check.md` / `rule-tests/architecture.test.ts`

## 背景
ディレクトリ構成（20260928-feature-based-directory-and-ddd-backend.md）の依存の向きは文書にしか無く、違反しても何も止まらなかった。画面側から API 側への参照は `import type` だけを許す、のように型と値を区別する規則がある。

## 決定
- import / re-export を正規表現で抽出して参照先を解決し、規則ごとに判定するテストを自前で書く（依存を足さない）。`pnpm test`（= CI）で止める。
- 1 規則 = 1 テストにし、規則ごとの判定例と、一時ディレクトリの fixture による must pass / must reject を持つ（20260928-rule-check-tests-must-pass-and-must-reject.md）。

## 理由
- Biome の `noRestrictedImports`（2.5.13）は多くの規則を表せたが、`import type` だけを許すオプションが無く、型の参照も違反になった（https://github.com/biomejs/biome/discussions/7337 は未実装）。「自分以外の feature」を一般的に書けず feature ごとに override が要り、同じファイルに当たる override は後勝ちで置き換わる（2026-09-28 の work-logs「依存の向きの機械的検査を Vitest の自前テストで入れる（Issue #47）」）。
- dependency-cruiser 18.4.0 は `supportedTranspilers.typescript` が 7.0.0 未満で、TypeScript 7.0.2 が範囲外（同日の work-logs。20260928-typescript-7.md）。

## 採用しなかった案
- Biome の `noRestrictedImports`: 型だけの参照を許せない。feature を足すたびに `biome.json` を直すことになる。
- dependency-cruiser: TS 7 に対応していない。

## 影響
- 良い点: 型と値の区別、feature を一般化した規則、`exports` との突き合わせなど、必要な規則を書ける。
- 悪い点: 抽出は正規表現なので、式の流れを追う書き方は拾えない（限界は `.claude/rules/architecture-check.md`）。pre-commit では止まらず、`pnpm test` と CI で止まる。
- 見直す条件: dependency-cruiser が TS 7 に対応したら再検討する。

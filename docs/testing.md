# テストのルールの根拠になった実例

規則は `.claude/rules/testing.md`、ルール検査テストの手順はスキル `rule-check-test`。ここは読み込まれない記録（Issue #64 で旧ルールファイルから移した）。

## 見逃しや確認の有効性が実際に示された例
- must reject の不足で規則が検査されていなかった例（Issue #47、ブランチ `chore/47-dependency-direction-check` のコミット「reviewer 指摘: infra の規則追加、…」）: 依存の向きの検査（`architecture.test.ts`）で、reviewer の検証により、構成ルールにある規則のうち infra 層、画面側 `shared/` からの backend 参照、presentation → domain の型限定などがテストに無く、規則の判定そのものを固定するテストも無いことが分かった。追加後、infra の判定（`isViolation`）を常に false にすると違反例 6 件が失敗することを確認した。
- 規則ごとの fault injection の例（Issue #47、同ブランチのコミット「依存の向きを architecture.test.ts で機械的に検査する」）: 規則ごとに違反ファイルを一時的に置いて（13 ケース）その規則だけが失敗すること、抽出関数を空にすると抽出の自己テスト 9 件が失敗することを worker が確認した。
- 書き換えで検証が消えていた例（Issue #36 / PR #38、コミット「reviewer 指摘: 既存インストール検出のテストを --install-only に追加し、…」と `logs/2026-09-28.md` の「SessionStart フックの導入を一時停止する PR #38 / Issue #36 を、#37 に置き換わったためクローズ」）: フックの経路を書き換えた結果、既存インストールの検出を確かめるテストが消え、検出を壊しても緑のままになっていた。reviewer の変異（`ensure_node` の検出を `NODE_DIR=""` に変える）で見つかり、テストを 2 件追加して同じ変異で 2 件失敗することを確認した（PR #38 はブランチごと破棄）。
- ゲートの must reject / must pass を実際のコミットで確かめた例（Issue #26 / PR #33、コミット「Biome と Lefthook を導入し、…」）: reviewer が 6 種の変異でテストが失敗することを確認し、使い捨てリポジトリで違反を含むコミットが拒否され、`.md` だけのコミットは通ることを確かめた。
- 変異でテストの強さを確かめた例（Issue #23 / PR #30、コミット「クラウドセッション用に Node / pnpm を用意する setup script と SessionStart フックを追加」）: reviewer が 8 種の変異でテストが失敗することを確認した。
- ゲートが実際に止まることを先に確かめた例（Issue #45、コミット「単体テストのカバレッジゲートを 100% にし、不足分のテストを追加」）: しきい値だけを入れた状態で `pnpm test` がしきい値未達（lines 98.78% など）で失敗することを確認してからテストを足し、足したテストが分岐を通すだけでないことを、分岐を 1 つずつ壊して失敗することで確認した（worker）。
- 型チェックが実際に動いていることを確かめた例（Issue #17、`logs/2026-09-28.md` の「TypeScript を 7.0.2 に更新」）: 型エラーのファイルを一時的に置くと `next build` が `Failed to type check` で exit 1 になることを worker と reviewer が確認した。同じく「`vite-tsconfig-paths` を削除し …」では、`resolve.tsconfigPaths` を外すと import の解決エラーでテストが失敗することを確認した。
- must pass と must reject を揃えた例（Issue #50）: `package.test.ts` / `pnpm-workspace.test.ts` は今のファイルに違反が無いこと（must pass の 1 例）しか見ておらず、判定が常に「違反なし」を返しても緑のままだった。判定を関数に切り出し、架空の入力で許可・拒否を固定した。`lint.test.ts` の代表 3 ルールにも、許可される書き方が 0 で終わる must pass を足した。

## 実測
- Vitest 5.0.1 の `rejects.toThrow("文字列")` / `rejects.toThrowError("文字列")` は、reject された値が `undefined` だと文字列を照合せずに通る。同期の `expect(fn).toThrow("文字列")` も `throw undefined` で通る（2026-09-28。Issue #55）。
- `mockResolvedValue` は即時に resolve するため、「新しい応答の後に古い応答が届く」順序を再現できない（`deferred()` を使う理由）。
- Playwright: クラウド VM の `/opt/pw-browsers` の Chromium はビルド 1194 で、`@playwright/test@1.63.0` の要求（1243）と一致しない。変数なしでは `/opt/pw-browsers/chromium_headless_shell-1243/...` を探して `Executable doesn't exist` で失敗し、`PLAYWRIGHT_CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium`（Chromium 141）で通った（2026-09-28）。
- Vitest の既定 include は `*.spec.ts` も拾うため、`e2e/**` を除外しないと Playwright の `test()` を Vitest 上で読み込んで失敗する（`vitest.config.mts` のコメント）。

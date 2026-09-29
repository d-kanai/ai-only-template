---
name: rule-check-test
description: ルール検査テスト（architecture / lint / package / pnpm-workspace / typecheck / cloud-session-start など、規則や設定が効いていることを検査するテスト）とゲート（カバレッジ・フック・CI）を書く・変えるときの手順。must pass / must reject の例、fixture、fault injection の 5 段階。
---

# rule-check-test（ルール検査テストと fault injection）

`context: fork` を付けない理由: worker / reviewer の定義の `skills:` で事前読み込みし、作業中の文脈のまま手順として使うため。
ルール検査テスト = コードの振る舞いではなく「規則や設定が効いていること」を検査するテスト。違反を見逃す（false negative）と存在する意味が無いので、以下を必須にする。一覧は `.claude/rules/testing.md`、依存の向きの規則は `.claude/rules/architecture-check.md`。
テスト以外のゲート（カバレッジのしきい値、pre-commit、CI の required status check、型チェック、権限・フック）も同じ手順で確かめる。

## 1. must pass と must reject を両方書く
1. 規則ごとに、許可される例が通る（must pass）テストと、違反が検出される（must reject）テストを書く。WHY: must reject だけでは「何でも違反」（誤検知）を、must pass だけでは「何も違反にしない」（常に緑）を検出できない。
   - 「今のリポジトリで違反 0 件」は must pass の 1 例にすぎない。must reject を必ず別に持つ。
2. 判定を関数に切り出し、架空の入力（版の文字列・YAML・コマンド・import の参照）で許可・拒否を固定する。同じ関数で実ファイルも検査する。
3. must reject は取り違えやすい境界を網羅する:
   - import: alias（`@/`・`@repo/backend/`）と相対パス、値の import と `import type` / inline の `type`、`index` と深いパス、自 feature と他 feature、`export ... from` と dynamic `import()`、複数行、拡張子（`.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs`）、パッケージとサブパス（`next` と `next/link`）、前方一致の境界（`shared-x` など）。コメント・文字列の中の import 風の文字列は must pass 側。
   - 版: `^` `~` `>=` `*` `x` `latest` `workspace:^` `npm:` の別名、空文字、プレリリース、ビルドメタ（`workspace:*` だけ許可）。
   - 設定値: 値の違い、キーが無い、コメントアウトされた行、同名のキーがネストの中にある。
   - コマンド: 失敗を打ち消すつなぎ（`|| true`・`; exit 0`・改行・`| cat`・末尾の `&`）、効果を消すフラグ。
   - lint / フック: 違反を単独で含むファイル（他の違反の巻き添えでないことを示す）、違反のないファイル、対象外のファイル（`.md` だけのコミットなど）。
4. 検査対象を列挙する処理（glob・走査）が空を返したら失敗させる。WHY: 対象 0 件なら違反も 0 件で常に緑になる。

## 2. 実ファイルの fixture で end-to-end に通す
1. 一時ディレクトリ（`mkdtempSync(join(tmpdir(), "<name>-"))`、`afterAll` で消す）に実ファイルを置き、本番と同じ列挙 → 抽出 → 判定 → 違反の一覧に通す。WHY: 判定が正しくても、抽出（列挙・読み取り・パスの解決）が漏れれば見逃す。
2. 検出された違反の集合は `toEqual` で丸ごと比較する（`toContain` や件数だけにしない）。WHY: 見逃しも余分な検出も失敗にする。
3. 規則を足す・変えるときは、例と fixture も同じ変更で更新する。ルール文書に規則を書いたら、対応するテストがあるかを突き合わせる。

## 3. fault injection（書く・変えるたびに必須）
テストが緑であることは、検査が効いている証拠にならない。
既定は **最小セット**（下の 1 と、2 の「常に違反なし」「常に違反」の 3 つ）。2 の「列挙を空」「設定を戻す」と、1 の境界の網羅（数十件の変異）は、**新しいルール検査テストやゲートを作るとき**だけ行う。WHY: 見逃しの検出に効くのは主に「常に許可」「常に拒否」で、数十件の変異は worker の消費の大半を占めた（ADR `docs/adr/workflow/20260929-save-usage-limit.md`）。
1. **規則を破る**: 違反するコード・ファイル・設定を 1 件置き、**そのテストだけが**失敗することを確かめる。規則が複数なら 1 規則ずつ（最小セットでは変えた規則だけ）。無関係なテストも落ちるなら、規則ごとの判定が分離できていない。
2. **検査を壊す**:
   - 判定を常に「違反なし」（`return false`）→ must reject が落ちる。
   - 判定を常に「違反」（`return true`）→ must pass が落ちる。
   - （新規のときだけ）抽出・列挙を空（`return []`）→ 落ちる。
   - （新規のときだけ）設定を戻す（`--error-on-warnings` を外す、しきい値を下げる、フックからコマンドを消す）→ 落ちる。
3. **元に戻す**: `git status --short` と `git diff` に何も残っていない（lockfile を含む）ことを確かめ、もう一度テストを通す。
   - 一時ファイルはできるだけリポジトリの外（scratchpad・OS の一時ディレクトリ）に置く。リポジトリ内に置いたらパスを控えて消し、`git status` で確かめる。
   - worktree では `grep <worktree名> .git/hooks/pre-commit` が 0 件であることも確かめる。
4. **記録する**: 何を壊し（ファイル・行・どう変えたか）、どのテストが何件失敗し、戻して通ったかを、worker は報告の「検証」に、オーケストレータは PR の「検証内容」に書く。
5. **reviewer も独立に行う**（ロジックのある変更のとき）: worker の報告を鵜呑みにせず、渡された差分と観点に絞って、別の壊し方を最小セットで行う（ファイルを変更しないので、クローンや scratchpad のコピーで）。

## 実行のしかた
- fault injection 中は `pnpm exec vitest` ではなく `./node_modules/.bin/vitest run <テストファイル>` を直接呼ぶ。WHY: `package.json` の依存の版を触った後（戻した直後も）の `pnpm exec` は install を走らせ、lockfile と共有フック `.git/hooks/pre-commit` を書き換える（LEARNINGS.md）。依存の版の変異は一時ディレクトリの fixture で行う。
- 他の worker と並列に作業しているときは `STRYKER_MUTATOR_WORKER=1 ./node_modules/.bin/vitest run <対象ファイル>` のように対象を絞り、この変数を付ける。WHY: Vitest の globalSetup が `test_` で始まるスキーマを消すので、並行する他の実行の使用中のスキーマを消してしまう。この変数があると消さない（`vitest.global-setup.ts`）。
- 完了前には通常どおり `pnpm test`（カバレッジ込み）を通す（並列作業が終わってから）。
- 失敗の検証は `rejects.toEqual(new Error("..."))`。`rejects.toThrow("文字列")` は reject 値が `undefined` だと通る（Vitest 5.0.1）。

## 過去の例（根拠）
- Issue #47: reviewer の検証で、文書にある規則の一部（infra 層など）がテストに無いと分かった。追加後、判定を常に false にすると違反例 6 件が失敗した。
- Issue #36 / PR #38: 書き換えで既存インストール検出のテストが消え、検出を壊しても緑だった（reviewer の変異で発見）。
- Issue #26 / PR #33、#23 / PR #30、#45、#17: reviewer / worker が変異・ゲートの実測で検査が効くことを確かめた（詳細は 2026-09-28 の work-logs と各 PR）。

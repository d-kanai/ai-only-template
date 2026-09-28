# テストコードルール

テストは仕様であり、仕様が黙って外れたり、壊れたコードを見逃したりしない状態を保つ。とくに「規則や設定が効いていること」を検査するテスト（下の「ルール検査テスト」）は、違反を見逃す（false negative）と存在する意味がないため、must pass / must reject の両方の例と、fault injection による確認を必須にする。

## 基本方針
- テスト = 仕様（`CLAUDE.md` の「2. Test Driven」）。テストを先に書き、**失敗することを確認してから**実装する。
  - 理由: 先に失敗を見ておかないと、そのテストが実装の有無に関係なく通る（何も検査していない）ことに気づけない。
- テスト名は日本語の仕様文で書く（「〜すると〜になる」「〜のときは〜しない」）。例: 「todoId が変わると、新しい todoId の Todo を取得し直す」、「201 と作成した TodoDto を返し、保存される」。
  - 理由: テスト一覧がそのまま仕様の一覧として読めるようにする。失敗したときに、どの仕様が破れたかがテスト名で分かる。
- 分岐を通すだけのテストにしない。その分岐で起きること（返り値・状態・呼び出し・出力）を検証する。
  - 理由: 実行しただけで何も検証しないテストでもカバレッジは上がる。数字だけが 100% になり、分岐の中身を壊しても気づけない。
- `it.skip` / `it.only` などを残さない。Biome の `noSkippedTests`（`biome.json` で error）と `noFocusedTests`（test domain の recommended、既定 severity は warn で `--error-on-warnings` により失敗。`biome explain noFocusedTests` で確認）で検出する（`rules/code/lint.md`）。
  - 理由: skip は仕様を黙って外し、only はそれ以外のテストを黙って止める。どちらもテストは緑のまま検査範囲が減る。
- カバレッジは 100%（`rules/code/architecture.md` の「カバレッジ」）。`/* v8 ignore */` などで計測から逃がさない。

## 置き方と環境
- `rules/code/architecture.md` の「テストの置き方」に従う（置き場所、`// @vitest-environment node`、層ごとのテスト方法）。ここには重複して書かない。

## テストダブル
- backend（`backend/**`）: InMemory リポジトリ（`InMemoryTodoRepository`。本番でも使う実装）を `createTodoContainer` に渡して組み立てる。モックは最小限にする。
  - 理由: モックは「こう呼ばれるはず」という前提をテストに書き込むため、実装と前提がずれても緑のままになる。本物の実装を通せば、層をまたいだ振る舞い（command で保存したものが query で読めるなど）まで検証できる。
  - 例外: InMemory では起こせない失敗の経路は、その経路に必要な分だけ差し替える。例: `backend/todo/presentation/list-todos.api.test.ts` は 500 の経路のために、常に reject する `TodoRepository`（`failingRepository`）を `createTodoContainer` に渡し、`console.error` を `vi.spyOn` で抑制しつつ呼ばれたことを検証する。
- 画面側の hook / screen（`features/**/screens/**`）: `vi.mock("@/features/todo/api/todo-api")` で `api/` を差し替え、`vi.mocked(listTodos).mockResolvedValue(...)` で応答を与える。
  - 理由: 画面側と API 側の境界は `api/` の 1 ファイル（`rules/code/architecture.md` の「画面側とサーバ側の境界」）なので、そこで切るとテストが HTTP やサーバの状態に依存しない。
- `api/`（`features/**/api/*.ts`）: `vi.stubGlobal("fetch", vi.fn<typeof fetch>())` で `fetch` を差し替え、送った URL・メソッド・本文と、応答の扱いを検証する（`features/todo/api/todo-api.test.ts`）。
- 非同期の順序（古い応答が後から届く、画面を離れた後に失敗が届く、など）は、テストから任意のタイミングで resolve できる Promise（`deferred()`）で順序を作って検証する（`features/todo/screens/todo-screen/todo-screen.hook.test.ts`、`features/todo/screens/todo-detail-screen/todo-detail-screen.hook.test.ts`）。
  - 理由: `mockResolvedValue` は即時に resolve するため、「新しい応答の後に古い応答が届く」順序を再現できない。タイマー（`setTimeout` での遅延）に頼ると順序が実行環境の速さに左右される。
  - `deferred()` は各テストファイルの中に定義している（共通化はしていない）。

## ルール検査テスト
コード（Todo の振る舞いなど）ではなく、「規則や設定が効いていること」を検査するテスト。例:

| テスト | 検査する規則・設定 |
| --- | --- |
| `lint.test.ts` | Biome の違反が `--error-on-warnings` で失敗になること、`pnpm lint` / `pnpm check` / pre-commit の引数（`rules/code/lint.md`） |
| `package.test.ts` | `package.json` の版が完全固定であること（`rules/code/dependencies.md`） |
| `pnpm-workspace.test.ts` | `minimumReleaseAge` などのサプライチェーン保護の値（`rules/code/dependencies.md`） |
| `scripts/cloud-session-start.test.ts` | クラウドセッションのスクリプトが `.tool-versions` どおりの版を、検証付きで入れること（`rules/code/env.md`） |
| `architecture.test.ts`（Issue #47 で追加） | 依存の向き（`rules/code/architecture.md` の「依存の向き（全体）」） |

テスト以外のゲート（カバレッジのしきい値、pre-commit のフック、CI の required status check、型チェック）も、「違反があれば止まる」ことを検査する仕組みなので、下の「fault injection」は同じように行う。

### must pass と must reject を両方入れる
- 規則ごとに、**許可される例が通る（must pass）**ことと、**違反が検出される（must reject）**ことの両方をテストにする。
  - 理由: must reject だけだと「何でも違反にする」壊れ方（誤検知でリポジトリ全体が落ちる。直すために規則を緩めたくなる）を、must pass だけだと「何も違反にしない」壊れ方（常に緑）を検出できない。後者は緑のまま気づかれないので、とくに危ない。
  - 「今のリポジトリで違反が 0 件」（`expect(violations).toEqual([])`）だけでは must pass の 1 例にすぎない。判定が常に「違反なし」を返しても通るため、must reject の例を必ず別に持つ。
  - 既存の例: `lint.test.ts` は「未使用変数と == を含むファイルは非 0 で終わる」（must reject）と「違反のないファイルは 0 で終わる」（must pass）を両方持つ。
- must reject は、その検査が取り違えやすい境界のケースを網羅する。検査の種類ごとに列挙し、許可か違反かを決めてテストで固定する。
  - import の検査: alias（`@/...`）と相対パス（`../...`）、値の import と `import type` / inline の `type`、`index` と深いパス、自 feature と他 feature、`export ... from`（re-export）と dynamic `import()`、複数行にまたがる import、拡張子の違い（`.ts` / `.tsx` / `.js` / `.jsx`）、パッケージとそのサブパス（`next` と `next/link`）。コメントや文字列の中の import の例示は must pass（誤検知しない）側に入れる。
  - 版の検査: `^` / `~` / `>=` / `*` / `x` / `latest` / `workspace:` / `npm:` の別名、プレリリース（`1.2.3-beta.1`）など。
  - 設定値の検査: 値の違い、コメントアウトされた行、同名のキーがネストの中にある場合。
  - lint / フックの検査: 違反を単独で含むファイル（他の違反に巻き込まれて落ちているのではないことを示す）、違反のないファイル、対象外のファイル（`.md` のみのコミットなど）。
- 検査の対象を列挙する処理（glob、ディレクトリの走査など）が空を返したら失敗させる。
  - 理由: 対象が 0 件なら違反も 0 件になり、常に緑になる。パスの変更や glob の書き間違いで起きやすい。

### 判定だけでなく、実ファイルで end-to-end に通す
- 判定関数（「この参照は違反か」など）の単体テストに加えて、実ファイルを一時ディレクトリに置き、抽出 → 判定 → 違反の一覧までを通す fixture を持つ。
  - 一時ディレクトリは `mkdtempSync(join(tmpdir(), "<name>-"))` で作り、`afterAll` で消す（`lint.test.ts` と同じ）。リポジトリの中に置くと、テストが途中で落ちたときに作業ツリーに残る。
  - 検出される違反の集合は `toEqual` で丸ごと比較する（`toContain` や件数だけの比較にしない）。
  - 理由: 判定が正しくても、抽出（ファイルの列挙・import の読み取り・パスの解決）が漏れれば違反は見逃される。丸ごと比較すれば、見逃し（期待した違反が無い）も余分な検出（誤検知）も失敗になる。
- 規則を足す・変えるときは、must pass / must reject の例と fixture も同じ変更で更新する。ルール文書（`rules/**/*.md`）に規則を書いたら、対応するテストがあるかを突き合わせる。

### fault injection（確認プロセスで必須）
ルール検査テストを書く・変えるたびに、次を行う。テストが緑であることは、検査が効いていることの証拠にならないため。

1. **規則を破る**: 規則に違反するコード・ファイル・設定を一時的に置き、**そのテストだけが**失敗することを確認する（関係のない規則のテストが巻き添えで落ちるなら、規則ごとの判定が分離できていない）。規則が複数あれば 1 規則ずつ行う。
2. **検査を壊す**: 検査側を意図的に壊し、テストが失敗することを確認する。
   - 判定を常に「違反なし」にする（`return false`）→ must reject のテストが落ちること（見逃しの検出）。
   - 判定を常に「違反」にする（`return true`）→ must pass のテストが落ちること（誤検知の検出）。
   - 抽出や列挙を空にする（`return []`）→ 落ちること（対象 0 件で緑にならないこと）。
   - 設定を戻す（例: `--error-on-warnings` を外す、しきい値を下げる、フックからコマンドを消す）→ 落ちること。
3. **元に戻す**: 確認が終わったら必ず元に戻し、`git status --short` と `git diff` に何も残っていないことを確かめてから、もう一度テストを通す。
   - 一時ファイルはできるだけリポジトリの外（scratchpad や OS の一時ディレクトリ）に置く。リポジトリを走査する検査のためにリポジトリ内に置く必要があるときは、置いたパスを控えておき、消したことを `git status` で確かめる。
4. **記録する**: 何を壊し（どのファイルのどの行を、どう変えたか）、どのテストが何件失敗し、戻して通ったかを、worker は報告に、オーケストレータは PR の「検証内容」に書く。
5. **reviewer も独立に行う**: reviewer は worker の報告を鵜呑みにせず、worker と別の壊し方を含めて自分で fault injection を行い、見逃しを探す（reviewer はファイルを変更しないため、クローンや scratchpad のコピーで行う）。

## 通常のテストでの確認（ミューテーション）
- ルール検査テスト以外でも、カバレッジを埋めるためにテストを足したときや、既存のテストを書き換えたときは、「そのテストが守っているコードを壊すと落ちる」ことを 1 度は確かめる（分岐の条件を反転する、戻り値を変える、呼び出しを消す、など）。確かめたら元に戻す。
  - 理由: テストを足すとカバレッジは上がるが、検証が弱い（呼び出すだけ・値を見ていない）と、コードを壊しても緑のままになる。書き換えで既存の検証が消えることもある（下の Issue #36 の例）。

## E2E テスト
- `rules/code/architecture.md` の「E2E テスト（Playwright）」に従う。ここには重複して書かない。

## 一次情報 / 実測（このリポジトリの実例）
上のルールは、次の実例で見逃しや確認の有効性が実際に示されたことを根拠にしている。

- must reject の不足で規則が検査されていなかった例（Issue #47、`chore/47-dependency-direction-check` のコミット「reviewer 指摘: infra の規則追加、…」）: 依存の向きの検査（`architecture.test.ts`）で、reviewer の検証により `architecture.md` にある規則のうち infra 層、画面側 `shared/` からの backend 参照、presentation → domain の型限定などがテストに無く、規則の判定そのものを固定するテストも無いことが分かった。追加後、infra の判定（`isViolation`）を常に false にすると違反例 6 件が失敗することを確認している。
- 規則ごとの fault injection の例（Issue #47、同ブランチのコミット「依存の向きを architecture.test.ts で機械的に検査する」）: 規則ごとに違反ファイルを一時的に置いて（13 ケース）その規則だけが失敗すること、抽出関数を空にすると抽出の自己テスト 9 件が失敗することを worker が確認した。
- 書き換えで検証が消えていた例（Issue #36 / PR #38、コミット「reviewer 指摘: 既存インストール検出のテストを --install-only に追加し、…」と `logs/2026-09-28.md` の「SessionStart フックの導入を一時停止する PR #38 / Issue #36 を、#37 に置き換わったためクローズ」）: フックの経路を書き換えた結果、既存インストールの検出を確かめるテストが消え、検出を壊しても緑のままになっていた。reviewer の変異（`ensure_node` の検出を `NODE_DIR=""` に変える）で見つかり、テストを 2 件追加して同じ変異で 2 件失敗することを確認した（PR #38 はブランチごと破棄）。
- ゲートの must reject / must pass を実際のコミットで確かめた例（Issue #26 / PR #33、コミット「Biome と Lefthook を導入し、…」）: reviewer が 6 種の変異でテストが失敗することを確認し、使い捨てリポジトリで違反を含むコミットが拒否され、`.md` だけのコミットは通ることを確かめた。
- 変異でテストの強さを確かめた例（Issue #23 / PR #30、コミット「クラウドセッション用に Node / pnpm を用意する setup script と SessionStart フックを追加」）: reviewer が 8 種の変異でテストが失敗することを確認した。
- ゲートが実際に止まることを先に確かめた例（Issue #45、コミット「単体テストのカバレッジゲートを 100% にし、不足分のテストを追加」）: しきい値だけを入れた状態で `pnpm test` がしきい値未達（lines 98.78% など）で失敗することを確認してからテストを足し、足したテストが分岐を通すだけでないことを、分岐を 1 つずつ壊して失敗することで確認した（worker）。
- 型チェックが実際に動いていることを確かめた例（Issue #17、`logs/2026-09-28.md` の「TypeScript を 7.0.2 に更新」）: 型エラーのファイルを一時的に置くと `next build` が `Failed to type check` で exit 1 になることを worker と reviewer が確認した。同じく「`vite-tsconfig-paths` を削除し …」では、`resolve.tsconfigPaths` を外すと import の解決エラーでテストが失敗することを確認した。

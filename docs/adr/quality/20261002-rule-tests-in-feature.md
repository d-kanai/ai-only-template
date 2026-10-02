# ルール検査テストを .feature（`*` の箇条書き）と step の実装に分ける

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #282 / `.claude/rules/testing.md`（「ルール検査テスト」） / `rule-tests/rule-test-feature.test.ts` / `rule-tests/case-table.ts` / `rule-tests/test-phases.test.ts` / quality/20260930-api-spec-in-feature.md / quality/20260928-rule-check-tests-must-pass-and-must-reject.md

## 背景
ルール検査テスト（`rule-tests/*.test.ts`）は規則の仕様そのものだが、Vitest の describe / it の名前として 2 万行を超えるコードの中に散っていて、どんな規則を何で止めているかを一覧で読めなかった。API 仕様（quality/20260930-api-spec-in-feature.md）はすでに `.feature` の `*` の箇条書きで読める。daiki から「ルールテストもすべて feature ファイルにできるか。API 仕様のように `*` の箇条書きで対応させればよい」と依頼があった（2026-10-02）。

## 決定
- `rule-tests/<名前>.test.ts` ごとに、同じディレクトリに `<名前>.feature` を置く。`.feature` は `Feature:` の下に `Scenario:` と `*` の step だけを並べる（Given / When / Then のキーワード・タグ・Background・Scenario Outline・説明の行は使わない）。`<名前>.test.ts` は vitest-cucumber の step の実装で、`loadFeature("./<名前>.feature")` で対の `.feature` を読む。
- 移し方は describe 1 つ = Scenario 1 つ、it 1 つ = `*` の step 1 つ。it.each は `*` 1 行にまとめ、ケースは step の実装の表に置いて `casesByName`（`rule-tests/case-table.ts`）でケース名ごとに比べる。
- step の実装は vitest から it / test / describe / suite を import しない（vitest.config.mts は globals を使わないので、describe / it で書けなくなる）。
- step の文に、先頭のほかの `*` と波かっこを書かず、文を正規表現として読めるようにする（対になっていないかっこを書かない）。
- 形は `rule-tests/rule-test-feature.test.ts` で止める。ルール検査テストの step は API 仕様の step と同じく、フェーズコメントの検査（`rule-tests/test-phases.test.ts`）の対象にする。

## 理由
- 規則の一覧を `.feature` で読め、Scenario（規則のまとまり）と `*`（振る舞い 1 つ）の形が API 仕様とそろう。step の文がコードとずれると vitest-cucumber が読み込みで失敗するので、`.feature` は古くならない。
- it.each をケースごとの step にすると `.feature` が入力の列挙で埋まり、仕様として読めなくなる。ケース名をキーにした object で比べれば、落ちたケースがすべて diff に出る。
- `*` の文の中の `*` と波かっこは vitest-cucumber 8.0.0 で読み違えられる（`a.b* c` と `a.b* d` が同じ step として ItemAlreadyExistsError、`{int}` を含む step が式として別の step に一致した。Issue #282 で実測）。文は `?` のほかは逃がさずに正規表現にされるので、対になっていない `(` は読み込みで `SyntaxError: Unterminated group` になる（同じく実測）。

## 採用しなかった案
- it.each のケースを 1 件ずつ `*` の step にする: `.feature` がケースの列挙で埋まり、同じ実装の step を何十も書くことになる。式（`{string}`）で 1 つの実装に当てる書き方は、同じ Scenario の中で最初に一致した行にしか割り当てられない（`.claude/rules/testing.md` の「API ジャーニーテスト」）。
- Scenario Outline と Examples の表でケースを書く: API 仕様と形がずれ、ケースの入力（複数行のソース・fixture）を表のセルに書けない。
- describe / it のまま、テスト名の一覧を別の文書に書き出す: 文書とコードがずれても止まらない。

## 影響
- 良い点: ルール検査テストの規則を `.feature` で一覧できる。形を機械で止めるので、新しいルール検査テストも同じ形になる。
- 悪い点: step の文を `.feature` と step の実装の 2 か所に書く（ずれは vitest-cucumber が止める）。it.each のケースは Vitest の一覧に 1 件ずつ出なくなる（落ちたときは diff のケース名で分かる）。
- 見直す条件: vitest-cucumber が文の中の `*` と波かっこを読み違えなくなったら、`rule-test-feature-format` の文の制限を外す。

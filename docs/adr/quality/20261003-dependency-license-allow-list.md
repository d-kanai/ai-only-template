# 依存パッケージのライセンスを、pnpm licenses list と許可リストのルール検査テストで CI に止めさせる

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #368 / `rule-tests/licenses.test.ts` / `.claude/rules/tooling/dependencies.md`（「ライセンス」） / quality/20260928-rule-check-tests-must-pass-and-must-reject.md / quality/20260928-pin-exact-dependency-versions.md

## 背景
依存パッケージ（推移的な依存を含む）に、使えないライセンス（GPL / AGPL のような強いコピーレフト・商用の制限付き・ライセンス無し）が入っても気づく仕組みが無かった。daiki から「ライセンス全体的にチェックするようにしないと。スキルなのか定期か CI チェックしたい」と希望があった（2026-10-03）。リポジトリは本番の前に private にする予定で、有料の道具は使わない（2026-10-03 のユーザー判断）。

## 決定
- ルール検査テスト `rule-tests/licenses.test.ts`（仕様は対の `.feature`）が `pnpm -r licenses list --json` でワークスペースのすべてのパッケージのインストール済みの依存（devDependencies を含む）のライセンスを読み、許可リスト（MIT・ISC・Apache-2.0・BSD-2-Clause / BSD-3-Clause・0BSD・MIT-0・CC0-1.0・BlueOak-1.0.0）に無いものを違反にする。
- 許可リストに無いが使ってよいものは、名前とライセンスの組と理由を例外に書く（今は libvips（LGPL-3.0-or-later）・lightningcss（MPL-2.0）・caniuse-lite（CC-BY-4.0））。
- SPDX の式は、許可リストの ID だけを ` OR ` でつないだものだけを許可する。`AND`・`WITH`・入れ子のかっこ・`Unknown` は許可しない。
- `pnpm test` の中で動くので、CI の `ci` ジョブ（required status check）で毎回止まる。ワークフローは変えない。日次のジョブは置かない。

## 理由
- `pnpm licenses list` は pnpm の標準のコマンドで、道具を足さず、レジストリにも接続しない（インストール済みの node_modules を読むだけで約 0.2 秒。2026-10-03 実測）。CI と手元で同じ結果になる。
- ルール検査テストにすれば、must pass / must reject と fixture（一時ディレクトリに GPL の依存をインストールすると違反になる）で検査が効くことを固定でき、ほかの規則と同じ形で読める。
- 日次のジョブが要らない: npm は公開済みの `<名前>@<版>` を差し替えられない（https://docs.npmjs.com/policies/unpublish ）。lockfile が版と integrity を固定するので、lockfile が変わらなければライセンスも変わらない。lockfile が変わる PR では必ずこのテストが動く。
- 許可リスト方式: 拒否リストだと、知らないライセンス・書き間違い・ライセンス無しが黙って通る。

## 採用しなかった案
- Trivy の license scan: Issue #112 で入れる Trivy と道具をそろえられるが、npm のライセンスの読み方（lockfile か node_modules か）を公式ドキュメント（https://trivy.dev/latest/docs/scanner/license/ ）から確かめられなかった。分類は Google の license classifier のカテゴリで、許可を名前ごとに書く形にしにくい。外部のバイナリを CI に入れる手間も増える。
- OSV-Scanner の `--licenses`: lockfile のすべてのパッケージ（ほかのプラットフォームのものも）を見られるが、ライセンスを deps.dev の API から取る（https://google.github.io/osv-scanner/usage/license-scanning/ ）ので、検査がネットワークと外部のサービスに依存する。
- スキル（人やエージェントが呼んだときだけ確かめる）: 呼び忘れで止まらない（CLAUDE.md の原則 7）。
- 日次のジョブ: 上の理由で、変わらないものを毎日確かめることになる。

## 影響
- 良い点: 依存を足す・上げる PR で、許可していないライセンスが入ると CI が落ちる。例外は理由付きで 1 か所に並ぶ。
- 悪い点: 今のプラットフォームで入らない optional の依存（ほかの OS のビルド済みのバイナリ）は見ない。CI と本番はどちらも linux x64 なので本番に入るものは見られるが、ほかのプラットフォームの名前は例外に手で並べる。パッケージの package.json の申告だけを見て、同梱のファイルのライセンスは見ない。許可したライセンスの義務（著作権表示の同梱など）を守っているかは見ない。
- 見直す条件: 本番を別のプラットフォームで動かすとき、ライセンスの義務（表示）を機械で揃える必要が出たとき、Trivy を入れた後に Trivy で同じ粒度の許可が書けると分かったとき。

# Usage limit の節約のため、1 Issue = 1 セッション・wake の削減・軽い worker・reviewer と fault injection の最小化を運用にする

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #78 / PR #79 / `.claude/general/orchestration.md` / `.claude/general/workflow.md` / スキル `pr-flow` / スキル `rule-check-test`

## 背景
`/usage` の内訳から、消費の主因は「巨大な 1 セッションを長時間回し、worker / reviewer の往復と、作業の無い wake（フックの feedback・完了通知）が積み上がる」構図だった（2026-09-29 の work-logs「Usage limit に早く達しないための改善案をユーザーに提案した」）。

## 決定
- 1 Issue = 1 PR = 1 セッション（`/clear`）。長期の文脈は work-logs と Issue コメントに置く。
- wake を減らす: push は 1 ラウンド 1 回、worker が終わるごとにコミットして未コミットを長く残さない、CI の完了はポーリング 1 本で待つ（Issue #82 で auto-merge に変えた。workflow/20260929-merge-with-auto-merge.md）。
- 機械的な作業は `worker-light`（Sonnet 5.5）、単発の検索は組み込みの Explore。サブエージェントの model はフル ID で固定し、`rule-tests/instructions.test.ts` の `agent-model` で検査する。
- 機械的な変更（改名・文書・参照の更新だけ）は reviewer を省く。reviewer には差分と観点を絞って渡す。
- fault injection の既定は最小セット（規則を破る 1 件・判定を常に許可・常に拒否）。境界の網羅は新しいルール検査テストを作るときだけ。
- 並列は 2〜3 worker まで。worker は対象ファイルのテストだけ、全体のテストはオーケストレータが最後に 1 回。
- セッション中に指示ファイルを変えない（専用の Issue で、セッションの最初に変える）。

## 理由
- 毎ターン全コンテキストを送るので、ターン数 × コンテキスト量が消費になる。長いセッション・大きいコンテキストの比率が高かった（2026-09-29 の work-logs の同じ項目）。
- 環境側の Stop フック（未コミットがあれば止める）はリポジトリから変えられず、止まるたびに wake になる（2026-09-29 の work-logs「Issue #78: Usage limit の節約策をすべて運用に入れた」）。
- Issue #64 では、5 並列の worker と reviewer が大きく消費し、統合後の再検証も増えた（2026-09-29 の work-logs の改善案の項目）。
- 指示ファイルを変えると再読み込みが起き、プロンプトキャッシュが効かなくなる（Issue #78。公式での裏どりは記録に無い）。
- ユーザーの判断「節約対応は全部やって良い」。

## 採用しなかった案
- 環境側の Stop フックを、サブエージェントの実行中は止めない・警告だけにする（提案の 1 つ）: ユーザー側の `~/.claude/stop-hook-git-check.sh` で、リポジトリから変えられない。
- CI を 1 回の長い待ちか PR イベントの購読で待つ（提案の 1 つ）: ポーリング 1 本にした。採らなかった理由は記録に無い。

## 影響
- 良い点: セッションとサブエージェントの消費を減らす（効果は未確認。次のセッション以降の `/usage` で見る）。
- 悪い点: セッションをまたぐ文脈は work-logs と Issue に書いておく必要がある。`worker-light` は改名・参照の更新の範囲では Opus と同等だった（2026-09-29 の work-logs「Issue #86: ルール検査テスト 8 本を rule-tests/ に移した」）が、それ以外の作業は未確認。
- 見直す条件: 記録に無い。

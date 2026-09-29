# Usage limit の節約（Issue #78）

Claude Code の Usage limit に早く達しないための方針と、その根拠。方針の本体は `.claude/general/orchestration.md` と `.claude/general/workflow.md`（常時読む）、手順は スキル `pr-flow` / `rule-check-test`。

## 実測（2026-09-29、`/usage`）
- 直近 24h: 3,088 リクエスト・1 セッション。100% がサブエージェント多用のセッション、100% が 8 時間超のセッション、87% が 150k 超のコンテキストでの利用。サブエージェントの内訳は worker 32% / reviewer 7% / researcher 1%、MCP は github 8%。
- このセッションの実測: Issue #64 で worker 5 つ（各 15〜39 万トークン）+ reviewer 32 万トークン。Stop フックの feedback（環境側の「未コミットがあれば止める」と、リポジトリの `require-work-log.sh`）とバックグラウンド完了の通知で、作業の無い wake のターンが 1 日で 20 回超。wake のたびに全コンテキスト（150k 超）を送る。
- 常時読む指示は PR #75 で 210 KB → 19 KB（約 9%）に減った（`work-logs/2026-09-28.md`）。
- `/usage` はトークンの内訳を出さないので、各要因の寄与度は未確認。プロンプトキャッシュの読み取りが limit にどう数えられるかも公式で未確認。

## 方針と WHY
| 方針 | WHY |
| --- | --- |
| 1 Issue = 1 セッション（`/clear`）。長期の文脈は `work-logs/` と Issue コメントに置く | 毎ターン全コンテキストを送るので、ターン数 × コンテキスト量が消費になる。8 時間超・150k 超が 100% / 87% |
| push は 1 ラウンド 1 回。CI はポーリングで待たず、PR に auto-merge（merge commit）を付けて終える。auto-merge が無効なら次の人間のターンで 1 回だけ確認してマージ（Issue #82） | push ごとに CI が再実行され、ポーリングの完了通知ごとに wake（全コンテキストのターン）が増える。マージ条件は Ruleset の required check が守る |
| 未コミットを長く残さない（worker 完了ごとにコミット） | 環境側の Stop フック（Claude Code Remote の `~/.claude/stop-hook-git-check.sh`。未コミットがあれば exit 2 で止める）はリポジトリから変えられず、止まるたびに wake になる |
| 機械的な作業は `worker-light`（Sonnet 5.5）、単発の検索は組み込みの Explore | 改名・参照更新・文書の書き換えは Opus でも Sonnet でも結果が変わらず、消費だけが違う |
| 機械的な変更（改名・文書・参照更新だけ）は reviewer を省く。reviewer には差分と観点を絞って渡す | reviewer 1 回で 30 万トークン規模。ロジックの無い変更はオーケストレータのテスト実行と差分確認で足りる |
| fault injection の既定は最小セット（規則を破る 1 件・常に許可・常に拒否）。境界の網羅は新しいルール検査テストを作るときだけ | 数十件の変異は worker の消費の大半を占めた（Issue #64 の B は 45 変異）。見逃しの検出に効くのは主に「常に許可」「常に拒否」 |
| 並列は 2〜3 worker まで。worker は対象ファイルのテストだけ、全体テストはオーケストレータが最後に 1 回 | 5 並列は統合後の再検証（全体テスト・reviewer・指摘反映）が増え、結果的に消費が増えた |
| セッション中に指示ファイル（CLAUDE.md / rules / settings.json / agents）を変えない。変更は専用の Issue でセッションの最初に | 変更すると再読み込みが起き、プロンプトキャッシュが効かなくなる（`docs/claude-code-mechanics.md`） |

## 機械的な強制
- `rule-tests/instructions.test.ts` の `agent-model`: `.claude/agents/*.md` の `model:` が許可した ID（`claude-opus-5-5` / `claude-sonnet-5-5`）のいずれか。WHY: 別名（`opus` / `sonnet`）や古い ID を書くと、意図しないモデルに解決されて消費や品質が変わる。
- `.claude/general/*.md` は 25 行以下、`CLAUDE.md` は 200 行以下（同テスト）。

## 未確認
- 各方針の効果（次のセッション以降の `/usage` で見る）。
- Sonnet 5.5 の worker-light が、改名・文書更新以外（単純なテストの追加）で Opus と同等の結果を出すか（初回の使用で確かめ、`work-logs/` に書く）。

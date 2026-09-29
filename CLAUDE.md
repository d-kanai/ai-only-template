# CLAUDE.md

## 1. FACTベース
- 推測で判断・報告しない。
- 判断の根拠は、実際の動作確認、コードの確認、1次情報（公式ドキュメント・ソースなど）の検索で得る。
- 確認できていないことは「未確認」と明示する。

## 2. Test Driven
- 実装は必ずテストから始める。テスト = 仕様。
- まず具体的な仕様をテストとして定義し、失敗することを確認してから、それを満たす実装を行う。
- テストが通ることを確認してから完了とする。

## 3. 改善ループ
- 1タスク終えるたびに振り返り、実装ミスやルール違反がなかったか確認する。
- ミスがあれば原因を特定し、再発防止ルールを `LEARNINGS.md` に積極的に追記・改善する（このファイルは編集しない）。

## 4. 応答
- 応答は常にシンプルなサマリーで、わかりやすく伝える。
- 基本フォーマット:
  - **結論**: 1〜2行
  - **ポイント**: 箇条書き3つ以内
  - **次のアクション**: ユーザーに必要な判断・作業（なければ省略）

## 5. コードコメント
- WHY のコメントは丁寧に、たくさん書く（なぜこの実装・この値・この分岐なのか）。
- WHAT のコメントは基本不要。コードが自己説明するようにリファクタリングで近づける。
- ただし、ツール設定や YAML など、リファクタリングでは self-explanatory にできないものは、WHY と同様に WHAT も積極的に書く。
- 変更時はコメントとコードの整合性がずれないように注意を払い、コードとコメントの両方を変更する。

## 6. 変更前の背景確認
- 実装やルールを修正する前に、該当箇所の commit history（`git log -p -- <path>`）、関連する Issue / PR、`work-logs/` の作業ログを確認し、なぜ今の形になっているかを理解したうえで修正内容を検討する。
- 狙い: 経緯を知らずに変更して、過去に解決した問題を再発させる（デグレ）のを防ぐ。
- 確認した背景と、それを踏まえた判断は PR の「実装経緯」に書く。

## 7. 機械的な強制を優先
- ルールは、lint・型チェック・テスト・フック・CI・コンパイル・カスタムルール（`rule-tests/architecture.test.ts` のような自前の検査）で機械的・決定的に強制できるなら、そちらを優先する。プロンプト・コンテキスト・ルール md での工夫は、機械に寄せられないものに限る。
- 機械に寄せたものは、コンテキスト（CLAUDE.md / rules / LEARNINGS.md）から減らす。文書には「何で強制しているか」への参照と WHY だけを残す。再発防止（3. 改善ループ）も、機械で止められるならそちらを優先し、LEARNINGS には参照と WHY を書く。
- 理由: 文章のルールは読み落とし・解釈のずれ・コンテキストの肥大化で効かなくなるが、機械の検査は毎回同じ結果で止まる。

@LEARNINGS.md

## 常時のルール（要点）
- オーケストレーション: @.claude/general/orchestration.md
- Issue → ブランチ → PR → マージ: @.claude/general/workflow.md
- コミットメッセージ: @.claude/general/commit.md
- 作業ログ: @.claude/general/work-log.md

## 指示ファイルの置き場所
常時読み込むのはこのファイル・LEARNINGS.md・`.claude/general/` だけにし、ほかは必要なときだけ読まれる形に分けている（WHY と公式の仕様・実測は `docs/claude-code-mechanics.md`。構成は `rule-tests/instructions.test.ts` が検査する）。

| 置き場所 | 読み込まれるとき | 置くもの |
| --- | --- | --- |
| `.claude/rules/*.md` | フロントマターの `paths` に一致するファイルを触ったとき | 規則と WHY |
| `.claude/skills/<name>/SKILL.md` | 説明は常時、本文は呼び出したとき | 手順 |
| `docs/` | 読み込まれない（必要なら自分で読む） | 実測・経緯・一次情報・採用しなかった案。一覧は `docs/README.md` |
| `work-logs/` | 読み込まれない | 日ごとの作業ログ |
| `rule-tests/` | 読み込まれない | ルール検査テスト 8 本（`architecture` / `instructions` / `lint` / `package` / `pnpm-workspace` / `settings` / `typecheck` / `work-logs-check` の `*.test.ts`。Issue #86） |

### .claude/rules（パス依存）
| ファイル | 触ったときに読まれる主なファイル | 内容 |
| --- | --- | --- |
| `backend.md` | `apps/backend/**` | DDD 4 層と許可の一覧、exports、永続化（Drizzle / Postgres / トランザクション）、命名 |
| `frontend.md` | `apps/frontend/**` | app はルーティングだけ、features の構成、画面側とサーバ側の境界、SSR を前提にしない |
| `architecture-check.md` | `rule-tests/architecture.test.ts` | 依存の向きの 27 規則、足すときの手順、限界 |
| `testing.md` | `**/*.test.ts(x)`・`apps/e2e/**`・テストの設定 | テスト = 仕様、置き方、テストダブル、ルール検査テスト、Stryker、E2E |
| `lint.md` | `biome.json`・`rule-tests/lint.test.ts`・`lefthook.yml`・`package.json` | Biome の方針と設定の WHY、pre-commit |
| `env.md` | `.env.example`・`env.ts`・`instrumentation*`・`compose.yaml`・`.tool-versions` | Node / pnpm の版、環境変数の一元化と検査 |
| `cloud-session.md` | `scripts/cloud-session-start*`・`.claude/settings.json` | クラウドセッションの setup script とフック |
| `dependencies.md` | `package.json`・`pnpm-workspace.yaml`・lockfile・`patches/**` | 完全固定、置き場所、版の決め方、pnpm patch |
| `git-guard.md` | `.claude/settings.json`・`lefthook.yml`・`scripts/hooks/guard-git*` など | git 操作の権限・フック・commit-msg |
| `work-log.md` | `scripts/hooks/require-work-log*`・`check-work-logs-diff*`・`ci.yml` など | 作業ログの強制（Stop フック・CI） |
| `worktree.md` | worktree のフックと生成規則 | worktree ごとの `.env`・DB・ポート |
| `shared.md` | `apps/shared/**` | frontend と backend で共通の基盤（env / logger）だけを置く、exports、`@repo/shared/...` の書き方 |

### スキル（手順。`/<name>` でも呼べる）
- `pr-flow`: Issue → ブランチ → PR → CI → マージ → 後始末（PR の作成・マージの前に読む）。
- `rule-check-test`: ルール検査テストとゲートの must pass / must reject と fault injection。
- `mutation-testing`: Stryker の実行と生き残りの扱い。
- `db-migration`: スキーマの変更とマイグレーション。
- `dependency-update`: 依存の追加・更新・lockfile の作り直し・pnpm patch。
- `cloud-session`: クラウドセッションの確認と復旧。

### 機械的な強制（原則 7）
- git: PreToolUse フック `scripts/hooks/guard-git.sh`（サブエージェントの commit / push / PR、main への commit / push、force push、`--no-verify` を拒否）、lefthook の pre-commit（Biome）と commit-msg（形式）。
- 作業ログ: Stop フック `scripts/hooks/require-work-log.sh` と CI の `scripts/hooks/check-work-logs-diff.sh`。
- worktree: WorktreeCreate フック `scripts/hooks/worktree-create.sh`、SubagentStop フック `scripts/hooks/subagent-stop.sh`（共有フックの修復）。
- コード: `pnpm lint` / `pnpm typecheck` / `pnpm test`（カバレッジ 100%・ルール検査テスト `rule-tests/`）/ CI の `ci` ジョブ（required status check）。

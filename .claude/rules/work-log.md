---
paths:
  - "logs/**"
  - "scripts/hooks/require-log*"
  - "scripts/hooks/check-logs-diff*"
  - "scripts/hooks/pre-compact*"
  - "scripts/hooks/instructions-loaded*"
  - "logs-check.test.ts"
  - ".github/workflows/ci.yml"
---

# 作業ログの強制と、フックの記録（Issue #64）

作業ログ（`logs/YYYY-MM-DD.md`）の書き方は `.claude/general/log.md`。ここは、記録漏れを止める仕組み（Stop フック・CI）と、compact・指示ファイルの読み込みを記録するフックの WHAT / WHY / 限界。実測と経緯は `docs/work-log.md`。

WHY 機械で止める: 調査だけの依頼などでログの追記が漏れた（LEARNINGS.md。ユーザーの指摘）。文章のルールは読み落とされる（CLAUDE.md の原則 7）。

フックの登録は `.claude/settings.json`（Stop → `require-log.sh`、PreCompact → `pre-compact.sh`、InstructionsLoaded → `instructions-loaded.sh`）。JSON にコメントを書けないので WHY はここと各スクリプトの先頭に書く。

## Stop フック `scripts/hooks/require-log.sh`
- WHAT: そのターン（最後の人間の発言以降）にツールを使ったのに、`logs/<今日>.md` が作業ツリー（未追跡・ステージ済みを含む）でも、このターンの間のコミット（最後の人間の発言の `timestamp` 以降。`git log --since=<その時刻>`）でも変わっていなければ、`{"decision":"block","reason":...}` で停止を拒否する。Claude は理由を受け取ってログを書き、止まり直す。
- 順序は「ログを追記 → コミット」: この環境のユーザー側の Stop フック（`~/.claude/stop-hook-git-check.sh`）は未コミットの変更があると止める。コミットした後も通るように、このターンの間のコミットでの変更も「書いた」とみなす。
- 判定の仕様（`scripts/hooks/require-log.test.ts` で固定）:
  - 人間のターン = `type: "user"` で `isMeta` でなく、`message.content` が文字列か、配列で `tool_result` を含まない行。ツールの結果（`tool_result`）と、Stop フックのフィードバックなどの `isMeta` の行は数えない。
  - 数えるのは、その後の `type: "assistant"` の行の `tool_use`（Bash / Agent / WebFetch / MCP など、種類を問わない）。0 なら会話だけのターンとして止めない。
  - `stop_hook_active: true`（Stop フックの block で続けている途中）なら判定しない。git リポジトリでない・transcript が読めない・入力が JSON でないときも止めない（理由は stderr）。判定できない状態で止め続けると、Claude が停止できずに上限（8 回）までループするため。
- 限界:
  - コミットを見る起点は最後の人間のターンの `timestamp`（数える起点と同じ行）。WHY: 起点を「今日の 0 時」にしていた最初の版は、その日に 1 度でもログがコミットされると（main の取り込みを含む）以後のターンがすべて素通りした（`docs/work-log.md` の実測）。
  - その行に `timestamp` が無い・日時として読めないときだけ、今日の 0 時にフォールバックする（理由を stderr に出す）。フォールバック中は、その日の以前のログのコミットで素通りしうる。
  - 見ているのは「このターンの間に今日のログのファイルが変わったか」だけで、中身がこのターンの作業かは見ない。ターンの途中に main を取り込み、今日のログが変わったマージコミットが入ると、それでも通る。
  - 日付は `date +%F`（ローカルのタイムゾーン）。クラウド VM は UTC なので、日本時間の 0〜9 時は前の日付になる。ログのファイル名を別のタイムゾーンで付けると、判定と食い違って止まり続ける（上限の 8 回で終わる）。
  - transcript は非同期に書かれ、Stop の時点で最新の行が入っていないことがある（公式 hooks の `transcript_path` の説明）。ツールの使用が書かれる前に判定すると 0 件と数えて素通りする（見逃す方向）。
  - `<task-notification>`（バックグラウンドの完了通知）は `isMeta` でない文字列の user 行なので、人間のターンとして数える（実セッションの transcript で確認）。通知より前のツール使用は、その前の Stop で判定済み。
  - `stop_hook_active` は「Stop フックの block で続けている途中」なら true（公式）なので、ユーザー側の Stop フックだけが block したときの続きでも、このフックは判定しない。両方が同時に block したときに Claude が両方の理由を受け取るかは未確認。
  - Stop はメインのエージェントだけで発火する（サブエージェントは SubagentStop）。worker が書いた変更のログは、オーケストレータのターンで判定される。

## CI `scripts/hooks/check-logs-diff.sh`（`ci.yml` の「Check work log in PR diff」）
- WHAT: `git diff --name-only --diff-filter=AM origin/<base>...HEAD` に `^logs/.*\.md$` が 1 件以上なければ失敗する。PR のときだけ（`if: github.event_name == 'pull_request'`）、準備より前（`pnpm lint` より前）に動く。`actions/checkout` は `fetch-depth: 0`（三点 diff の分岐点を求めるのに base ブランチと履歴が要る）。
- **例外なし**: 文書だけの PR も logs を要求する（Issue #64 のユーザー判断）。
- 検査（ルール検査テスト）: スクリプトの判定は `scripts/hooks/check-logs-diff.test.ts`、ci.yml への組み込み（ステップの有無・`if`・`continue-on-error`・`|| true` などの打ち消し・順序・`fetch-depth: 0`）は `logs-check.test.ts`。
- 数えるのは追加・変更（`--diff-filter=AM`）だけ。ログを削除しただけ・名前を変えただけの PR は通さない。
- 限界: ファイル名だけを見る。中身（その PR の作業が書かれているか）は見ない（reviewer と PR 本文の「実装経緯」で見る。手順はスキル `pr-flow`）。

## PreCompact `scripts/hooks/pre-compact.sh`
- WHAT: compact の直前に `.claude/state/pre-compact.md` へ、日時・trigger（`manual` / `auto`）・ブランチ・HEAD・`git status --short`・stash の件数・直近 5 コミットの 1 行目を上書きで書く。compact は止めない（常に exit 0、出力なし）。
- WHY: compact の要約で、どのブランチで何を変更中だったか（未コミット・stash）が落ちることがある。compact の後に読めば直前の状態を確かめられる。
- WHY logs/ に書かない: logs/ は人が読む記録。自動の dump を入れると、Stop フックの「このターンで今日のログが変わったか」が、ログを書かずに素通りになる。

## InstructionsLoaded `scripts/hooks/instructions-loaded.sh`
- WHAT: 指示ファイル（CLAUDE.md・`.claude/rules/*.md`・@ import したファイル）が読み込まれるたびに、`.claude/state/instructions-loaded.jsonl` に 1 行 `{"ts","file_path","load_reason","trigger_file_path","memory_type"}` を追記する（入力に無い項目は null）。
- WHY: どの指示が実際に読まれたかを後から確かめる（Issue #64 の完了条件）。rules の `paths:` の書き間違いは、そのルールが黙って読まれないだけでエラーにならない。
- 見方: `load_reason` は `session_start`（起動時）/ `path_glob_match`（`paths:` に一致するファイルを触った。`trigger_file_path` がそのファイル）/ `nested_traversal`（サブディレクトリの CLAUDE.md）/ `include`（@ import）/ `compact`（compact 後の再読み込み）（公式 hooks の InstructionsLoaded input）。
  ```
  node -e 'for (const l of require("fs").readFileSync(".claude/state/instructions-loaded.jsonl","utf8").trim().split("\n")) { const r = JSON.parse(l); console.log(r.ts, r.load_reason, r.file_path, r.trigger_file_path ?? "") }'
  ```
- 限界: セッションの ID を記録しないので、同じ作業ツリーで複数のセッションを動かすと行が混ざる（`ts` で見分ける）。

## `.claude/state/` と `.claude/worktrees/`
- どちらも `.gitignore` 済み。`.claude/state/` はフックの一時的な記録（セッションをまたいで残るが、コミットしない。消してよい）。`.claude/worktrees/` は `isolation: worktree` のサブエージェントが作る worktree。
- フックは cwd の git リポジトリの直下に書く。worktree の中で動けば、その worktree の `.claude/state/` に書く。

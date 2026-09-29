---
paths:
  - "scripts/hooks/require-work-log*"
  - "scripts/hooks/check-work-logs-diff*"
  - "scripts/hooks/pre-compact*"
  - "scripts/hooks/instructions-loaded*"
  - "rule-tests/work-logs-check.test.ts"
  - ".github/workflows/ci.yml"
---

# 作業ログの強制と、フックの記録（Issue #64）

作業ログ（`work-logs/YYYY-MM-DD.md`）の書き方は `.claude/general/work-log.md`（常時読み込み）。このファイルの `paths:` に `work-logs/**` を入れない（ログを書くたびにフックの説明が読み込まれ、書き方は `.claude/general/work-log.md` で足りるため）。ここは、記録漏れを止める仕組み（Stop フック・CI）と、compact・指示ファイルの読み込みを記録するフックの WHAT / WHY / 限界。決定は ADR `docs/adr/workflow/20260928-work-log-enforced-by-stop-hook-and-ci.md`、実測は 2026-09-28 の work-logs、公式の仕様と未確認の点は 2026-09-29 の work-logs「docs/ から移した記録」。

WHY 機械で止める: 調査だけの依頼などでログの追記が漏れた（LEARNINGS.md。ユーザーの指摘）。文章のルールは読み落とされる（CLAUDE.md の原則 7）。

フックの登録は `.claude/settings.json`（Stop → `require-work-log.sh`、PreCompact → `pre-compact.sh`、InstructionsLoaded → `instructions-loaded.sh`）。JSON にコメントを書けないので WHY はここと各スクリプトの先頭に書く。

## Stop フック `scripts/hooks/require-work-log.sh`
- WHAT: そのターン（最後の人間の発言以降）にツールを使ったときは、`work-logs/<今日>.md` が次のどちらかなら停止を許可する。
  - 作業ツリーで変わっていて（未追跡・ステージ済みを含む。`git status --porcelain`）、ファイルの更新時刻が起点（最後の人間の発言の `timestamp`）以降。
  - 起点以降のコミットで変わっている（`git log --since=<起点> -- work-logs/<今日>.md`。ほかのファイルだけのコミットは数えない）。
  - どちらでもなければ `{"decision":"block","reason":...}` で停止を拒否する。Claude は理由を受け取ってログを書き、止まり直す。
- 順序は「ログを追記 → コミット」: この環境のユーザー側の Stop フック（`~/.claude/stop-hook-git-check.sh`）は未コミットの変更があると止める。コミットした後も通るように、このターンの間のコミットでの変更も「書いた」とみなす。
- 判定の仕様（`scripts/hooks/require-work-log.test.ts` で固定）:
  - 人間のターン = `type: "user"` で `isMeta` でなく、`message.content` が文字列か、配列で `tool_result` を含まない行。ツールの結果（`tool_result`）と、Stop フックのフィードバックなどの `isMeta` の行は数えない。
  - 自動の wake も人間のターンとして数えない: 文字列（配列なら `text` 要素の連結）が、先頭の空白を除いて `<task-notification>` / `[SYSTEM NOTIFICATION` / `Stop hook feedback:` で始まる user 行。その前の本当の人間のターンを起点にし、起点以降のツール使用を数え、起点以降のコミットを見る。WHY: これらは `isMeta` の無い文字列の user 行として記録され、起点にすると CI の結果を読むだけの wake のターンで、人間のターンの中で済ませたログのコミットを見落として止めていた（オーケストレータの実測）。
  - 数えるのは、その後の `type: "assistant"` の行の `tool_use`（Bash / Agent / WebFetch / MCP など、種類を問わない）。0 なら会話だけのターンとして止めない。
  - `stop_hook_active: true`（Stop フックの block で続けている途中）なら判定しない。git リポジトリでない・transcript が読めない・入力が JSON でないときも止めない（理由は stderr）。判定できない状態で止め続けると、Claude が停止できずに上限（8 回）までループするため。
- 限界:
  - コミットを見る起点は最後の人間のターンの `timestamp`（数える起点と同じ行）。WHY: 起点を「今日の 0 時」にしていた最初の版は、その日に 1 度でもログがコミットされると（main の取り込みを含む）以後のターンがすべて素通りした（Issue #64 の実測。2026-09-28 の work-logs）。
  - `timestamp` は ISO 8601 の UTC（ミリ秒付き。例 `2026-09-28T21:37:27.487Z`）。秒に切り捨てて `git log --since=2026-09-28T21:37:27Z` の形で渡す。git がこの形を読むことは fixture（ターンの前のコミット → block、後のコミット → 許可）で確かめた。
  - CI で `origin/<base_ref>...HEAD` が引けるのは、`actions/checkout` の `fetch-depth: 0` が全ブランチを `refs/remotes/origin/*` に取るため（`src/ref-helper.ts` の `getRefSpecForAllHistory` が `+refs/heads/*:refs/remotes/origin/*`。README「Set fetch-depth: 0 to fetch all history for all branches and tags」）。
  - その行に `timestamp` が無い・日時として読めないときだけ、今日の 0 時（ローカル）にフォールバックする（コミットも更新時刻も。理由を stderr に出す）。フォールバック中は、その日の以前のログのコミット・書き込みで素通りしうる。
  - 作業ツリーの変更は、更新時刻が起点以降のときだけ数える。WHY: `git status` は「HEAD と違うか」しか見ないので、前のターンで書いて未コミットのまま残ったログがあると、以後のターンがログを書かずに通っていた（reviewer 指摘）。更新時刻は `stat -c %Y`（Linux）か `stat -f %m`（macOS）。
  - 見ているのは「起点以降に今日のログのファイルに書いた（更新時刻）か、起点以降のコミットで今日のログが変わったか」だけで、中身がこのターンの作業かは見ない。ログの中身を変えずに保存し直す（`touch` など）と通る。ターンの途中に main を取り込み、今日のログが変わったマージコミットが入ると、それでも通る。
  - 日付は `date +%F`（ローカルのタイムゾーン）。クラウド VM は UTC なので、日本時間の 0〜9 時は前の日付になる。ログのファイル名を別のタイムゾーンで付けると、判定と食い違って止まり続ける（上限の 8 回で終わる）。
  - transcript は非同期に書かれ、Stop の時点で最新の行が入っていないことがある（公式 hooks の `transcript_path` の説明）。ツールの使用が書かれる前に判定すると 0 件と数えて素通りする（見逃す方向）。
  - 自動の wake の見分けは文字列の先頭だけ。人間がこれらの文字列で始まる発言をすると wake とみなし、その前の人間のターンを起点にする（起点が前になるので、コミットは広く、ツール使用も広く数える）。この 3 種以外の形の自動の wake（将来の別の通知など）は人間のターンとして数える。
  - wake のターンでツールを使っていなくても、起点（前の人間のターン）以降にツールを使っていて、ログが変わっていなければ止める。
  - `stop_hook_active` は「Stop フックの block で続けている途中」なら true（公式）なので、ユーザー側の Stop フックだけが block したときの続きでも、このフックは判定しない。両方が同時に block したときに Claude が両方の理由を受け取るかは未確認。
  - Stop はメインのエージェントだけで発火する（サブエージェントは SubagentStop）。worker が書いた変更のログは、オーケストレータのターンで判定される。

## CI `scripts/hooks/check-work-logs-diff.sh`（`ci.yml` の「Check work-logs in PR diff」）
- WHAT: `git diff --name-only --no-renames --diff-filter=AM origin/<base>...HEAD` に `^work-logs/.*\.md$` が 1 件以上なければ失敗する。PR のときだけ（`if: github.event_name == 'pull_request'`）、準備より前（`pnpm lint` より前）に動く。`actions/checkout` は `fetch-depth: 0`（三点 diff の分岐点を求めるのに base ブランチと履歴が要る）。
- **例外なし**: 文書だけの PR も work-logs を要求する（Issue #64 のユーザー判断）。
- 検査（ルール検査テスト）: スクリプトの判定は `scripts/hooks/check-work-logs-diff.test.ts`、ci.yml への組み込み（ステップの有無・`if`・`continue-on-error`・`|| true` などの打ち消し・順序・`fetch-depth: 0`）は `rule-tests/work-logs-check.test.ts`。
- 数えるのは追加・変更（`--diff-filter=AM`）だけ。ログを削除しただけの PR は通さない。
- `--no-renames`: 名前の変更を常に「削除 + 追加」として扱い、利用者の `diff.renames` の設定に結果が左右されないようにする。限界: そのため、ログの名前を変えただけの PR は「追加」があるので通る（`check-work-logs-diff.test.ts` で固定）。
- 限界: ファイル名だけを見る。中身（その PR の作業が書かれているか）は見ない（reviewer と PR 本文の「実装経緯」で見る。手順はスキル `pr-flow`）。

## PreCompact `scripts/hooks/pre-compact.sh`
- WHAT: compact の直前に `.claude/state/pre-compact.md` へ、日時・trigger（`manual` / `auto`）・ブランチ・HEAD・`git status --short`・stash の件数・直近 5 コミットの 1 行目を上書きで書く。compact は止めない（常に exit 0、出力なし）。
- WHY: compact の要約で、どのブランチで何を変更中だったか（未コミット・stash）が落ちることがある。compact の後に読めば直前の状態を確かめられる。
- WHY work-logs/ に書かない: work-logs/ は人が読む記録。自動の dump を入れると、Stop フックの「このターンで今日のログが変わったか」が、ログを書かずに素通りになる。

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

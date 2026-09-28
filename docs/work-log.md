# 作業ログの強制とフックの記録: 実測と経緯（Issue #64）

ルール（WHAT / WHY / 限界）は `.claude/rules/work-log.md`。ここは、決めた経緯と、確かめた事実の記録。

## 経緯
- 2026-09-28、調査・質問だけの依頼で作業ログ（`logs/`）の追記が 2 件漏れた（LEARNINGS.md）。文章のルール（作業ログのルールの「調査や質問への回答だけで終わった場合も書く」。今は `.claude/general/log.md`）はあったが効かなかった。
- ユーザー判断（Issue #64 の 2 つ目のコメント「作業ログの記録漏れをフックと CI で止める」）:
  - Stop フック: そのターンでツール（Agent / Bash / WebFetch など）を使ったのに `logs/<今日>.md` が作業ツリーでもその日のコミットでも変わっていなければ停止を拒否する。判定は `transcript_path` の JSONL から最後のユーザーターン以降のツール使用を数える。
  - CI: PR の差分（`origin/main...HEAD`）に `logs/*.md` の変更が無ければ失敗させる。文書だけの PR も含め、例外なし。PR 本文の「実装経緯」に logs の項目名を書くことはスキル `pr-flow` の手順にする。
- 同じ Issue の方針 4 で、PreCompact で作業状態を書き出し、InstructionsLoaded で実際に読まれた指示ファイルを記録することにした。PreCompact の書き出し先は、当初の「logs に書く」から `.claude/state/` に変えた（logs に自動の dump を入れると Stop フックの判定が素通りになるため）。

## 公式の仕様（https://code.claude.com/docs/en/hooks.md 、2026-09-28 取得）
- Stop: メインのエージェントが応答を終えたときに発火する（ユーザーの中断では発火しない）。入力に `stop_hook_active`（Stop フックの結果として続けている途中なら true）、`last_assistant_message`。`{"decision":"block","reason":...}` で止めない。8 回連続で続けると打ち切る（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` で変更）。
- 共通の入力 `transcript_path`: transcript は非同期に書かれ、フックの時点で現在のターンの最新のメッセージを含まないことがある。
- PreCompact: matcher は `manual`（`/compact`）/ `auto`。入力に `trigger` と `custom_instructions`。exit 2 か `decision: "block"` で compact を止める（このリポジトリのフックは止めない）。
- InstructionsLoaded: CLAUDE.md・`.claude/rules/*.md` が読み込まれたときに発火（起動時と、遅延読み込みのとき）。入力に `file_path`・`memory_type`・`load_reason`（`session_start` / `nested_traversal` / `path_glob_match` / `include` / `compact`）・`globs`・`trigger_file_path`・`parent_file_path`。読み込みを止められず、非同期に動く。

## 実測
- Stop フックの動き（Issue #64 の 3 つ目のコメント、researcher の使い捨てリポジトリ、claude 2.1.283）: `git status --porcelain -- logs/<今日>.md` が空なら `{"decision":"block"}` で止まり、Claude がログを書いてから終了した（8 回で打ち切り。`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`）。この環境のユーザー側 Stop フック（未コミットがあれば止める）とぶつかるので、「ログを追記 → コミット」の順を前提にする。
- ユーザー側の Stop フック `~/.claude/stop-hook-git-check.sh`（クラウドセッション、2026-09-28 に中身を確認）: `stop_hook_active` が true なら何もしない。未コミットの変更（ステージ済みを含む）か未追跡のファイルがあれば exit 2 で止める。そのため `require-log.sh` は、作業ツリーの変更に加えて今日のコミットでの変更も「書いた」とみなす。
- transcript の形（2026-09-28、このリポジトリのクラウドセッションの transcript 14.6 MB・5281 行）:
  - ツールの結果は `type: "user"` で `message.content` が `[{"type":"tool_result",...}]` の行（577 行）。人間の発言は `message.content` が文字列の行。Stop フックのフィードバック（`Stop hook feedback: ...`）と他セッションからのメッセージは `isMeta: true`。
  - `<task-notification>`（バックグラウンドの完了通知）は `isMeta` の無い文字列の user 行だった。
  - メッセージ以外の行（`attachment` / `system` / `ai-title` / `mode` など）が混ざる。
- `require-log.sh` をこの transcript で実行: 0.19 秒で終わり、許可（出力なし）した。最後の人間のターン（task-notification）以降に tool_use はあったが、`git log --since=midnight -- logs/2026-09-28.md` が 66 件（main に取り込んだ当日のコミット）あり、「今日のコミットで変更」に当たったため。「1 日の中で 1 度でもログがコミットされると、以後のターンは素通りする」限界（`.claude/rules/work-log.md`）はこれで確かめた。
- fixture（`scripts/hooks/*.test.ts`）で確かめたこと: 一時 git リポジトリと架空の transcript で、未変更 → block、未追跡・変更・ステージ済み・今日のコミット → 許可、昨日のコミットだけ → block、`stop_hook_active: true` → 許可、ツール使用 0 → 許可、`tool_result` / `isMeta` の user 行を人間のターンと数えない、書きかけの最後の行を飛ばす、サブディレクトリの cwd でもリポジトリ直下で判定する。check-logs-diff は、logs の .md の追加・追記・サブディレクトリ → 0、logs 以外の .md だけ・`logs/x.txt` だけ・`apps/logs/a.md`・base 側だけの logs の変更・未コミットの変更・存在しない base-ref → 非 0。
- `actions/checkout@v4` の `fetch-depth: 0` は全ブランチを `refs/remotes/origin/*` に取る（actions/checkout の `src/ref-helper.ts` の `getRefSpecForAllHistory` が `+refs/heads/*:refs/remotes/origin/*`。README「Set fetch-depth: 0 to fetch all history for all branches and tags」）。そのため CI で `origin/<base_ref>...HEAD` が引ける。
- InstructionsLoaded の実動作（2026-09-28 21:32 UTC、このリポジトリの作業中のセッション。B が `.claude/settings.json` に登録した直後）: `.claude/state/instructions-loaded.jsonl` に `{"file_path":".../.claude/rules/testing.md","load_reason":"path_glob_match","trigger_file_path":".../settings.test.ts","memory_type":"Project"}` の 1 行が書かれた（どのセッション・サブエージェントの読み込みかは記録に無く未確認）。セッションの途中で足したフックの登録が効くことと、`paths:` の一致で読まれたことを記録で確かめられた。
- `isolation: worktree` の worktree（`.claude/worktrees/agent-<id>`）は、`.gitignore` が無いと本体の `git status` に `?? .claude/` と出る（2026-09-28、使い捨てリポジトリで `git worktree add .claude/worktrees/agent-1` して確認）。

## 未確認
- Stop / PreCompact のフックとして、このリポジトリの `.claude/settings.json` から実際に起動したときの動き（テストは stdin に JSON を渡して直接実行したもの）。次のセッションで、ツールを使ったターンでの block と `.claude/state/pre-compact.md` を確かめる。
- CI の「Check work log in PR diff」が GitHub Actions の PR で実際に動くこと（最初の PR で確かめる）。
- Stop の時点で transcript に当該ターンの tool_use が書かれていないことが、実際にどのくらい起きるか。
- ユーザー側の Stop フックと同時に block したときに、Claude が両方の理由を受け取るか。

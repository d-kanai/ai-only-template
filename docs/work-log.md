# 作業ログの強制とフックの記録: 実測と経緯（Issue #64）

ルール（WHAT / WHY / 限界）は `.claude/rules/work-log.md`。ここは、決めた経緯と、確かめた事実の記録。

名前: 2026-09-29（Issue #76、ユーザー指示）に呼び名を work-logs に統一した（ディレクトリ `work-logs/`、`.claude/general/work-log.md`、`scripts/hooks/require-work-log.sh`、`scripts/hooks/check-work-logs-diff.sh`、`rule-tests/work-logs-check.test.ts`、CI のステップ「Check work-logs in PR diff」）。それより前の記録も、この文書では新しい名前で書いている（実測した当時の旧名の一覧は Issue #76 の本文）。

## 経緯
- 2026-09-28、調査・質問だけの依頼で作業ログ（`work-logs/`）の追記が 2 件漏れた（LEARNINGS.md）。文章のルール（作業ログのルールの「調査や質問への回答だけで終わった場合も書く」。今は `.claude/general/work-log.md`）はあったが効かなかった。
- ユーザー判断（Issue #64 の 2 つ目のコメント「作業ログの記録漏れをフックと CI で止める」）:
  - Stop フック: そのターンでツール（Agent / Bash / WebFetch など）を使ったのに `work-logs/<今日>.md` が作業ツリーでもその日のコミットでも変わっていなければ停止を拒否する（当初の仕様。その後、起点を最後の人間のターンにし、作業ツリーは更新時刻も見るように変えた。下の「実測」）。判定は `transcript_path` の JSONL から最後のユーザーターン以降のツール使用を数える。
  - CI: PR の差分（`origin/main...HEAD`）に `work-logs/*.md` の変更が無ければ失敗させる。文書だけの PR も含め、例外なし。PR 本文の「実装経緯」に work-logs の項目名を書くことはスキル `pr-flow` の手順にする。
- 同じ Issue の方針 4 で、PreCompact で作業状態を書き出し、InstructionsLoaded で実際に読まれた指示ファイルを記録することにした。PreCompact の書き出し先は、当初の「work-logs に書く」から `.claude/state/` に変えた（work-logs に自動の dump を入れると Stop フックの判定が素通りになるため）。

## 公式の仕様（https://code.claude.com/docs/en/hooks.md 、2026-09-28 取得）
- Stop: メインのエージェントが応答を終えたときに発火する（ユーザーの中断では発火しない）。入力に `stop_hook_active`（Stop フックの結果として続けている途中なら true）、`last_assistant_message`。`{"decision":"block","reason":...}` で止めない。8 回連続で続けると打ち切る（`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` で変更）。
- 共通の入力 `transcript_path`: transcript は非同期に書かれ、フックの時点で現在のターンの最新のメッセージを含まないことがある。
- PreCompact: matcher は `manual`（`/compact`）/ `auto`。入力に `trigger` と `custom_instructions`。exit 2 か `decision: "block"` で compact を止める（このリポジトリのフックは止めない）。
- InstructionsLoaded: CLAUDE.md・`.claude/rules/*.md` が読み込まれたときに発火（起動時と、遅延読み込みのとき）。入力に `file_path`・`memory_type`・`load_reason`（`session_start` / `nested_traversal` / `path_glob_match` / `include` / `compact`）・`globs`・`trigger_file_path`・`parent_file_path`。読み込みを止められず、非同期に動く。

## 実測
- Stop フックの動き（Issue #64 の 3 つ目のコメント、researcher の使い捨てリポジトリ、claude 2.1.283）: `git status --porcelain -- work-logs/<今日>.md` が空なら `{"decision":"block"}` で止まり、Claude がログを書いてから終了した（8 回で打ち切り。`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`）。この環境のユーザー側 Stop フック（未コミットがあれば止める）とぶつかるので、「ログを追記 → コミット」の順を前提にする。
- ユーザー側の Stop フック `~/.claude/stop-hook-git-check.sh`（クラウドセッション、2026-09-28 に中身を確認）: `stop_hook_active` が true なら何もしない。未コミットの変更（ステージ済みを含む）か未追跡のファイルがあれば exit 2 で止める。そのため `require-work-log.sh` は、作業ツリーの変更に加えて、このターンの間のコミットでの変更も「書いた」とみなす。
- transcript の人間のターンの行には `timestamp`（ISO 8601 の UTC、ミリ秒付き。例 `2026-09-28T21:37:27.487Z`）がある（同じ transcript で、文字列の user 行 184 行すべてにあった）。`require-work-log.sh` は秒に切り捨てて `git log --since=2026-09-28T21:37:27Z` の形で渡す。git がこの形を読むことは fixture（ターンの前のコミット → block、後のコミット → 許可）で確かめた。
- transcript の形（2026-09-28、このリポジトリのクラウドセッションの transcript 14.6 MB・5281 行）:
  - ツールの結果は `type: "user"` で `message.content` が `[{"type":"tool_result",...}]` の行（577 行）。人間の発言は `message.content` が文字列の行。Stop フックのフィードバック（`Stop hook feedback: ...`）と他セッションからのメッセージは `isMeta: true`。
  - `<task-notification>`（バックグラウンドの完了通知）は `isMeta` の無い文字列の user 行だった。21:5x 時点で、`isMeta` の無い文字列の user 行 91 行のうち、先頭が `<task-notification>` / `[SYSTEM NOTIFICATION` / `Stop hook feedback:` のものが 29 行あった。
- 自動の wake でも止められた（オーケストレータの実測、2026-09-28）: CI の結果を 1 回読むだけのターン（`<task-notification>` で起こされた）でも、起点がその通知になり、人間のターンの中でコミットしたログを見落として block された。オーケストレータの判断で、上の 3 種の先頭で始まる user 行を人間のターンから除いた。除いた版を同じ transcript で実行すると許可した（最後の本当の人間のターン 21:49:49 UTC の後、21:50:20 に `work-logs/2026-09-28.md` を変えたコミットがあるため）。
  - メッセージ以外の行（`attachment` / `system` / `ai-title` / `mode` など）が混ざる。
- 最初の版の `require-work-log.sh`（今日の 0 時以降のコミットを見る）をこの transcript で実行: 0.19 秒で終わり、許可（出力なし）した。最後の人間のターン（task-notification）以降に tool_use はあったが、`git log --since=midnight -- work-logs/2026-09-28.md` が 66 件（main に取り込んだ当日のコミット）あり、「今日のコミットで変更」に当たったため。これで「1 日の中で 1 度でもログがコミットされると、以後のターンは素通りする」穴が分かり、オーケストレータの判断で、コミットを見る起点を最後の人間のターンの `timestamp` に変えた（`timestamp` が取れないときだけ今日の 0 時。2026-09-28）。変更後の版（自動の wake を除く前）で同じ transcript と作業ツリーを実行すると、0.25 秒で block を返した（最後の人間のターン 21:37 UTC 以降に `work-logs/2026-09-28.md` を変えたコミットも作業ツリーの変更も無いため）。
- fixture（`scripts/hooks/*.test.ts`）で確かめたこと: 一時 git リポジトリと架空の transcript で、未変更 → block、未追跡・変更・ステージ済み・最後の人間のターン以降のコミット → 許可、今日だがターンより前のコミットだけ → block、昨日のコミットだけ → block、`timestamp` が無い・読めない → 今日の 0 時にフォールバック（stderr に理由）、`stop_hook_active: true` → 許可、ツール使用 0 → 許可、`tool_result` / `isMeta` の user 行と自動の wake（3 種の先頭、先頭の空白、配列の content）を人間のターンと数えない、先頭以外に `<task-notification>` を含む人間の発言は人間のターンとする、書きかけの最後の行を飛ばす、サブディレクトリの cwd でもリポジトリ直下で判定する。check-work-logs-diff は、work-logs の .md の追加・追記・サブディレクトリ → 0、work-logs の .md を削除しただけ・work-logs 以外の .md だけ・`work-logs/x.txt` だけ・`apps/work-logs/a.md`・base 側だけの work-logs の変更・未コミットの変更・存在しない base-ref → 非 0。
- `actions/checkout@v4` の `fetch-depth: 0` は全ブランチを `refs/remotes/origin/*` に取る（actions/checkout の `src/ref-helper.ts` の `getRefSpecForAllHistory` が `+refs/heads/*:refs/remotes/origin/*`。README「Set fetch-depth: 0 to fetch all history for all branches and tags」）。そのため CI で `origin/<base_ref>...HEAD` が引ける。
- reviewer の指摘（2026-09-28）と対応:
  - 作業ツリーの判定が `git status --porcelain` だけだと、前のターンで書いて未コミットのまま残ったログで、以後のターンが素通りした。作業ツリーで変わっているときは、ファイルの更新時刻が起点以上のときだけ許可するように変えた（fixture: 更新時刻を起点より前にした未追跡・追跡済みのログ → block、ちょうど起点の秒 → 許可）。
  - `git log` から `-- "$log"` を外す変異でも 26 件のテストが通っていた。「このターンに別のファイルだけをコミット → block」を足し、同じ変異で落ちることを確かめた。
  - check-work-logs-diff の三点 diff のテストは、base 側で新しいログを足す形だったため、二点（`..`）に壊しても（HEAD から見て削除になり AM で外れて）落ちなかった。base 側で既存のログを変える形に直し、`..` にすると落ちることを確かめた。
  - `--no-renames` を足した。rename の検出が効くと名前の変更が R になり AM で外れるので、結果が `diff.renames` の設定に左右されていた。`git mv` で名前を変えただけの PR は、付けると 0、外すと 1 になる（テストで固定。付けた状態では `diff.renames=false` でも 0）。
  - `.claude/rules/work-log.md` の `paths:` から `work-logs/**` を外した（ログを書くたびに約 9 KB のフックの説明が読み込まれるため）。
- InstructionsLoaded の実動作（2026-09-28 21:32 UTC、このリポジトリの作業中のセッション。B が `.claude/settings.json` に登録した直後）: `.claude/state/instructions-loaded.jsonl` に `{"file_path":".../.claude/rules/testing.md","load_reason":"path_glob_match","trigger_file_path":".../settings.test.ts","memory_type":"Project"}` の 1 行が書かれた（どのセッション・サブエージェントの読み込みかは記録に無く未確認）。セッションの途中で足したフックの登録が効くことと、`paths:` の一致で読まれたことを記録で確かめられた。
- `isolation: worktree` の worktree（`.claude/worktrees/agent-<id>`）は、`.gitignore` が無いと本体の `git status` に `?? .claude/` と出る（2026-09-28、使い捨てリポジトリで `git worktree add .claude/worktrees/agent-1` して確認）。

## 未確認
- Stop / PreCompact のフックとして、このリポジトリの `.claude/settings.json` から実際に起動したときの動き（テストは stdin に JSON を渡して直接実行したもの）。次のセッションで、ツールを使ったターンでの block と `.claude/state/pre-compact.md` を確かめる。
- CI の「Check work-logs in PR diff」が GitHub Actions の PR で実際に動くこと（最初の PR で確かめる）。
- Stop の時点で transcript に当該ターンの tool_use が書かれていないことが、実際にどのくらい起きるか。
- ユーザー側の Stop フックと同時に block したときに、Claude が両方の理由を受け取るか。

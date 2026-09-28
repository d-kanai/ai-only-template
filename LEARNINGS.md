# LEARNINGS.md

改善ループで得た再発防止ルール。

- Claude Code の設定（agents / ルール）を作る前に、対象レポに既存の `.claude/` や rules がないか確認する。ユーザー側（~/.claude）に作ると他レポにも影響し、レポで管理できない。
- サブエージェント（reviewer / worker）の型は Claude Code 起動時のカレントディレクトリの `.claude/agents/` から読まれる。親ディレクトリで起動すると型が見つからず、自分の差分確認で代替し続けることになる。「Agent type not found」になったら代替を続けず、まずリポジトリ直下での再起動をユーザーに提案する。
- 外部連携（Codex レビューなど）をルールのマージ条件に入れる前に、その連携が今の PR で実際に動くことを確認する。過去 PR で動いていても、環境設定の有無で動かなくなることがある（PR #6）。
- `~/.asdf/shims/pnpm` や `~/.asdf/shims/npm` を直接叩くと、~/.zshrc で入る safe-chain のシェル関数を経由しない（Issue #13 の worker がこの経路で install した）。パッケージのインストール・実行はリポジトリ直下で素の `pnpm` を使う。`.tool-versions` のあるディレクトリなら素の `pnpm` でも asdf が正しい版に解決する（バージョン確認だけ shim 直叩きでよい）。
- 複数のサブエージェントを並列起動した後に SendMessage で追加指示を送るときは、送る前に起動結果の agentId と description（どの役割か）を照合する。Issue #23 で worker 宛の設計変更を researcher に送り、researcher の報告で気づくまで反映が遅れた。
- git worktree では `.git/hooks` が本体と共有される。フックを入れるツール（Lefthook など）を worktree で `pnpm install` すると本体のフックが書き換わるので、worktree では `CI=true pnpm install` や `lefthook run --no-auto-install` でフック導入を止め、フックの実動作は使い捨てリポジトリで確認する（Issue #26）。
- スクリプトで文字列置換をするときは、置換対象が空でなく 1 か所だけ一致することを assert してから置換する。Issue #26 で `s.index()` の最初の一致を使った結果、範囲が空になり pnpm-workspace.yaml が壊れた（git から復元済み）。
- worktree で「中で `pnpm install` を実行するスクリプト」（`scripts/cloud-session-start.sh` の実機確認など）を動かすときも `CI=true` を付ける。Issue #34 で worker に `CI=true` なしの実行を指示した結果、本体と共有の `.git/hooks/pre-commit` が worktree の lefthook を指すように書き換わった（本体で `pnpm exec lefthook install` を実行して復旧）。worktree での作業後は `.git/hooks/pre-commit` に worktree のパスが入っていないか確認する。 worktree で `git commit` するだけでも書き換わりうる: main を取り込んで lockfile が変わった直後の commit で、pre-commit の `pnpm exec biome`（lefthook.yml）が node_modules の更新（`pnpm install` 相当。lefthook の postinstall を含む）を先に走らせ、共有フックが worktree のパスに書き換わった（pnpm 12.7.0、2026-09-28 実測。自動 install の条件は未確認）。worktree を消した後は本体で `pnpm exec lefthook install` を実行し、`grep <worktree名> .git/hooks/pre-commit` が 0 件になることを確認する。
- GitHub 操作が 403 になったら、まず remote / API のエラーメッセージを読んで原因を特定する。Issue #34 の前に、公式ドキュメントの「push はセッションのブランチのみ」から「新規ブランチへの push が制限されている」と推測して報告したが、実際の原因は remote が明示していた「Claude GitHub App が未インストール」で、インストール後はすべての操作が通った。
- worker に「事実」として渡す前提は、実行して確かめてから渡す（ファイル一覧やメタデータだけで判断しない）。Issue #34 で pnpm の tarball を「展開すれば動く 1 本」と伝えたが、pnpm 12 の `pnpm` パッケージは placeholder で本体は `@pnpm/exe.<platform>` のネイティブバイナリだった（worker が `install.js` を読んで発見し、2 パッケージ取得に変更）。
- ユーザーが「まず見たい」「プランしたい」と言っている間は、提案への「おけ」を実装開始の指示と読まない。Issue #39 で構成案への「おけ」と判断事項の回答を受けて実装 worker を 3 つ起動したが、ユーザーはディレクトリ構成のプランだけを求めていた。実装に入る前に「実装に進んでよいか」を 1 行で確認する。

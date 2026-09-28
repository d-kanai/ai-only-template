# LEARNINGS.md

改善ループで得た再発防止ルール。

- Claude Code の設定（agents / ルール）を作る前に、対象レポに既存の `.claude/` や rules がないか確認する。ユーザー側（~/.claude）に作ると他レポにも影響し、レポで管理できない。
- サブエージェント（reviewer / worker）の型は Claude Code 起動時のカレントディレクトリの `.claude/agents/` から読まれる。親ディレクトリで起動すると型が見つからず、自分の差分確認で代替し続けることになる。「Agent type not found」になったら代替を続けず、まずリポジトリ直下での再起動をユーザーに提案する。
- 外部連携（Codex レビューなど）をルールのマージ条件に入れる前に、その連携が今の PR で実際に動くことを確認する。過去 PR で動いていても、環境設定の有無で動かなくなることがある（PR #6）。
- `~/.asdf/shims/pnpm` や `~/.asdf/shims/npm` を直接叩くと、~/.zshrc で入る safe-chain のシェル関数を経由しない（Issue #13 の worker がこの経路で install した）。パッケージのインストール・実行はリポジトリ直下で素の `pnpm` を使う。`.tool-versions` のあるディレクトリなら素の `pnpm` でも asdf が正しい版に解決する（バージョン確認だけ shim 直叩きでよい）。
- 複数のサブエージェントを並列起動した後に SendMessage で追加指示を送るときは、送る前に起動結果の agentId と description（どの役割か）を照合する。Issue #23 で worker 宛の設計変更を researcher に送り、researcher の報告で気づくまで反映が遅れた。
- git worktree では `.git/hooks` が本体と共有される。フックを入れるツール（Lefthook など）を worktree で `pnpm install` すると本体のフックが書き換わるので、worktree では `CI=true pnpm install` や `lefthook run --no-auto-install` でフック導入を止め、フックの実動作は使い捨てリポジトリで確認する（Issue #26）。
- スクリプトで文字列置換をするときは、置換対象が空でなく 1 か所だけ一致することを assert してから置換する。Issue #26 で `s.index()` の最初の一致を使った結果、範囲が空になり pnpm-workspace.yaml が壊れた（git から復元済み）。

# 作業ログの記録漏れを、Stop フックと CI の差分検査で止める

- 日付: 2026-09-28
- 状態: 採用
- 関連: Issue #64 / PR #75 / Issue #76 / `.claude/rules/work-log.md` / `.claude/general/work-log.md` / `scripts/hooks/require-work-log.sh` / `scripts/hooks/check-work-logs-diff.sh`

## 背景
調査・質問だけの依頼で、作業ログの追記が 2 件漏れた。文章のルール（回答を返す前に書く）はあったが効かなかった（LEARNINGS.md。2026-09-28 の work-logs「作業ログの記録漏れの指摘と対策（Issue #64）」）。

## 決定
- Stop フック: そのターンでツールを使ったのに、今日の `work-logs/<日付>.md` が作業ツリーでも最後の人間のターン以降のコミットでも変わっていなければ、停止を拒否する。
- CI: PR の差分（`origin/main...HEAD`）に `work-logs/*.md` の追加・変更が無ければ失敗させる。文書だけの PR も例外にしない。
- 呼び名は work-logs に統一する（Issue #76）。

## 理由
- ユーザーの判断（Issue #64 のコメント「作業ログの記録漏れをフックと CI で止める」）。
- Stop フックの `{"decision":"block"}` で、Claude がログを書いてから終わることを使い捨てリポジトリで確かめた（2026-09-28 の work-logs「Issue #64 の前提…を使い捨てリポジトリで実測」。公式 https://code.claude.com/docs/en/hooks.md ）。
- 起点を「今日の 0 時」にすると、1 日に 1 度ログをコミットすれば以後のターンが素通りした。起点を最後の人間のターンにし、自動の wake（完了通知など）は人間のターンと数えない（2026-09-28 の work-logs「Stop フック（require-log.sh）が自動の wake でも作業ログを要求する（実測と判断）」、PR #75 の実装経緯）。

## 採用しなかった案
- 文章のルールだけで運用する: 効かなかった。
- 起点を今日の 0 時にする（最初の版）: 1 度コミットすると以後が素通りする。
- PreCompact の作業状態の書き出し先を work-logs にする（Issue #64 の方針 4）: 自動の書き出しで Stop の判定が素通りになるので `.claude/state/` にした（PR #75）。

## 影響
- 良い点: 調査だけのターンでもログが残る。
- 悪い点: 実装の無いターンでも止まり、wake が増える（workflow/20260929-save-usage-limit.md）。環境側の Stop フック（未コミットがあれば止める）と重なるので、「ログを追記 → コミット」の順を前提にする。
- 見直す条件: 記録に無い。

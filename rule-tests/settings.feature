# .claude/settings.json の権限（permissions.deny）とフックの登録（.claude/rules/tooling/git-guard.md）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の settings.test.ts。
# 規則の WHY と限界は settings.test.ts の冒頭。
Feature: Claude Code の権限とフックの設定
  Scenario: matcher の判定（公式 hooks の Matcher patterns）
    * matcher がツール名に当たるかを公式の書き方どおりに判定する（無し・空・星印・名前・| と , の並び・前方一致の境界・正規表現・アンカー・部分一致）
    * Bash と MCP の書き込みツールをすべて並べた matcher は漏れがない（must pass）
    * Bash だけの matcher では MCP の書き込みツールが漏れる（must reject）
    * MCP の正規表現だけの matcher では Bash が漏れる（must reject）
  Scenario: permissions.deny の判定
    * 必須のルールがすべてあれば（ほかのルールがあっても）不足なし（must pass）
    * 必須のルールのどれか 1 つが無ければ、そのルールを不足として返す（must reject）（必須のルールのそれぞれ）
    * 書式が違うルール（末尾の星印の前の空白の有無）は同じルールとみなさない（must reject）
    * permissions が無い・deny が配列でない・settings が null ときは必須のルールをすべて不足として返す（must reject）
  Scenario: hooks の登録の判定
    * 期待する登録がすべてあれば問題なし（must pass）
    * 同じイベントにほかのグループやフックが並んでいても問題なし（must pass）
    * 期待するイベントのどれか 1 つの登録が無ければ、そのイベントの問題として返す（must reject）（期待するイベントのそれぞれ）
    * 登録の形が違うときは問題として返す（must reject）（スクリプトのパス・matcher を取らないイベントの matcher・PreToolUse の matcher の漏れ・SessionStart の matcher が無い・type・timeout・別のイベント・相対パス）
    * フックのコマンドから $CLAUDE_PROJECT_DIR 配下のスクリプトを重複なく取り出す
  Scenario: 権限・フックを黙って効かなくする設定の判定
    * 期待どおりの settings（ほかの allow があっても）は問題なし（must pass）
    * フックや権限を黙って効かなくする設定は問題として返す（must reject）（disableAllHooks: true・defaultMode: bypassPermissions・allow に Bash の全許可・allow に Bash）
    * 想定外のフックの登録は想定外として返す（must reject）（PreToolUse の想定外のグループ・同じグループの想定外のコマンド・想定外のイベント・フックが空のグループ）
  Scenario: スクリプトの存在と構文の判定（fixture）
    * あって構文の正しいスクリプトは問題なし（must pass）
    * 無いスクリプトと構文エラーのスクリプトを返す（must reject）
  Scenario: .claude/settings.json（実ファイル）
    * permissions.deny に必須のルールがすべてある
    * 各イベントに指定のスクリプトが登録されている
    * 想定外のフックの登録が無い
    * フックや権限を黙って効かなくする設定が無い
    * guard-git.sh を登録した PreToolUse の matcher が Bash と MCP の書き込みツールをすべて含む
    * フックが参照するスクリプトがすべてあり、bash -n が通る

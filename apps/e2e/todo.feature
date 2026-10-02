# 画面での Todo の管理（Issue #279。.claude/rules/testing.md の「E2E（Playwright + playwright-bdd）」）。
# step の実装は todo.steps.ts（対の名前。rule-tests/e2e-feature.test.ts の e2e-feature-pair）。ほかの .feature と共有する step
#   （Background の「Todo が 1 件も無い」・「Todo の一覧を開く」・「{string} の詳細を開く」）は shared.steps.ts。
# 書き方は API ジャーニー（apps/backend/spec/journey/todo-lifecycle.feature）にそろえる:
#   - このファイルは業務の仕様として読むもの。step と見出しは業務の言葉だけで書き、技術の言葉（禁止語の一覧は
#     rule-tests/feature-business-language.ts の FORBIDDEN_WORDS_IN_FEATURE）は書かない。画面の部品の探し方・保存の確かめ方は
#     step の実装に閉じる（e2e-feature-business-language）。
#   - 画面を操作する step（When）の直前には、業務の動作を名前にした仕切り `# ───── <業務の動作> ─────` を置く
#     （e2e-feature-section-divider。Background には置かない）。
#   - 1 シナリオ = 1 つの流れ。シナリオの中の操作の順で状態を担保し、最後に削除まで行って作ったデータを残さない。
Feature: 画面での Todo の管理

  Background: 空の Todo 一覧
    Given Todo が 1 件も無い

  Scenario: 追加から完了・改名・削除まで
    # ───── 一覧を開く ─────
    When Todo の一覧を開く
    Then 一覧は空で表示される
    # ───── Todo を追加する ─────
    When Todo "牛乳を買う" を追加する
    Then 一覧に "牛乳を買う" が表示され、保存されている
    # ───── 完了にする ─────
    When 一覧で "牛乳を買う" を完了にする
    Then 一覧で "牛乳を買う" が完了になる
    # ───── 詳細を見る ─────
    When "牛乳を買う" の詳細を開く
    Then 詳細で "牛乳を買う" が完了になっている
    # ───── 名前を変える ─────
    When 詳細でタイトルを "豆乳を買う" に変えて保存する
    Then 詳細の見出しが "豆乳を買う" に変わる
    # ───── 一覧に戻る ─────
    When 詳細から一覧に戻る
    Then 一覧に "豆乳を買う" が表示され、元の名前 "牛乳を買う" は表示されない
    # ───── 削除する ─────
    When 一覧で "豆乳を買う" を削除する
    Then 一覧から "豆乳を買う" が消え、保存からも消えている

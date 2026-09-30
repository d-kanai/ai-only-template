// 現在時刻の唯一の出口。アプリのコード（テスト以外）で現在時刻が要るときは、必ずこの now() を呼ぶ。
// new Date()（引数なし）・Date.now() を書いてよいのはこのファイルだけで、rule-tests/architecture.test.ts の規則
//   now-single-source が止める（.claude/rules/shared.md）。
//
// WHY 1 か所に集める: 時刻を各所で直接読むと、時刻に依存する振る舞い（作成日時・一覧の並び順・ログの時刻）のテストが
//   実行した瞬間で結果を変え、決定的にならない。出口を 1 つにすれば、テストは vi.mock でこのモジュールを差し替えるだけで
//   どの経路の時刻も決められる（差し替える seam はここだけ）。
// WHY 引数で受け取る形（Todo.create(title, createdAt) や Clock の注入）にしない: 「作ったときの時刻が入る」のは Entity の
//   生成ルールで、呼び出し側が時刻を渡せると、そのルールが呼び出し側に漏れる（誤った時刻でも作れてしまう）。
// WHY Date を返す（ISO 文字列や数値にしない）: 呼び出し側（Todo の createdAt、ログの toISOString）は Date を使う。
//   毎回新しい Date を作るので、呼び出し側が返り値を書き換えても次の呼び出しに影響しない。
export function now(): Date {
  return new Date();
}

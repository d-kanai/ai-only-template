// 現在時刻の唯一の出口。アプリのコード（テスト以外）で現在時刻が要るときは、必ずこの Clock.now() を呼ぶ。
// new Date()（引数なし）・Date.now() を書いてよいのはこのファイルだけで、rule-tests/architecture.test.ts の規則
//   now-single-source が止める（.claude/rules/code/shared.md）。
//
// WHY 1 か所に集める: 時刻を各所で直接読むと、時刻に依存する振る舞い（作成日時・一覧の並び順・ログの時刻）のテストが
//   実行した瞬間で結果を変え、決定的にならない。出口を 1 つにすれば、テストは vi.mock でこのモジュールを差し替えるだけで
//   どの経路の時刻も決められる（差し替える seam はここだけ）。
// WHY 引数で受け取る形（Todo.create(title, createdAt) や Clock の注入）にしない: 「作ったときの時刻が入る」のは Entity の
//   生成ルールで、呼び出し側が時刻を渡せると、そのルールが呼び出し側に漏れる（誤った時刻でも作れてしまう）。
// WHY クラスの static メソッドにする（関数 now() にしない。Issue #262）: apps/shared も最上位に関数を置かない（規則
//   class-based。ADR docs/adr/architecture/20261002-class-based-shared-and-test-support.md）。インスタンスにして
//   コンストラクタで注入する形にしないのは上の WHY（時刻を呼び出し側から渡せる形にしない）と同じ理由で、seam は vi.mock の
//   1 つのまま保つ。vi.mock("@repo/shared/now") の自動モックはクラスの static メソッドも mock に差し替えるので、テストは
//   vi.mocked(Clock.now) で時刻を決められる（Issue #262 の調査）。
// WHY Date を返す（ISO 文字列や数値にしない）: 呼び出し側（Todo の createdAt、ログの toISOString）は Date を使う。
//   毎回新しい Date を作るので、呼び出し側が返り値を書き換えても次の呼び出しに影響しない。
export class Clock {
  static now(): Date {
    return new Date();
  }
}

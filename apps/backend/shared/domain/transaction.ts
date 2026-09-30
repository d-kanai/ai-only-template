// トランザクションを表す brand の型（Issue #215。ADR docs/adr/architecture/20260930-transaction-from-application.md）。
// command（application）が張ったトランザクションを、Repository の書き込み（insert / update / delete）と読み込み
//   （findByIdOrThrow）に渡すときの型。トランザクションを張る口 TransactionRunner は shared/application/transaction.ts
//   （Issue #220 でここから移した）。
// WHY この型だけを domain に置く: domain の TodoRepository（interface）の引数に要り、domain は application を参照できない
//   （rule-tests/architecture.test.ts の domain）。runner（トランザクションの範囲を決める口）は command の関心なので application に
//   置き、ここには型の印だけを残す。実体（Postgres のトランザクションと、その中の記録する Writer）は infra
//   （shared/infra/transaction.postgres.ts・shared/infra/writer.ts）が持つ。

// 中身を見せないトランザクション。application・domain は受け取って Repository に渡すだけで、中を触れない。
// WHY brand（unique symbol のキー）: 構造が空の型（`{}`）だと、どんな値でも Transaction として渡せてしまう。宣言だけの
//   unique symbol をキーにすると、このモジュールの外では作れない型になり、渡せるのは runner が作った値だけになる（infra が
//   1 か所の cast で作る。shared/infra/writer.ts の transactionOf）。
// WHY 実行時の値を持たない（declare）: 型を区別するためだけの印で、実行時には何も要らない。
declare const transactionBrand: unique symbol;
export type Transaction = { readonly [transactionBrand]: "transaction" };

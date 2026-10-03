// ヘルスチェック（GET /api/health。Issue #107）が DB に問い合わせられるかを確かめる窓口（interface）。
// WHY domain に interface だけを置く: TodoRepository（features/todo/internal/domain/todo-repository.ts）と同じく、application の query は
//   「問い合わせられるか確かめられる何か」にだけ依存し、実装（Postgres）は infra が持つ（依存性の逆転）。本番は api ファイルが
//   Postgres の実装を渡し、テストは ping の結果を決めたオブジェクトを渡す。
// WHY 名前を Repository にする（Probe などにしない）: presentation が組み立てに参照してよい infra は `<名前>-repository.postgres` だけ
//   （rule-tests/architecture.test.ts の presentation の isOwnPostgresRepository）。Repository の名前にそろえると、全 api ファイルの
//   プールが 1 つであることの検査（apps/backend/shared/http/route-handlers-share-database.test.ts）にも自動で入る。
export interface HealthRepository {
  // DB に問い合わせられれば resolve、問い合わせられなければ（接続できない・プールが閉じた・タイムアウト）reject する。
  // WHY 値を返さない: 確かめたいのは「問い合わせが往復したか」だけで、読む値に意味は無い（Postgres の実装は select 1）。
  ping(): Promise<void>;
}

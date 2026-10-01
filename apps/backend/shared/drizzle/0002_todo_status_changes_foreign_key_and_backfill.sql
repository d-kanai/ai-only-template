-- 手書きのマイグレーション（pnpm db:generate --custom で作った空のファイルに書いた。Issue #188）。
-- 1. todo_status_changes.todo_id の外部キー（todos(id)、on delete cascade）。
--    WHY schema.ts の .references() で生成しない: drizzle-kit 0.31.11 は REFERENCES "public"."todos" とスキーマ付きで書き、
--    テストのスキーマ（search_path で分けた別スキーマ）に当てても public の todos を指してしまう。ここではスキーマを書かず、
--    当てたスキーマ（search_path）の todos を指す（features/todo/infra/schema.ts の todoId のコメント）。
ALTER TABLE "todo_status_changes" ADD CONSTRAINT "todo_status_changes_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- 2. 既存の Todo の完了の履歴を作る（データの移行）。
--    WHY: Todo の不変条件は「履歴が 1 件以上で、最後の completed が今の completed と同じ」（todo.ts の todoPropsSchema）。
--    履歴の無い行は読み込むと 500 になり、一覧（findAll）ごと読めなくなる（.claude/rules/backend.md の「永続化」）。
--    すべての Todo に「作成日時に未完了」（Todo.create と同じ最初の 1 件）を入れ、完了済みの Todo には「完了」を足す。
--    完了した日時は記録が無く分からないので、作成日時（不変条件の下限）にする。
--    WHERE NOT EXISTS（Issue #194）: 履歴のある Todo には足さない（冪等）。rule-tests/migration.test.ts が INSERT ... SELECT に
--    WHERE NOT EXISTS か ON CONFLICT DO NOTHING があることを確かめる。
--    WHY 当てた後に書き換えても既存の DB には効かない: drizzle-orm 0.45.3 の migrator は適用済みかをハッシュで見ず、
--    __drizzle_migrations の最後の created_at と journal の when を比べるだけ（pg-core/dialect.js）なので、stg など当て済みの DB では
--    再実行されない。書き換えは新しい DB（テスト・新しい環境）のため。デプロイの切替までに旧アプリが作った行は、切替の後の backfill
--    （shared/drizzle/backfill/0001_todo_status_changes.sql）が補う。
INSERT INTO "todo_status_changes" ("todo_id", "position", "completed", "changed_at")
SELECT "id", 0, false, "created_at" FROM "todos"
WHERE NOT EXISTS (SELECT 1 FROM "todo_status_changes" s WHERE s."todo_id" = "todos"."id");--> statement-breakpoint
INSERT INTO "todo_status_changes" ("todo_id", "position", "completed", "changed_at")
SELECT "id", 1, true, "created_at" FROM "todos"
WHERE NOT EXISTS (SELECT 1 FROM "todo_status_changes" s WHERE s."todo_id" = "todos"."id" AND s."position" <> 0)
  AND "completed";

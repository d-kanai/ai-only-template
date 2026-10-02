-- 手書きのマイグレーション（pnpm db:generate --custom で作った空のファイルに書いた。Issue #188）。
-- todo_status_changes.todo_id の外部キー（todos(id)、on delete cascade）。
--    WHY schema.ts の .references() で生成しない: drizzle-kit 0.31.11 は REFERENCES "public"."todos" とスキーマ付きで書き、
--    テストのスキーマ（search_path で分けた別スキーマ）に当てても public の todos を指してしまう。ここではスキーマを書かず、
--    当てたスキーマ（search_path）の todos を指す（features/todo/infra/schema.ts の todoId のコメント）。
ALTER TABLE "todo_status_changes" ADD CONSTRAINT "todo_status_changes_todo_id_todos_id_fk" FOREIGN KEY ("todo_id") REFERENCES "todos"("id") ON DELETE cascade ON UPDATE no action;
-- WHY 既存の Todo の完了の履歴を作る INSERT（データの移行。Issue #188・#194）を消した（Issue #247）: 本番環境が無く、移す既存の
--   データが無い（新しい DB ではこの時点の todos は空で、INSERT は 0 行だった）。ファイル名（journal の tag）は変えない。
--   drizzle-orm 0.45.3 の migrator は適用済みかをハッシュで見ず、__drizzle_migrations の最後の created_at と journal の when を
--   比べるだけ（pg-core/dialect.js）なので、当て済みの DB で書き換えても再実行もエラーも起きない。

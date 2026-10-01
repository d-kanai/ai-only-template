-- 既存の Todo の完了の履歴を作る（データの移行。Issue #194）。0002 のマイグレーションの INSERT と同じ規則で、冪等に書き直したもの。
-- WHY マイグレーション（0002）と別に置くか: 0002 はデプロイの切替の前（migrate のジョブ）に当たる。切替までの間、旧アプリは
--   履歴を書かずに Todo を作り続けるので、0002 の後に作られた Todo には履歴が無い。この SQL はデプロイの切替の後
--   （.github/workflows/deploy.yml の Run backfill）に流し、その間に旧アプリが作った行も補う。
--   決まりは .claude/rules/backend.md の「永続化」、決定は ADR docs/adr/workflow/20261001-backfill-after-traffic-switch.md。
-- WHY 冪等に書くか: 適用の記録表を持たず、デプロイのたびにすべてのファイルを流す（apps/backend/shared/infra/backfill.ts）。
--   rule-tests/migration.test.ts が、INSERT ... SELECT に WHERE NOT EXISTS か ON CONFLICT DO NOTHING があることを確かめる。
-- WHY 作成日時にするか: Todo の不変条件は「履歴が 1 件以上で、最後の completed が今の completed と同じ」で、記録の無い日時は
--   分からないので、不変条件の下限（作成日時）にする（0002 と同じ）。
-- 新しいアプリ（切替の後）との同時実行（Issue #194）:
--   アプリは履歴の無い Todo を読むと履歴を補い（repair on read）、次の update で (todo_id, position 0..) を INSERT する
--   （repair on write。todos の行は findByIdForUpdate の FOR UPDATE でロックしている）。この SQL が同じ Todo に同時に INSERT すると、
--   (todo_id, position) の一意制約（0001_add_todo_status_changes.sql の todo_status_changes_todo_id_position_index）の違反で
--   どちらかが失敗する。アプリ側が失敗すると利用者には 500 になるので、譲るのは backfill の側にする（アプリは upsert を使わない規則。
--   rule-tests/persistence.test.ts）。
--   - FOR UPDATE OF t: todos の行をロックしてアプリのトランザクションと直列化する。アプリがロック中なら待ち、アプリの COMMIT の後に
--     進む。逆にこの SQL がロック中なら、アプリの findByIdForUpdate が待ち、この COMMIT の後に読むので履歴がある。
--   - ON CONFLICT (todo_id, position) DO NOTHING: READ COMMITTED では NOT EXISTS の副問い合わせは文の開始時のスナップショットを
--     見るので、ロック待ちの間にアプリが COMMIT した履歴を見逃して INSERT しうる。その 1 件を黙って捨てる（アプリが補った履歴が正）。
--   限界: 1 つのトランザクションで対象のすべての todos の行をロックするので、流している間、同じ Todo を変えるアプリの要求は待つ。
--     行が増えて待ちが問題になったら、範囲（id の区間）ごとにファイル・トランザクションを分ける。

-- 1. 履歴の無い Todo に「作成日時に未完了」（Todo.create と同じ最初の 1 件）を入れる。
INSERT INTO "todo_status_changes" ("todo_id", "position", "completed", "changed_at")
SELECT t."id", 0, false, t."created_at" FROM "todos" t
WHERE NOT EXISTS (SELECT 1 FROM "todo_status_changes" s WHERE s."todo_id" = t."id")
FOR UPDATE OF t
ON CONFLICT ("todo_id", "position") DO NOTHING;

-- 2. 完了済みの Todo のうち、履歴が 1 件目（position 0）だけのものに「作成日時に完了」を足す。
-- WHY 「1 件目だけ」に限るか: 履歴が 2 件以上ある Todo はアプリが書いた履歴を持つので変えない。1 件目だけで完了済みなのは、
--   上の 1. で足した直後の行（と、0002 の 1 件目の後に止まった行）で、最後の completed を今の completed にそろえる。
INSERT INTO "todo_status_changes" ("todo_id", "position", "completed", "changed_at")
SELECT t."id", 1, true, t."created_at" FROM "todos" t
WHERE NOT EXISTS (SELECT 1 FROM "todo_status_changes" s WHERE s."todo_id" = t."id" AND s."position" <> 0)
  AND t."completed"
FOR UPDATE OF t
ON CONFLICT ("todo_id", "position") DO NOTHING;

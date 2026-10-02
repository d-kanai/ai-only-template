-- 既存の Todo の完了の履歴を作る（データの移行。Issue #194）。0002 のマイグレーションの INSERT と同じ規則で、冪等に書き直したもの。
-- WHY マイグレーション（0002）と別に置くか: 0002 はデプロイの切替の前（migrate のジョブ）に当たる。切替までの間、旧アプリは
--   履歴を書かずに Todo を作り続けるので、0002 の後に作られた Todo には履歴が無い。この SQL はデプロイの切替の後
--   （.github/workflows/deploy.yml の Run backfill）に流し、その間に旧アプリが作った行も補う。
--   決まりは .claude/rules/backend.md の「永続化」、決定は ADR docs/adr/workflow/20261001-backfill-after-traffic-switch.md。
-- WHY 冪等に書くか: 適用の記録表を持たず、デプロイのたびにすべてのファイルを流す（apps/backend/shared/infra/backfill.ts）。
--   rule-tests/migration.test.ts が、INSERT ... SELECT に WHERE NOT EXISTS か ON CONFLICT DO NOTHING があることを確かめる。
-- WHY 作成日時にするか: Todo の不変条件は「履歴が 1 件以上で、最後の completed が今の completed と同じ」で、記録の無い日時は
--   分からないので、不変条件の下限（作成日時）にする（0002 と同じ）。
-- 新しいアプリ（切替の後）との同時実行（Issue #194・#237）:
--   Issue #260 でアプリは履歴を補わなくなった（repair on read / write をやめ、履歴の無い・食い違う Todo は読むと 500。
--   ADR docs/adr/workflow/20261002-drop-repair-on-read-without-production.md）ので、アプリがこの SQL の対象の Todo に履歴を
--   INSERT することは今は無い。下の FOR UPDATE OF t と ON CONFLICT は、そのとき（#194・#237）の同時実行への備えで、守りとして残す。
--   当時: アプリは履歴の無い Todo を読むと履歴を補い、次の update で (todo_id, 補った position ..) を INSERT した
--   （todos の行は findByIdForUpdate の FOR UPDATE でロックしている）。この SQL が同じ Todo に同時に INSERT すると、
--   (todo_id, position) の一意制約（0001_add_todo_status_changes.sql の todo_status_changes_todo_id_position_index）の違反で
--   どちらかが失敗する。アプリ側が失敗すると利用者には 500 になるので、譲るのは backfill の側にする（アプリは upsert を使わない規則。
--   rule-tests/persistence.test.ts）。
--   - FOR UPDATE OF t: todos の行をロックしてアプリのトランザクションと直列化する。アプリがロック中なら待ち、アプリの COMMIT の後に
--     進む。逆にこの SQL がロック中なら、アプリの findByIdForUpdate が待ち、この COMMIT の後に読むので履歴がある。
--   - ON CONFLICT (todo_id, position) DO NOTHING: READ COMMITTED では NOT EXISTS の副問い合わせは文の開始時のスナップショットを
--     見るので、ロック待ちの間にアプリが COMMIT した履歴を見逃して INSERT しうる。その 1 件を黙って捨てる（アプリが補った履歴が正）。
--   FOR UPDATE OF t を外すと、同時実行で deadlock（40P01）になった（2026-10-01 実測）。原因は推定: backfill の INSERT が一意索引に
--     入った後、外部キーの検査（todos の行の KEY SHARE）でアプリの FOR UPDATE を待ち、アプリの INSERT が backfill の未コミットの
--     行（同じ (todo_id, position)）を待つ循環。先に todos の行をロックすれば、この順の待ちは起きない。
--   限界: 1 つのトランザクションで対象のすべての todos の行をロックするので、流している間、同じ Todo を変えるアプリの要求は待つ。
--     行が増えて待ちが問題になったら、範囲（id の区間）ごとにファイル・トランザクションを分ける。

-- 1. 履歴の無い Todo に「作成日時に未完了」（Todo.create と同じ最初の 1 件）を入れる。
INSERT INTO "todo_status_changes" ("todo_id", "position", "completed", "changed_at")
SELECT t."id", 0, false, t."created_at" FROM "todos" t
WHERE NOT EXISTS (SELECT 1 FROM "todo_status_changes" s WHERE s."todo_id" = t."id")
FOR UPDATE OF t
ON CONFLICT ("todo_id", "position") DO NOTHING;
--> statement-breakpoint
-- 2. 完了済みの Todo のうち、履歴が 1 件目（position 0）だけのものに「作成日時に完了」を足す。
-- WHY 「1 件目だけ」に限るか: 履歴が 2 件以上ある Todo はアプリが書いた履歴を持つので変えない。1 件目だけで完了済みなのは、
--   上の 1. で足した直後の行（と、0002 の 1 件目の後に止まった行）で、最後の completed を今の completed にそろえる。
-- WHY position 0 があることも確かめる（AND EXISTS。reviewer の指摘）: READ COMMITTED では文ごとにスナップショットを取るので、
--   1. と 2. の間に旧アプリが「作って完了にした」Todo（履歴 0 件・completed = true）が 2. にだけ見える。position 0 を確かめないと
--   (id, 1, true) だけが入り、履歴が [完了] の 1 件になる。それは不変条件を満たすので流し直しても
--   直らず、未完了に戻す update が position 1 の INSERT で一意制約の違反（23505）→ 500 になり続ける。0 件の行はここでは足さず、
--   次の backfill の 1. → 2. でそろう。
-- 1. の後ろの区切りの印の行は、drizzle のマイグレーションと同じ書き方の文の区切り（SQL としてはコメント）。backfill.test.ts が
--   2. だけを流すテストに使う。
INSERT INTO "todo_status_changes" ("todo_id", "position", "completed", "changed_at")
SELECT t."id", 1, true, t."created_at" FROM "todos" t
WHERE NOT EXISTS (SELECT 1 FROM "todo_status_changes" s WHERE s."todo_id" = t."id" AND s."position" <> 0)
  AND EXISTS (SELECT 1 FROM "todo_status_changes" s0 WHERE s0."todo_id" = t."id" AND s0."position" = 0)
  AND t."completed"
FOR UPDATE OF t
ON CONFLICT ("todo_id", "position") DO NOTHING;
--> statement-breakpoint
-- 3. 最後の履歴（position が最大）の completed が todos.completed と食い違う Todo に、「最後の履歴の日時に、今の completed になった」を
--   末尾（最後の position + 1）に足す（Issue #237）。
-- WHY: 履歴を知らない旧リビジョンは、backfill（または 0002）で履歴が付いた後にも todos.completed だけを変える（切替の前の書き込みと、
--   切替の時に処理中だった要求）。1. と 2. は「履歴が 0 件」「1 件目だけ」しか見ないので、この Todo は直らず、読むと不変条件の違反
--   （500）になり一覧ごと読めなかった（Codex のレビューの P1）。
-- WHY 日時を最後の履歴の日時にする: 変えた日時は記録が無く分からないので、不変条件（日時は昇順）の下限にする（1. と 2. が作成日時を
--   使うのと同じ考え方）。
-- WHY 最後の履歴を NOT EXISTS（後ろの position が無い行）で選ぶ（max(position) の集約や GROUP BY にしない）: FOR UPDATE は集約・
--   GROUP BY のある SELECT に付けられない（Postgres の制約）。
-- WHY 冪等: 足した後は最後の completed が todos.completed と同じになるので、流し直しても選ばれない。ON CONFLICT は冪等のためではなく、
--   ロック待ちの間にアプリが同じ position に補った履歴を COMMIT したとき（1. の説明と同じ）に、それを黙って捨てるため。
-- WHY 0002 のマイグレーションには足さない: マイグレーションは切替の前に当たり、その時点の履歴はマイグレーション自身が作った
--   ものだけ（食い違いを作る旧リビジョンの書き込みは、履歴が付いた後＝マイグレーションの後に起きる）。
-- 限界: 履歴の並びが壊れている（日時が作成日時より前・逆順）Todo は直さない（どの日時が正しいか決められない。読むと 500 のまま）。
INSERT INTO "todo_status_changes" ("todo_id", "position", "completed", "changed_at")
SELECT t."id", l."position" + 1, t."completed", l."changed_at" FROM "todos" t
JOIN "todo_status_changes" l ON l."todo_id" = t."id"
WHERE NOT EXISTS (SELECT 1 FROM "todo_status_changes" n WHERE n."todo_id" = t."id" AND n."position" > l."position")
  AND l."completed" <> t."completed"
FOR UPDATE OF t
ON CONFLICT ("todo_id", "position") DO NOTHING;

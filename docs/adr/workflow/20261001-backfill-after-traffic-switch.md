# スキーマの変更はデプロイの切替の前、データの移行（backfill）は切替の後に冪等な SQL で流す

- 日付: 2026-10-01
- 状態: 採用
- 関連: Issue #194 / `.claude/rules/backend.md` / `.github/workflows/deploy.yml` / `rule-tests/migration.test.ts` / スキル `deploy` / スキル `db-migration`

## 背景
Issue #188 で Todo の完了の履歴を子表 `todo_status_changes` に移し、既存の Todo の履歴はマイグレーション（`0002_…backfill.sql` の INSERT）で作った。デプロイは migrate のジョブ → service のデプロイ → トラフィックの切替の順で、migrate から切替までの間は旧アプリが動き続け、履歴を書かずに Todo を作る。その Todo は backfill の対象にならず、新しいアプリが読むと不変条件の違反（500）になり、1 件でも一覧ごと読めなくなる。マイグレーションは 1 回しか当たらない（drizzle の記録表）ので、後から流し直す口も無かった。

## 決定
- スキーマの変更（drizzle のマイグレーション）は今までどおり切替の前（Run migrations）に当てる。
- データの移行は `apps/backend/shared/drizzle/backfill/NNNN_<内容>.sql` に冪等な SQL（`INSERT … SELECT … WHERE NOT EXISTS` / `ON CONFLICT … DO NOTHING`）で置き、切替の後（Route traffic to latest revision の後の Run backfill）に migrate のジョブを `--args=pnpm,db:backfill` で実行して流す。`pnpm db:backfill`（`apps/backend/shared/infra/backfill.ts`）は名前順にすべてのファイルを、ファイルごとに 1 つのトランザクションで流し、適用の記録表は持たない（毎回すべて流す）。
- 切替から backfill を流し終えるまでの間は、新しいアプリの Repository が履歴の無い Todo を backfill と同じ規則で補って読み（repair on read）、origin の履歴は DB の状態（空）にして、次の update で Writer 経由で INSERT する（repair on write。`Todo.reconstruct(values, stored?)`）。
- backfill と repair on write が同じ Todo に同時に INSERT するときは backfill が譲る: `FOR UPDATE OF t` で todos の行をロックしてアプリのトランザクション（`findByIdForUpdate` の FOR UPDATE）と直列化し、`ON CONFLICT (todo_id, position) DO NOTHING` で、ロック待ちの間にアプリが COMMIT した履歴（READ COMMITTED の文の開始時のスナップショットの NOT EXISTS では見えない）を捨てる。
- 完了の 2 件目を足す文（2 文目）は「position 0 があり、ほかの position が無い」完了済みの Todo だけに足す。WHY: READ COMMITTED では文ごとにスナップショットを取るので、1 文目と 2 文目の間に旧アプリが作って完了にした Todo（履歴 0 件）が 2 文目にだけ見える。position 0 を確かめないと履歴が [完了] の 1 件になり、不変条件は満たすので repair on read でも流し直しでも直らず、未完了に戻す update が position 1 の一意制約の違反（23505）で 500 になり続ける（reviewer が実 Postgres で再現）。0 件の行は次の backfill か repair on read でそろう。
- `FOR UPDATE OF t` を外すと、同時実行で deadlock（40P01）になった（2026-10-01 実測）。原因は推定で、backfill の INSERT が一意索引に入った後に外部キーの検査（todos の行の KEY SHARE）でアプリの FOR UPDATE を待ち、アプリの INSERT が backfill の未コミットの行を待つ循環。
- 既存のマイグレーションの INSERT も冪等（`WHERE NOT EXISTS`）に書き換え、2 文目に同じ position 0 の条件を足す（新しい DB 向け）。
- 検査: `rule-tests/migration.test.ts`（drizzle の SQL の `INSERT … SELECT` の冪等、deploy.yml の backfill のステップが切替の後で `--wait` を持ち、失敗を打ち消すつなぎと `continue-on-error` が無い、backfill のファイル名）と `apps/backend/shared/infra/backfill.test.ts`（実 Postgres で 2 回流しても増えない・アプリがロック中は待って 2 重にしない・script を子プロセスで実行して終了コード・2 文目だけを流しても履歴 0 件の完了済み Todo に足さない）。

## 理由
- 切替の後なら旧アプリは書かないので、そこで流せば漏れが残らない。冪等にしておけば、流し直し・毎回の実行で行が重ならず、記録表が要らない。
- 切替から backfill までの短い間は、アプリ側が読めなければ 500 になる。アプリが補って読めば、backfill の順序に依存せず動く。
- 譲るのを backfill にするのは、アプリが失敗すると利用者に 500 が返り、アプリには upsert を使わない規則（`rule-tests/persistence.test.ts`）があるため。backfill が捨てた 1 件は、アプリが同じ規則で書いた行なので失われない。
- `gcloud run jobs execute` の `--args` は実行 1 回だけ CMD を置き換え、ENTRYPOINT は残る（https://cloud.google.com/sdk/gcloud/reference/run/jobs/execute ）。migrate のイメージ（Dockerfile の migrate ステージ。ENTRYPOINT 無し、CMD `pnpm db:migrate`）に backfill の SQL と `backfill.ts` が入るので、ジョブを足さずに済む。deployer の `roles/run.developer` に `run.jobs.runWithOverrides` が含まれる（`infra/modules/app/github_wif.tf`）。
- drizzle-orm 0.45.3 の migrator は適用済みかをハッシュで見ず、`__drizzle_migrations` の最後の `created_at` と journal の `when` を比べるだけ（`pg-core/dialect.js`）。既存のマイグレーションの書き換えは当て済みの DB（stg）には効かないので、当て済みの DB のデータは backfill で直す。
- 実測は 2026-10-01 の work-logs。

## 採用しなかった案
- ロールアウト中の書き込みを止める（メンテナンスモード・旧アプリを先に止める）: 止めている間は書き込みが失敗し、利用者に見える。仕組み（読み取り専用の切り替え）も新しく要る。
- DB のトリガー（旧アプリの INSERT に合わせて履歴を作る）: 規則が SQL とアプリの 2 か所に分かれ、Writer を通らないので変更履歴とログが残らない（変更履歴をトリガーにしなかった理由と同じ。architecture/20260930-change-logs-written-by-repository.md）。消す時期の管理も要る。
- backfill をマイグレーションに入れたまま、切替の後にもう一度 `pnpm db:migrate` を流す: drizzle の migrator は 1 回当てたファイルを二度と流さない。
- backfill 用の適用の記録表を持つ: 1 回当てたら終わりになり、切替までに旧アプリが書いた行を補えない。冪等なら要らない。

## 影響
- 良い点: デプロイの切替の前後のどの時点でも、新しいアプリが履歴の無い Todo を読める。backfill は何度流してもよく、失敗しても手動で流し直せる（スキル `deploy`）。
- 悪い点: デプロイのたびにすべての backfill を流すので、ファイルと行が増えるとデプロイが長くなり、流している間は対象の行をロックする（同じ Todo を変える要求は待つ）。backfill が終わるまでは repair on read / write のコードを消せない。Node の `registerHooks`（`apps/backend/shared/infra/ts-resolve.ts`。node で TypeScript を直接動かすための resolve フック）は Node 24 で実験的。
- 見直す条件: backfill のファイル・行が増えてデプロイの時間やロックの待ちが問題になったとき（流し終えたファイルを消す・範囲で分ける）、Node の版を上げて `registerHooks` が変わったとき、`--args` の上書きが Cloud Run で動かなかったとき（stg の初回のデプロイで確かめる）。

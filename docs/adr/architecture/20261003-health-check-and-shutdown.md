# ヘルスチェックは DB まで見る 1 本の GET /api/health にし、停止は Next.js の標準のシグナル処理に任せる

- 日付: 2026-10-03
- 状態: 採用
- 関連: Issue #107 / `apps/backend/features/health/` / `apps/frontend_customer/app/api/health/route.ts` / `infra/modules/app/run.tf` / 2026-10-03 の work-logs

## 背景
デプロイ先や外からの監視がアプリの生死を判定する口が無かった。終了時に DB のプール（`AppDatabase.close()`）を閉じる経路も、シグナルに結び付いていなかった（Issue #107）。
アプリは Cloud Run のサービス（Next.js の standalone の `server.js`。`Dockerfile`）で動き、今はアプリにプローブを設定していない（`infra/modules/app/run.tf`）。

## 決定
- `GET /api/health` を 1 本だけ置き、DB に `select 1` を問い合わせられるかまで見る。通れば 200 `{ status: "ok", checks: { database: "ok" } }`、問い合わせられなければ 503 `{ status: "unavailable", checks: { database: "unavailable" } }`。`cache-control: no-store` を付ける。
- 置き場所は backend の feature `features/health/`（domain の `HealthRepository`・infra の `PostgresHealthRepository`・application の `GetHealthQuery`・presentation の `GetHealthApi`）。ほかの API と同じ層と組み立て（`AppDatabase.get().db`）にそろえる。
- liveness（プロセスが生きているか）と readiness（DB に届くか）は分けない。
- リクエストログ（`proxy.ts`）の matcher からは除外しない。
- グレースフルシャットダウンは自前のシグナルハンドラを足さず、Next.js の `startServer`（`next start` と standalone の `server.js` の両方が使う）の標準の処理に任せる。プールは明示的に閉じず、プロセスの終了で接続が切れる。

## 理由
- Next.js 16.3.6 の `node_modules/next/dist/server/lib/start-server.js` は、`NEXT_MANUAL_SIG_HANDLE` が無ければ SIGTERM / SIGINT で `server.close()`（新しい接続を受けず、処理中のリクエストの完了を待つ）→ `nextServer.close()` → `process.exit(143)`（SIGTERM）を行う。standalone の `server.js` で実測した: 3 秒かかるリクエストの途中で SIGTERM を送ると、そのリクエストは 200 で返り、送った後の新しい接続は拒否され、終了コードは 143（2026-10-03 の work-logs）。
- Cloud Run は止める前に SIGTERM を送り、10 秒後に止める。処理中のリクエストには完了の時間が与えられ、新しいリクエストはほかのインスタンスに送られる（https://docs.cloud.google.com/run/docs/container-contract ）。新しいリクエストを止めるのは Cloud Run と Next.js がすでに行う。
- プールを SIGTERM で閉じない理由: Next.js の処理には「処理中のリクエストが終わった後」に呼ばれる口が無く、`server.close()` の完了の直後に `process.exit` する。SIGTERM の時点で `pool.end()` を呼ぶと、処理中のリクエストのうち、これから接続を取るもの（node-postgres の `Pool` は `end` の後の `connect` を拒否する）が 500 になる。Cloud Run の 10 秒の間に終わるリクエストなら、終了の時点ではすべて終わっているので（10 秒を超えるものは Cloud Run が止める時点で切れ、プールの扱いとは関係なく失われる）、接続がプロセスの終了で切れても失われる書き込みは無い（開いたトランザクションがあれば Postgres が巻き戻す）。
- `NEXT_MANUAL_SIG_HANDLE` で自前の処理に替えない理由: Next.js の HTTP サーバに外から触れる口が無く、新しい接続を止め処理中を待つ処理を自前で持てない（公式の例 `node_modules/next/dist/docs/01-app/02-guides/self-hosting.md` も `process.exit` するだけ）。
- 1 本にする理由: 今はプローブが無く、使うのは外からの監視（死活の確認）で、DB に届かなければアプリは使えないので 503 が正しい。liveness を分けても使う先が無い。
- matcher から除外しない理由: 今は定期的に叩く監視が無く、ログの量は問題にならない。除外すると、手で叩いたときの記録も残らない。

## 採用しなかった案
- `/api/health/live`（DB を見ない）と `/api/health/ready`（DB を見る）に分ける: 今は使う先が無い。Cloud Run の liveness probe を使うときに DB を見ない口を足す（DB の障害で全インスタンスが再起動しないように）。
- `apps/backend/shared/http/` に置く: shared は feature をまたぐ道具の置き場所で、API（route）を持つものは feature に置く。
- SIGTERM で `AppDatabase.close()` を呼ぶ（Issue の当初の案）: 上の理由で処理中のリクエストを壊しうる。
- Cloud Run のアプリに startup / liveness probe を足す: この Issue の範囲外。足すなら liveness は DB を見ない口にする。

## 影響
- 良い点: 外からの監視が `curl /api/health` で DB まで含めて確かめられる。停止のための自前のコードが無く、Next.js の版が上がっても挙動は Next.js に従う。
- 悪い点: 停止時に Postgres 側に「接続が切れた」記録が出ることがある。Next.js の標準の処理が変わったら、この ADR の理由が崩れる。
- 見直す条件: Cloud Run にプローブを設定するとき、定期的な監視でリクエストログが多くなったとき、Next.js が停止時のフックを提供したとき、停止時に後始末（キューの送信など）が必要な処理が入ったとき。

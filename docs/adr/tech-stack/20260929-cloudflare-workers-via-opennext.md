# Next（apps/frontend）は OpenNext（@opennextjs/cloudflare）で Cloudflare Workers に載せ、wrangler.jsonc を正にして GitHub Actions の wrangler でデプロイする

- 日付: 2026-09-29
- 状態: 採用
- 関連: Issue #104 / Issue #129 / Issue #130 / `apps/frontend/wrangler.jsonc` / `apps/frontend/open-next.config.ts` / `apps/frontend/next.config.ts` / `.github/workflows/deploy.yml` / `.claude/rules/frontend.md`

## 背景
デプロイ先が無かった（棚卸しの Issue #104）。構成は Cloudflare を中心にする前提で（Issue #129）、まず Next 16.3.6 の画面・Route Handler・Proxy・instrumentation の register が Workers の上で動くかを確かめる段階（Issue #130）。
アプリは Next 1 プロセスで、backend（`@repo/backend`）は Route Handler から呼ばれ、DB は Postgres（`pg` のグローバル Pool）を使う。IaC を使いたいという要望もあり、Terraform などとの分担も決める必要があった。

## 決定
- `apps/frontend` を OpenNext の Cloudflare 向けアダプタ `@opennextjs/cloudflare`（1.20.6）でビルドし、`wrangler`（4.137.0）で Workers にデプロイする。どちらも `apps/frontend` の devDependencies に置く。
- Worker の定義（名前・compatibility・assets・vars）は `apps/frontend/wrangler.jsonc` を正（source of truth）にする。OpenNext の設定は `apps/frontend/open-next.config.ts`（既定のまま）。
- デプロイは GitHub Actions から wrangler で行う（`.github/workflows/deploy.yml` が `opennextjs-cloudflare build && opennextjs-cloudflare deploy` を実行）。Terraform などの IaC は今は使わない。plan（差分の表示）が必要になった段階で、`cloudflare_worker`（Worker の入れ物）だけを Terraform に出し、コードのアップロードは wrangler のままにする分担にする。

## 理由
- OpenNext で、今のコード（App Router・Route Handler・Proxy・register）を書き換えずにローカルの workerd（`opennextjs-cloudflare preview`）で動かせた（2026-09-29 の work-logs「Issue #130: ローカル preview の実測」）。要った変更は設定だけ（`pnpm-workspace.yaml` の `allowBuilds` に `workerd: false`、`next.config.ts` の `serverExternalPackages: ["pg-cloudflare"]`。WHY は各ファイルのコメント）。
- Cloudflare の IaC のページは、Terraform の例は Workers のバンドルをしないので先に `wrangler deploy --dry-run --outdir` を実行するよう書き、wrangler の設定ファイルを source of truth とするよう勧めている（https://developers.cloudflare.com/workers/platform/infrastructure-as-code/ 、https://developers.cloudflare.com/workers/wrangler/configuration/ ）。OpenNext の出力 `.open-next/worker.js` は複数のファイルを import するので、Terraform だけで載せるには事前のバンドルが要る（2026-09-29 の work-logs「調査結果: Cloudflare Workers への IaC の選択肢」）。
- ユーザーの判断で、デプロイは wrangler で行い、IaC は Terraform にしない（2026-09-29 の work-logs「ユーザー判断: デプロイは wrangler で」）。

## 採用しなかった案
- vinext（Vite の上で Next の API を実装し直したもの）: Cloudflare は Next を Workers で動かす既定の方法として vinext を勧めている（https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/ ）が、同じページのとおり beta で、今回は互換性（`vinext check`）を調べていない。Next 本体のビルドをそのまま使う OpenNext を先に採った。
- Vercel: Cloudflare を中心にする前提（Issue #129）から外れる。
- Terraform / Pulumi を先に入れる: 事前のバンドル、state の置き場所、PR ごとの preview（Terraform に相当する resource が無く、wrangler の `versions upload --preview-alias` などが要る）の 3 点で wrangler だけより複雑になる。Pulumi は Terraform provider のラッパーで同じ制約（2026-09-29 の work-logs）。
- Alchemy: 調べた時点の latest が 2.0.0-beta（プレリリース）で、package.json にプレリリースを書かない規則（`.claude/rules/dependencies.md`）に合わない（2026-09-29 の work-logs）。

## 影響
- 注意: `opennextjs-cloudflare build` は、ビルドした時点のリポジトリ直下と `apps/frontend` の `.env` 系ファイルの値を `.open-next/cloudflare/next-env.mjs` に書き出して Worker に同梱し、`wrangler.jsonc` の vars に無い変数の既定値にする（2026-09-29 の work-logs）。CI のビルドでは `.env` ファイルを置かず、環境変数で渡す。秘密は vars ではなく secret（`wrangler secret put`）で渡す。
- 注意: `instrumentation-node.ts` の `process.exit(1)` は、Workers ではプロセスを止めない。必須の環境変数が欠けると最初のリクエストが 500 になり、以降のリクエストが止まる（2026-09-29 の work-logs）。Node（`next start`）のように起動時に止まる前提は Workers では成り立たない。
- 注意: `apps/backend/shared/infra/database.ts` のグローバル Pool は、Workers ではリクエストをまたいで接続を使えない（https://opennext.js.org/cloudflare/howtos/db 。ローカル DB で 200 と 500 が交互になった。2026-09-29 の work-logs）。DB を繋ぐ段階で、リクエストごとの client（Hyperdrive）に変える（別 Issue）。
- 注意: Node の middleware（Next の Proxy）は OpenNext では experimental（ビルドが「Node.js middleware support is experimental in cloudflare」と警告する）。
- 未確認: Workers Free の CPU 時間 10 ms に収まるか（未計測）。
- 悪い点: Node の `next build` と `opennextjs-cloudflare build` の 2 つのビルドを保つことになる（`pnpm build` + E2E は Node、Workers はローカルの preview）。生成物 `.open-next/`・`.wrangler/` を `rule-tests/architecture.test.ts` の検査から除く（`EXCLUDED_DIRS`）。
- 見直す条件: vinext が beta を外れたとき、上の制約（DB の接続・`process.exit`・CPU 時間）が重いと分かったとき、クラウドの選択を見直すとき（GCP の Cloud Run などとの比較は別 Issue）。plan が必要になったら `cloudflare_worker` だけを Terraform に出す。

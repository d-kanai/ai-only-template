# Cloud Run 用のコンテナイメージ（Issue #137）。1 つの Dockerfile から 2 つのイメージを --target で作り分ける:
#   - runtime: Cloud Run のサービス（Next.js の画面と API）。docker build --target runtime .
#   - migrate: Cloud Run のジョブ（pnpm db:migrate で Cloud SQL にマイグレーションを当てる）。docker build --target migrate .
# ステージ: deps（依存の取得とインストール）→ build（next build）→ runtime（standalone だけを載せる）/ deps → migrate。
# WHY 1 つの Dockerfile にするか: 2 つのイメージが同じ lockfile・同じ依存のインストール（deps ステージ）を共有し、
#   片方だけ依存がずれることを防ぐ。
# WHY `# syntax=docker/dockerfile:1` を書かないか: 書くと BuildKit がビルドのたびに Docker Hub から docker/dockerfile の
#   イメージを取りに行き、Docker Hub の匿名 pull のレート制限（compose.yaml のコメント）に当たりうる。
#   使う機能（RUN --mount=type=cache）は BuildKit に組み込みの Dockerfile フロントエンドで使える。
# ビルドの前提: リポジトリ直下をコンテキストにする（docker build . ）。コンテキストから外すものは .dockerignore。
#   テストだけが使うコード（apps/*/test-support/）とテスト（*.test.ts / *.test.tsx）も外し、どのステージにも入れない（Issue #181。
#   WHY と検査は .dockerignore のコメント）。
# 秘密はイメージに入れない: 接続先などの環境変数（.env.example の DATABASE_* など）は、実行時に Cloud Run のサービス・ジョブが渡す。
#   .env は .dockerignore でコンテキストから外し、build ステージで一時的に作るものも同じ RUN の中で消す。

# NODE_IMAGE: すべてのステージの元にする Node.js の公式イメージ（Debian slim 版）。
# WHY 24.21.0: .tool-versions の nodejs と同じ版にし、手元・CI とコンテナで同じ Node で動かす（.claude/rules/env.md）。
#   .tool-versions を変えたらここも変える。
# WHY slim: Node の実行に要るものだけの Debian で、フル版より小さい。alpine（musl）にしないのは、next の依存の sharp などの
#   ネイティブのバイナリを手元・CI（glibc）と同じ種類にするため。
# WHY mirror.gcr.io から取るか: Docker Hub の匿名 pull のレート制限を避ける（compose.yaml の postgres と同じ理由）。
#   中身は Docker Hub の library/node と同じ。
# WHY ダイジェストで固定しないか: Node の版はタグで固定しており、同じタグの OS パッケージの更新（セキュリティ修正）は取り込みたい
#   （compose.yaml の postgres と同じ方針）。
ARG NODE_IMAGE=mirror.gcr.io/library/node:24.21.0-slim

# ---- deps: pnpm を用意し、lockfile どおりに依存をインストールする（devDependencies を含む。build と migrate が使う） ----
FROM ${NODE_IMAGE} AS deps
# CI=true: pnpm を非対話にし（確認のプロンプトを出さない）、lockfile の更新をしない CI の動きにする。
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0: corepack が pnpm を取得するときの確認（y/n）を出さない。
# TZ=UTC: next build と drizzle-kit をアプリの実行時と同じ UTC で動かす（package.json の dev / start、E2E の webServer と同じ）。
# NEXT_TELEMETRY_DISABLED=1: next build が Vercel に利用状況を送らない。
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TZ=UTC \
    NEXT_TELEMETRY_DISABLED=1
# /repo: リポジトリ直下に当たるディレクトリ。pnpm workspace（apps/*）をそのままの形で置く。
WORKDIR /repo
# package.json だけを先にコピーし、corepack で packageManager（pnpm@12.7.0）の pnpm を取得する。
# WHY corepack install（版を引数に書かない）: pnpm の版を package.json の packageManager 1 か所から決め、ここに重ねて書かない。
# WHY package.json だけ先にコピーするか: ソースを変えても package.json が変わらなければ、このレイヤーのキャッシュが効く。
COPY package.json ./
RUN corepack enable pnpm && corepack install
# lockfile・workspace の設定（patchedDependencies など）・patch だけをコピーし、pnpm fetch で依存のパッケージを store に取得する。
# WHY pnpm fetch を先にするか: lockfile から取得するので（pnpm 12.7.0 の pnpm fetch --help「Fetch packages from the lockfile」）、
#   ソースを変えただけのビルドでは、このレイヤーのキャッシュが効いてダウンロードをやり直さない。
# --mount=type=cache: store（/pnpm-store）をビルドの間で使い回すキャッシュにし、イメージのレイヤーには入れない。
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm fetch --store-dir /pnpm-store
# ソースをすべてコピーし、store から node_modules を作る。
# --frozen-lockfile: lockfile と package.json がずれていたら失敗させる（lockfile を書き換えない）。
# --offline: store にあるものだけを使い、ネットワークに出ない（上の pnpm fetch で取得済みのはず。無ければ失敗して気づける）。
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --offline --store-dir /pnpm-store

# ---- build: next build で standalone を作る ----
FROM deps AS build
# next build は途中でサーバのコードを読み込み、@repo/shared/env が DATABASE_* などの必須の環境変数を検証するので、値が無いと失敗する。
# ビルドには開発用の値（.env.example。秘密ではない）を .env にして渡し、同じ RUN の中で消す。
# WHY 同じ RUN の中で消すか: 別の命令にするとレイヤーに .env が残る。消しておけば runtime にも migrate にも入らない
#   （runtime は .next/standalone だけをコピーし、migrate は deps から作るので、そもそもこの .env を通らない）。
# WHY pnpm build（リポジトリ直下の script）: pnpm --filter @repo/frontend-customer --fail-if-no-match build を呼ぶ。
#   手元・CI・E2E と同じ入口にする。
RUN cp .env.example .env && pnpm build && rm .env

# ---- migrate: Cloud Run のジョブで pnpm db:migrate（drizzle-kit migrate）を実行するイメージ ----
# WHY deps から作るか: drizzle-kit は devDependencies で、drizzle.config.ts・マイグレーションの SQL（apps/backend/shared/drizzle/）と
#   @repo/shared/env のソースも要る。standalone には入らない。
# 環境変数（DATABASE_* など）はジョブから渡す。.env は無い（.dockerignore で外している）ので、足りなければ drizzle.config.ts の
#   読み込み（@repo/shared/env）が名前を挙げて失敗する。
FROM deps AS migrate
# WHY USER node にせず root のままにするか: pnpm 12.7.0 は pnpm install で node_modules/.pnpm-workspace-state-v1.json を
#   root だけが読める権限（0600）で作る。node で pnpm db:migrate を実行すると、この状態を読めずに依存を入れ直そうとし、
#   「ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR ... Permission denied」で失敗した（2026-09-30 実測）。
#   採らなかった案: chown -R node:node /repo は、所有者を変えた全ファイルを新しいレイヤーに書き直すので、node_modules の分だけ
#   イメージが大きくなる（大きさは未計測）。そのファイルだけ chmod a+r すると node でも動いたが（同日実測）、pnpm の内部の
#   ファイル名と権限の作り方に頼り、pnpm の更新で実行時に壊れうる。
#   root で動かしても、ジョブは DB にマイグレーションを当てて終わるだけで、外からのリクエストを受けない。
# WHY pnpm db:migrate（リポジトリ直下の script）: 手元・CI・クラウドセッションと同じ入口（db-migration スキル）にする。
CMD ["pnpm", "db:migrate"]

# ---- runtime: Cloud Run のサービス。next build の standalone（server.js とトレースした依存）だけを載せる ----
# WHY deps / build から作らないか: pnpm・devDependencies・ソース・ビルドの途中物を載せず、イメージを小さくし、
#   実行に要らないものを本番に置かない。
FROM ${NODE_IMAGE} AS runtime
# NODE_ENV=production: React・Next.js を本番の動きにする。
# TZ=UTC: サーバのタイムゾーン。instrumentation-node.ts の verifyTimeZoneAtStartup が UTC でなければ起動を止める
#   （package.json の start の TZ=UTC と同じ）。
# NEXT_TELEMETRY_DISABLED=1: Vercel に利用状況を送らない。
# HOSTNAME=0.0.0.0: server.js が待ち受けるアドレス。WHY: 既定のままだとコンテナの外（Cloud Run の転送）から届かない
#   （next 16.3.6 同梱の output.md は PORT と HOSTNAME で待ち受けを変える例を挙げている）。
# PORT=8080: server.js が待ち受けるポート。Cloud Run は PORT を注入する（既定 8080）ので、その値で上書きされる。
#   ここの値は docker run で手元で動かすときの既定。
ENV NODE_ENV=production \
    TZ=UTC \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=8080
WORKDIR /app
# standalone（apps/frontend_customer/server.js・トレースした node_modules）をそのままの形で /app に置く。
# .next/static（ブラウザに配る JS・CSS）は standalone に含まれないので、server.js が配れる場所に別にコピーする
#   （next 16.3.6 同梱の output.md）。public ディレクトリは apps/frontend_customer に無いのでコピーしない（作ったら足す）。
# --chown=node:node: WHY: Next のサーバは実行中に .next/cache に書き込むことがあり、USER node で書けるようにする。
COPY --from=build --chown=node:node /repo/apps/frontend_customer/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/frontend_customer/.next/static ./apps/frontend_customer/.next/static
# USER node: 公式イメージにある一般ユーザー。WHY: root で動かさず、アプリが乗っ取られたときの影響を小さくする。
USER node
# EXPOSE: 待ち受けるポートの記録（公開の設定ではない）。PORT の既定と同じ 8080。
EXPOSE 8080
# WHY node で server.js を直接起動するか（pnpm start / next start にしないか）: standalone の起動方法で、pnpm も next の CLI も
#   イメージに無い。起動時の検査（環境変数・タイムゾーン）は instrumentation.ts の register が server.js でも行う。
CMD ["node", "apps/frontend_customer/server.js"]

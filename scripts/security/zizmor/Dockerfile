# zizmor を動かすイメージ。scripts/security/scan.sh が初回に docker build し、以後はキャッシュを使う。
# WHY 自前のイメージ: zizmor の公式イメージは ghcr.io だけで、クラウドセッションのプロキシは ghcr.io の blob の取得を
#   403 で拒否した（2026-10-03 実測）。Docker Hub の python イメージに PyPI からハッシュ付きで入れる。
# python:3.13-slim は digest で固定する（タグは差し替えられる。Actions の SHA 固定と同じ考え）。
FROM python:3.13-slim@sha256:bb2988715db2cf7ace7b53f38f3cffbef7c7046a656bee66245eb0ed386e2e81
COPY requirements.txt /tmp/requirements.txt
# --only-binary: sdist（ソースからのビルド）を使わず wheel だけを入れる。--no-cache-dir: イメージに pip のキャッシュを残さない。
# secret pip_cert: TLS を中継するプロキシの CA（クラウドセッションの PIP_CERT）。scan.sh が PIP_CERT のあるときだけ渡す。
#   WHY: クラウドセッションのプロキシは TLS を独自の CA で中継し、コンテナの中の pip はその CA を信頼しないので PyPI に
#   つながらない（2026-10-03 実測。/root/.ccr/README.md の「docker build」）。secret はイメージの層に残らない。
RUN --mount=type=secret,id=pip_cert,required=false \
    if [ -f /run/secrets/pip_cert ]; then export PIP_CERT=/run/secrets/pip_cert; fi; \
    pip install --no-cache-dir --only-binary :all: --require-hashes -r /tmp/requirements.txt
# 一般ユーザーで動かす（root で動かさない。hadolint / Trivy の Dockerfile の検査にも合わせる）。
USER 65534:65534
ENTRYPOINT ["zizmor"]

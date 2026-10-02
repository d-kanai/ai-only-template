#!/usr/bin/env bash
# 構成図の元（<dir>/*.mmd。Mermaid）をすべて同じ名前の .png にし、元の無い .png を消す（Issue #324）。
# 使い方: bash scripts/render-diagrams.sh [<dir>]   # 既定の dir は docs/diagrams
# 図の元を書き直す手順（何を Terraform と deploy.yml から読むか）はスキル infra-diagram（.claude/skills/infra-diagram/SKILL.md）。
#
# 環境変数:
#   PUPPETEER_EXECUTABLE_PATH  描画に使う Chrome / Chromium。無ければ E2E の Playwright が使う Chromium（apps/e2e）。
#                              WHY Playwright の Chromium を借りる: mermaid-cli は puppeteer で描画し、puppeteer は自分用の
#                              Chrome を取得しようとする。E2E のために入れた Chromium があれば、もう 1 つ取得しなくてよい。
#   MMDC                       mermaid-cli を呼ぶコマンド（テストで差し替える。既定は下の MMDC_DEFAULT）。
set -euo pipefail

# WHY pnpm dlx で版を固定して呼ぶ（devDependencies に入れない）: mermaid-cli は puppeteer など 190 個ほどの依存を連れてきて、
#   CI と全員の pnpm install が重くなる。図を作り直すときにだけ要るので、そのときに取得する。
# WHY 12.0.0: 2026-10-02 の latest（公開 2026-09-24。minimumReleaseAge の 5 日を過ぎている。`npm view @mermaid-js/mermaid-cli time`）。
MMDC_DEFAULT="pnpm dlx @mermaid-js/mermaid-cli@12.0.0"
MMDC="${MMDC:-$MMDC_DEFAULT}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dir="${1:-$repo_root/docs/diagrams}"

if [ -n "${PUPPETEER_EXECUTABLE_PATH:-}" ]; then
  browser="$PUPPETEER_EXECUTABLE_PATH"
else
  browser="$(cd "$repo_root/apps/e2e" && node -e 'process.stdout.write(require("@playwright/test").chromium.executablePath())' 2>/dev/null || true)"
fi
if [ -z "$browser" ] || [ ! -x "$browser" ]; then
  echo "render-diagrams: Chromium が見つからない（${browser:-未設定}）。PUPPETEER_EXECUTABLE_PATH に Chrome / Chromium のパスを渡す" >&2
  exit 1
fi

shopt -s nullglob
sources=("$dir"/*.mmd)
# WHY 0 件で失敗する: dir の指定違いで何も描かずに成功したように見えるのを防ぐ。
if [ ${#sources[@]} -eq 0 ]; then
  echo "render-diagrams: $dir に .mmd が無い" >&2
  exit 1
fi

# WHY --no-sandbox: クラウドセッションや CI のコンテナは root で動き、root の Chromium は sandbox 付きでは起動しない。
#   描くのは自分のリポジトリの図だけで、外のページを開かない。
config="$(mktemp)"
trap 'rm -f "$config"' EXIT
printf '{"executablePath":"%s","args":["--no-sandbox"]}\n' "$browser" >"$config"

for source in "${sources[@]}"; do
  # -s 2: 2 倍の解像度（GitHub の画面で文字がにじまない）。-b white: 透明にすると GitHub のダークテーマで黒い文字が読めない。
  $MMDC -p "$config" -i "$source" -o "${source%.mmd}.png" -s 2 -b white -q
  echo "render-diagrams: ${source%.mmd}.png"
done

# 元の .mmd を消した・改名したときに、古い画像が残らないようにする。
for image in "$dir"/*.png; do
  if [ ! -f "${image%.png}.mmd" ]; then
    rm "$image"
    echo "render-diagrams: removed $image"
  fi
done

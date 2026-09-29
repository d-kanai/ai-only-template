import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// OpenNext（@opennextjs/cloudflare）の設定（Issue #130）。opennextjs-cloudflare build が読む。
// WHY 既定のまま（引数なし）: Issue #130 は Workers 上で動くかを確かめる段階で、キャッシュ（R2 の incremental cache など）は使わない。
//   ファイルが無くても build が作るが、作られたファイルが未追跡で残らないよう、同じ内容をコミットしておく
//   （https://opennext.js.org/cloudflare/get-started の「4. Add an open-next.config.ts file」）。
export default defineCloudflareConfig();

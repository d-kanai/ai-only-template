// 応答に付けるセキュリティヘッダの値を決める（Issue #106）。付けるのは next.config.ts（すべての応答に付ける common）と
//   proxy.ts（画面の応答に、要求ごとの nonce を入れた Content-Security-Policy）。
// 決定と採用しなかった案は ADR docs/adr/architecture/20261003-security-headers-and-same-origin-api.md。
// WHY 値をここに集める（next.config.ts・proxy.ts に直接書かない）: 2 つの規約ファイルは単体テストのカバレッジの外
//   （vitest.config.mts）で、値を変えても気づけない。ここなら値をテストで丸ごと固定でき、付いていることは E2E
//   （apps/e2e/spec/security-headers.feature）が本番のビルドで確かめる。
// WHY クラスの static メソッドにする: frontend の React 以外のモジュールもクラスを基本にする（規則 class-based。
//   ADR docs/adr/architecture/20261002-class-based-frontend-modules.md）。状態を持たないのでインスタンスは作らない。
// proxy.ts が画面の要求に載せ、app/layout.tsx が読む nonce のリクエストヘッダの名前（Next の CSP の文書の例と同じ名前）。
// WHY 定数で共有する: 書く側と読む側で名前がずれると、layout が nonce を受け取れず Mantine の配色のスクリプトが CSP で止まる。
export const NONCE_HEADER = "x-nonce";

export class SecurityHeaders {
  // 画面の応答の Content-Security-Policy。nonce は要求ごとに作り直す値（SecurityHeaders.nonce）。
  // 中身は Next.js 16.3.6 同梱の node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md の「Adding a nonce with Proxy」の
  //   例を基にし、違うところに WHY を書く。
  // - script-src に nonce と 'strict-dynamic': nonce の付いたスクリプトと、それが読み込んだスクリプトだけを動かす（XSS で差し込まれた
  //   <script> は nonce を知らないので動かない）。Next は要求の Content-Security-Policy ヘッダから nonce を読み、自分のスクリプトに
  //   付ける（同じ文書の「How nonces work in Next.js」）。nonce を使うには画面が動的レンダリングである必要があるが、root layout が
  //   headers() を読むので全画面がすでに動的（.claude/rules/code/frontend.md の「i18n」の限界）。
  // - 'unsafe-eval' は開発のときだけ: React が開発時に eval でサーバのエラーのスタックを組み立てる（同じ文書の「Good to know」）。
  //   本番の React と Next は eval を使わない。
  // - style-src は 'unsafe-inline'（nonce にしない。文書の例との違い）: Mantine（デザインシステム。Issue #292）は部品の見た目を
  //   style 属性（CSS 変数）で付け、MantineProvider がテーマの CSS 変数を <style> で差し込む。CSP の nonce は style 属性には効かず、
  //   style-src に nonce を書くと 'unsafe-inline' が無視されて style 属性が止まる（CSP Level 3 の仕様。https://www.w3.org/TR/CSP3/#allow-all-inline ）。
  //   CSS の差し込みでできるのは見た目の改変と、属性セレクタで値を外に送ることくらいで、外への送信は img-src・font-src・connect-src
  //   を 'self' に絞って塞ぐ。スクリプトの実行は script-src の nonce が止める。
  // - connect-src 'self': 画面の fetch（/api/**・OFREP の /api/ofrep/**）は同じオリジンだけ。default-src と同じ値だが、外への送信を
  //   塞ぐ意図を読めるように明示する。
  // - frame-ancestors 'none': ほかのサイトの iframe に入れさせない（クリックジャッキング）。古いブラウザ向けに X-Frame-Options も付ける（common）。
  // - upgrade-insecure-requests を付けない（文書の例との違い）: 読み込む先は同じオリジンだけで、本番は HTTPS と HSTS（common）で
  //   守る。付けると http で動かすローカル・E2E（next start）でも同じオリジンの読み込みを https に書き換え、画面が壊れる。
  // WHY 関数の中で組み立てる（最上位の定数にしない）: 最上位の値は Stryker の static な変異になり、ignoreStatic で検査から外れる。
  static contentSecurityPolicy(nonce: string, development: boolean): string {
    const scriptSources = [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      ...(development ? ["'unsafe-eval'"] : []),
    ];
    return [
      "default-src 'self'",
      `script-src ${scriptSources.join(" ")}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "font-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; ");
  }

  // 要求ごとの nonce。乱数の UUID（122 ビット）を base64 にする（CSP の nonce は base64 の値。同じ文書の例と同じ作り方）。
  // WHY 乱数を引数で受け取る: 値をテストで決められるようにする。proxy.ts が crypto.randomUUID を渡す。
  static nonce(randomUUID: () => string): string {
    return btoa(randomUUID());
  }

  // すべての応答（画面・API・静的ファイル）に付けるヘッダ。next.config.ts の headers() がそのまま使う形（key と value）。
  // - Strict-Transport-Security: 2 年（hstspreload.org が preload の条件にする最小の 1 年より長くする）、サブドメインも。
  //   preload は付けない（ブラウザに焼き込まれ、取り消しに数か月かかる。ドメインが決まってから判断する）。
  //   http の応答の HSTS はブラウザが無視する（RFC 6797 の 8.1）ので、ローカルの http には効かない。
  // - X-Content-Type-Options: nosniff: Content-Type と違う種類として解釈させない（JSON を HTML として描かせない）。
  // - Referrer-Policy: ほかのサイトにはオリジンだけを送り、パスとクエリ（Todo の id）を送らない（ブラウザの既定と同じ値を明示する）。
  // - X-Frame-Options: DENY: CSP の frame-ancestors を解さない古いブラウザ向け。CSP の無い API・静的ファイルの応答にも効く。
  // - Permissions-Policy: 使わない機能（カメラ・マイク・位置情報）を止め、差し込まれたスクリプトや iframe にも使わせない。
  // - Cross-Origin-Opener-Policy: same-origin: 別のサイトから window.open で開かれても、開いた側から window を触らせない。
  static common(): { key: string; value: string }[] {
    return [
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains",
      },
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      { key: "X-Frame-Options", value: "DENY" },
      {
        key: "Permissions-Policy",
        value: "camera=(), microphone=(), geolocation=()",
      },
      { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    ];
  }
}

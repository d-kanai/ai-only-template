// API は同じオリジンの画面からだけ呼ぶ（Issue #106）。別のオリジンのページからの書き込みを拒否する判定。
// 決定と採用しなかった案は ADR docs/adr/architecture/20261003-security-headers-and-same-origin-api.md。
// WHY CORS のヘッダ（Access-Control-Allow-Origin）を返さないだけでは足りない: CORS が止めるのは別のオリジンのページが
//   「応答を読む」ことで、要求そのものは届く。フォームの POST や Content-Type を text/plain にした fetch はプリフライト無しで
//   送られるので、読めなくても Todo が作られる・消される（CSRF）。書き込みは Origin を見て、サーバ側で止める。
// WHY Origin を見る（CSRF トークンにしない）: ブラウザは POST / PUT / PATCH / DELETE の要求に必ず Origin を付け、ページの
//   スクリプトは書き換えられない（Fetch Standard の「append a request `Origin` header」。https://fetch.spec.whatwg.org/#origin-header ）。
//   ログインもセッションも無い今は、トークンを配る仕組みを持つより軽い。OWASP の CSRF Prevention Cheat Sheet も
//   「Verifying Origin With Standard Headers」を多層の防御の 1 つに挙げている。
// WHY Origin の無い要求は通す: ブラウザは書き込みに必ず Origin を付けるので、無いのはブラウザ以外（curl・サーバからの呼び出し・
//   E2E の Playwright の request）で、CSRF（利用者のブラウザに要求を送らせる攻撃）にはならない。
// WHY Host と X-Forwarded-Proto と比べる（request.url と比べない）: Cloud Run は前段で TLS を終え、アプリには http で届くので、
//   request.url のスキームは http になる。前段が受けたスキームは X-Forwarded-Proto に載る（Next.js 16.3.6 の
//   base-server.js は、前段が付けた値を残し、無ければ自分が受けたスキームを入れる `??=`）。スキーム・ホスト名・ポートが
//   すべて同じなら同じオリジンの画面とみなす。
// WHY スキームも比べる（Codex の指摘、PR #366）: http と https は別のオリジン。同じホストの http のページ（HSTS が効く前の
//   最初の訪問・経路で書き換えられたページ）から https の API への書き込みを、ホストだけで比べると通してしまう。
// WHY X-Forwarded-Proto を信じてよい: ブラウザのページは、別のオリジンへの要求にこのヘッダを付けるとプリフライトになり、
//   許可のヘッダを返さないので本体は送られない。フォームの POST は任意のヘッダを付けられない。偽れるのはブラウザ以外
//   （curl など）で、それは Origin も偽れるので CSRF の対策の対象外。値が複数（`https, http`）なら最初の値（利用者に近い前段）を使う。区切りの後の空白は
//   `split` の最初の値に入らないので trim しない（区切りの前に空白がある `https ,http` は一致せず拒否する。止めすぎる方向）。
// 限界: Host の大文字小文字と既定のポートの明示（app.example.com:443）は正規化しないので、プロキシがそう書き換えると同じオリジンでも
//   拒否する（止めすぎる方向。ブラウザは Host を小文字・既定のポート無しで送る）。前段のプロキシが Host を書き換える構成（ロードバランサで別のホスト名に転送するなど）では、同じオリジンの画面も拒否する
//   （今の Cloud Run の構成で Host が保たれるかは未確認。デプロイ先で画面から書き込めることを確かめる）。前段が
//   X-Forwarded-Proto を付けない（Next が自分の受けた `http` を入れる）・大文字（`HTTPS`）で付ける構成でも、https の画面の
//   書き込みを拒否する（Cloud Run が `https` を付けるかは未確認）。
// WHY クラスの static メソッドにする: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。状態を持たない判定なので static にする。
export class SameOrigin {
  // 拒否するなら true。ProblemResponse.wrap が handler の前に呼び、true なら 403 の Problem Details を返す。
  static rejects(request: Request): boolean {
    if (SameOrigin.isReadOnly(request.method)) {
      return false;
    }
    const origin = request.headers.get("origin");
    if (origin === null) {
      return false;
    }
    const host = request.headers.get("host");
    return (
      host === null ||
      SameOrigin.originOf(origin) !== `${SameOrigin.schemeOf(request)}//${host}`
    );
  }

  // 前段が受けたスキーム（`https:` の形）。X-Forwarded-Proto が無ければ要求の URL のスキーム（Next を前段無しで動かすとき・テスト）。
  private static schemeOf(request: Request): string {
    const forwarded = request.headers.get("x-forwarded-proto");
    if (forwarded === null) {
      return new URL(request.url).protocol;
    }
    return `${forwarded.split(",")[0]}:`;
  }

  // WHY 読み取り（GET / HEAD / OPTIONS）は拒否しない: 状態を変えず、別のオリジンのページは CORS により応答を読めない
  //   （Access-Control-Allow-Origin を返さない）。OPTIONS はプリフライトで、拒否しなくても許可のヘッダが無いので本体は送られない。
  private static isReadOnly(method: string): boolean {
    return ["GET", "HEAD", "OPTIONS"].includes(method);
  }

  // Origin のスキームとホスト名とポート（`https://app.example.com`。既定のポートは省かれる）。"null"（サンドボックスの iframe・
  //   file:// のページ）など URL として読めない値は、どの要求とも一致しない null にして拒否する。
  private static originOf(origin: string): string | null {
    if (!URL.canParse(origin)) {
      return null;
    }
    const url = new URL(origin);
    return `${url.protocol}//${url.host}`;
  }
}

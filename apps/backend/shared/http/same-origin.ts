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
// WHY Host と比べる（request.url と比べない）: Cloud Run は前段で TLS を終え、アプリには http で届く。ブラウザの Origin は
//   https なので、スキームまで比べると同じオリジンの画面も拒否する。ホスト名とポートが Host と同じなら同じサイトの画面とみなす。
// 限界: Host の大文字小文字と既定のポートの明示（app.example.com:443）は正規化しないので、プロキシがそう書き換えると同じオリジンでも
//   拒否する（止めすぎる方向。ブラウザは Host を小文字・既定のポート無しで送る）。前段のプロキシが Host を書き換える構成（ロードバランサで別のホスト名に転送するなど）では、同じオリジンの画面も拒否する
//   （今の Cloud Run の構成で Host が保たれるかは未確認。デプロイ先で画面から書き込めることを確かめる）。
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
    return host === null || SameOrigin.hostOf(origin) !== host;
  }

  // WHY 読み取り（GET / HEAD / OPTIONS）は拒否しない: 状態を変えず、別のオリジンのページは CORS により応答を読めない
  //   （Access-Control-Allow-Origin を返さない）。OPTIONS はプリフライトで、拒否しなくても許可のヘッダが無いので本体は送られない。
  private static isReadOnly(method: string): boolean {
    return ["GET", "HEAD", "OPTIONS"].includes(method);
  }

  // Origin のホスト名とポート（既定のポートは省かれる）。"null"（サンドボックスの iframe・file:// のページ）など URL として
  //   読めない値は、どの Host とも一致しない null にして拒否する。
  private static hostOf(origin: string): string | null {
    return URL.canParse(origin) ? new URL(origin).host : null;
  }
}

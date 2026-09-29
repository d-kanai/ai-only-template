// Next.js の規約ファイル（instrumentation）。register は、サーバ（next start / next dev）の起動時に 1 回だけ呼ばれ、
// リクエストを受け付ける前に完了する（Next.js 16.3.6 同梱ドキュメント
// node_modules/next/dist/docs/01-app/02-guides/instrumentation.md の「Convention」）。
// 置き場所はルート直下。app/ の中には置けない（同ドキュメントの「Good to know」）。
// 起動時にする処理（環境変数の検証とタイムゾーンの検査）の本体は instrumentation-node.ts（Node.js runtime 専用）に置き、
// ここは runtime の判定だけにする。
export async function register(): Promise<void> {
  // WHY Node.js runtime のときだけ読み込む: register は Edge runtime 向けにもビルドされる（同ドキュメントの
  //   「Importing runtime-specific code」）。分岐が無いと、Edge 向けのビルドに env.ts の process.loadEnvFile や
  //   process.exit が入り、next build が「A Node.js API is used (...) which is not supported in the Edge Runtime」の警告を出した
  //   （2026-09-28 実測）。このアプリは Edge で動くコードを持たないので、Edge では何もしない。
  // WHY ここだけ process.env を直接読む: NEXT_RUNTIME は Next.js がビルド時に値を埋め込む規約の変数で、この形で書くと
  //   Edge 向けのビルドから import が消える（同ドキュメントの例と同じ書き方）。env.ts 経由にすると、判定の前に env.ts を
  //   読み込むことになり分岐の意味がない。例外はこの NEXT_RUNTIME だけ（rule-tests/architecture.test.ts の env-direct-access も同じ）。
  // biome-ignore lint/style/noProcessEnv: Next.js の規約の NEXT_RUNTIME（ビルド時に埋め込まれる）。env.ts 経由では分岐できない
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { verifyEnvAtStartup, verifyTimeZoneAtStartup } = await import(
      "./instrumentation-node"
    );
    await verifyEnvAtStartup();
    verifyTimeZoneAtStartup();
  }
}

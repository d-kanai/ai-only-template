// Next.js の規約ファイル（instrumentation）。register は、サーバ（next start / next dev）の起動時に 1 回だけ呼ばれ、
// リクエストを受け付ける前に完了する（Next.js 16.3.6 同梱ドキュメント
// node_modules/next/dist/docs/01-app/02-guides/instrumentation.md の「Convention」）。
// 置き場所はルート直下。app/ の中には置けない（同ドキュメントの「Good to know」）。
//
// WHY ここで env.ts を読み込む（Issue #59）: env.ts は読み込み時に必須の環境変数を検証するが、それを読み込む API の route は
//   最初のリクエストまで読み込まれない。そのままだと next start / next dev は Ready になり、変数が欠けていても最初の
//   /api/todos が 500 になるまで気づけない（2026-09-28 実測）。register の中で読み込めば、起動時に欠けた変数の名前を出して止まる。
// WHY register の中で import する（ファイルの先頭で import しない）: 同ドキュメントの「Importing files with side effects」の推奨どおり、
//   副作用（.env の読み込みと検証）を register の実行に閉じ込めるため。
// WHY NEXT_RUNTIME で分岐しない: register は Edge runtime でも呼ばれうる（同ドキュメントの「Importing runtime-specific code」）が、
//   このアプリは middleware / proxy も Edge の route も持たず、Node.js runtime だけで動く。Edge を使うようになったら、
//   env.ts（process.loadEnvFile を使う）を Node.js のときだけ読み込むよう分岐を足す。
export async function register(): Promise<void> {
  await import("@/backend/shared/infra/env");
}

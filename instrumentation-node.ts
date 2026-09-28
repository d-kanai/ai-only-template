// サーバ（next start / next dev）の起動時に、Node.js runtime でだけ実行する処理。instrumentation.ts の register が
// NEXT_RUNTIME === "nodejs" のときに import する（Next.js 16.3.6 同梱ドキュメント
// node_modules/next/dist/docs/01-app/02-guides/instrumentation.md の「Importing runtime-specific code」と同じ分け方）。
//
// WHY 起動時に env.ts を読み込む（Issue #59）: env.ts は読み込み時に必須の環境変数を検証するが、それを読み込む API の route は
//   最初のリクエストまで読み込まれない。そのままだと next start / next dev は動き続け、変数が欠けていても最初の
//   /api/todos が 500 になるまで気づけない（2026-09-28 実測）。ここで読み込み、欠けていれば起動エラーにする。
// WHY 失敗したら自分でプロセスを終える: register が失敗しても、next start は「Failed to prepare server」を出すだけで
//   動き続けた（Next.js 16.3.6、2026-09-28 実測。終了コードは返らない）。欠けた変数の名前を含むエラーを出し、非 0 で止める。
// WHY import を try の中の dynamic import にする: 静的な import だと、このモジュールの読み込みそのものが失敗し、
//   catch で終了コードを決められないため。
export async function verifyEnvAtStartup(): Promise<void> {
  try {
    await import("@/backend/shared/infra/env");
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

import { logger } from "@repo/shared/logger";

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
// WHY logger を静的に import してよい: logger は env.ts を含め何も import しないので、環境変数が欠けていても読み込みに失敗しない。
export async function verifyEnvAtStartup(): Promise<void> {
  try {
    await import("@repo/shared/env");
  } catch (error) {
    // ログはすべて logger を通す（Issue #85）。Error は { type, message } になり、欠けた変数の名前は message に入る（env.ts）。
    // WHY 英語: サーバのログは運用者向けで、画面の辞書（shared/i18n/）の対象外。運用者向けの文言は英語にそろえる（Issue #116）。
    // WHY event.name を app_start_failed にする（Issue #209。apps/shared/log-event.ts）: 起動できなかった理由（環境変数・TZ）を
    //   1 つの種類で引ける。デプロイ直後に新しいリビジョンが立ち上がらないときに最初に見る行。
    logger.error({
      message: "Environment variable validation failed at startup",
      event: { name: "app_start_failed" },
      error,
    });
    process.exit(1);
  }
}

// サーバのタイムゾーンが UTC でなければ、起動エラーにする（Issue #116）。
// WHY UTC に固定する: DB は timestamptz（UTC）で持ち、API は ISO 8601（UTC の Z 付き）で返す。サーバのローカル時刻に依存する処理が
//   入っても、環境（開発者の端末は Asia/Tokyo、本番・CI は UTC など）で結果が変わらないようにする。日時を利用者のタイムゾーンで
//   出すのはブラウザ（features/todo/components/todo-item.tsx）。
// WHY 起動時に止める（警告で続けない）: 環境変数の検証（verifyEnvAtStartup）と同じく、ずれたまま動き続けると後で気づけない。
//   package.json の dev / start は TZ=UTC を付けて起動するので、それ以外の起動（next start の直接実行など）で TZ を付け忘れたときに止まる。
// WHY Intl の解決結果で見る（process.env.TZ を見ない）: TZ が無くても OS の設定が UTC なら問題なく、TZ が "Etc/UTC" などの
//   別名でも Intl は "UTC" に解決する。実際に使われるタイムゾーンを確かめる。
export function verifyTimeZoneAtStartup(): void {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (timeZone !== "UTC") {
    logger.error({
      message: "The server time zone must be UTC; start the server with TZ=UTC",
      event: { name: "app_start_failed" },
      // WHY snake_case: ログのキーは OTel semconv に倣って snake_case にそろえる（.claude/rules/backend.md の「ログ」）。
      time_zone: timeZone,
    });
    process.exit(1);
  }
}

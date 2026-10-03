// リクエストログ（page_request / api_request）の行の形（log-event.ts の LOG_EVENT_SCHEMAS が使う）。
// WHY log-event.ts から分けた（Issue #384）: 本番のコードは 1 ファイル 1 クラス（Biome の style/noExcessiveClassesPerFile）・
//   1 ファイル 300 行以内（style/noExcessiveLinesPerFile）にする。log-event.ts（種類の一覧とスキーマ）と同じく exports に
//   置かない内部のファイルで、apps/shared の中から相対パスで読む（.claude/rules/code/shared.md）。

import { z } from "zod";
import { LogFieldMarks } from "./log-field-marks";

// WHY クラスにする: LogFieldMarks と同じ（Issue #262）。page_request と api_request の 2 種類が同じ形を使う。
// WHY export する（Issue #384）: log-event.ts から読むため。exports には置かず、apps/shared の外からは参照できない。
export class RequestLogSchema {
  // リクエストログ（page_request / api_request）の形。項目と取り方は apps/frontend_customer/shared/request-log/request-log.ts。
  // 印（Issue #216）:
  //   - sensitive: url.query の値（検索語・メールアドレス・トークンなど利用者の入力）、referer（URL のクエリを含みうる）、
  //     client.address（接続元の IP アドレス。GDPR では個人データ）。
  //   - freeText: message と url.path（パスは利用者が決められ、/users/<メール> のような形がありうる）と url.query のキー。
  //   - そのまま（長さの上限だけ。LogFieldMarks.bounded）: accept・content-type・user_agent.original・host（server.address）・x-request-id
  //     （http.request.id。応答ヘッダと突き合わせる相関 ID）。url.path と url.query のキーは自由文の網の後に同じ上限で切る。
  //   - そのまま: method（Next が受け付けた HTTP メソッド）・traceparent から作った trace の 3 つ（形を検査した値。Cloud Trace との
  //     結び付けに要る）。
  static of<Name extends "page_request" | "api_request">(name: Name) {
    return z.object({
      message: LogFieldMarks.freeText(),
      event: z.object({ name: z.literal(name) }),
      time: z.string(),
      http: z.object({
        request: z.object({
          id: LogFieldMarks.bounded(),
          method: z.string(),
          header: z.object({
            referer: LogFieldMarks.sensitive(z.string()).nullable(),
            accept: LogFieldMarks.bounded().nullable(),
            "content-type": LogFieldMarks.bounded().nullable(),
          }),
          body: z.object({ size: z.number().nullable() }),
        }),
      }),
      url: z.object({
        path: LogFieldMarks.boundedFreeText(),
        query: z.record(
          LogFieldMarks.boundedFreeText(),
          LogFieldMarks.sensitive(z.string()),
        ),
      }),
      client: z.object({
        address: LogFieldMarks.sensitive(z.string()).nullable(),
      }),
      user_agent: z.object({ original: LogFieldMarks.bounded().nullable() }),
      server: z.object({ address: LogFieldMarks.bounded().nullable() }),
      user: z.object({ id: z.null() }),
      "logging.googleapis.com/trace": z.string().optional(),
      "logging.googleapis.com/spanId": z.string().optional(),
      "logging.googleapis.com/trace_sampled": z.boolean().optional(),
    });
  }
}

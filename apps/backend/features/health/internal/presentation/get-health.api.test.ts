// @vitest-environment node
import { afterEach, describe, expect, test, vi } from "vitest";
import { CheckHealthQuery } from "../application/check-health.query";
import type { HealthRepository } from "../domain/health-repository";
import { PostgresHealthRepository } from "../infra/health-repository.postgres";
import {
  GetHealthApi,
  type GetHealthResponse,
  GET as productionGet,
} from "./get-health.api";

// ping の結果を決めた Repository（check-health.query.test.ts と同じく、状態を持たないのでその場で作る）。
class Repositories {
  static reachable(): HealthRepository {
    return { ping: () => Promise.resolve() };
  }

  static unreachable(cause: unknown): HealthRepository {
    return { ping: () => Promise.reject(cause) };
  }
}

// handle をインスタンスから取り出して呼ぶ: 本番（`export const GET = new GetHealthApi(...).handle`）と同じ渡し方にし、
//   this が外れても動くこと（handle がアロー関数のプロパティであること）も確かめる。
function handlerWith(repository: HealthRepository) {
  return new GetHealthApi(new CheckHealthQuery(repository)).handle;
}

function healthRequest(): Request {
  return new Request("http://localhost/api/health");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  test("DB に問い合わせられれば、200 と status・database が ok の本文を返し、ログを出さない", async () => {
    // given
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const GET = handlerWith(Repositories.reachable());

    // when
    const response = await GET(healthRequest());

    // then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toStrictEqual({
      status: "ok",
      checks: { database: "ok" },
    } satisfies GetHealthResponse);
    expect(consoleError).not.toHaveBeenCalled();
  });

  // WHY 503（500 にしない）: DB の不通は「今は応答できない」一時的な状態で、監視とロードバランサは 503 を「使えない」と読む
  //   （RFC 9110 の 15.6.4）。本文は Problem Details ではなく、200 と同じ形（どの確認が失敗したかを checks で読める）。
  // WHY 本文に原因（例外の message）を出さない: 接続先のホスト・ポートなど内部の情報を含みうる。原因はログの 1 行にだけ残す。
  test("DB に問い合わせられなければ、503 と status・database が unavailable の本文を返し、原因の例外をログに 1 行残す", async () => {
    // given
    // logger.emit（health_check_failed は ERROR なので中で console.error）が 1 行出す。テストの出力を汚さないよう抑制し、行を確かめる
    //   （行の形は apps/shared/logger.test.ts で固定している）。
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const GET = handlerWith(
      Repositories.unreachable(
        new Error("connect ECONNREFUSED db.internal:5432"),
      ),
    );

    // when
    const response = await GET(healthRequest());

    // then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("application/json");
    await expect(response.json()).resolves.toStrictEqual({
      status: "unavailable",
      checks: { database: "unavailable" },
    } satisfies GetHealthResponse);
    expect(consoleError).toHaveBeenCalledTimes(1);
    const [line] = consoleError.mock.calls[0] as [string];
    expect(JSON.parse(line)).toMatchObject({
      severity: "ERROR",
      message: "health check failed: database unavailable",
      event: { name: "health_check_failed" },
      error: {
        type: "Error",
        message: "connect ECONNREFUSED db.internal:5432",
      },
    });
  });

  // WHY no-store: 監視の結果を途中のキャッシュ（CDN・ブラウザ）に残させない。残ると、DB が落ちた後も前の 200 が返り続ける。
  test.each([
    ["使えるとき（200）", Repositories.reachable()],
    ["使えないとき（503）", Repositories.unreachable(new Error("down"))],
  ])("%s も cache-control: no-store を付ける", async (_name, repository) => {
    // given
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const GET = handlerWith(repository);

    // when
    const response = await GET(healthRequest());

    // then
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  // WHY 本番の GET（モジュールの最下部で組み立てたもの）を確かめる: Postgres の Repository で組み立てていることを、
  //   PostgresHealthRepository の ping が呼ばれることで固定する。ping を差し替えるので DB には接続しない。
  test("本番の GET は Postgres の Repository で組み立てている", async () => {
    // given
    const ping = vi
      .spyOn(PostgresHealthRepository.prototype, "ping")
      .mockResolvedValue();

    // when
    const response = await productionGet(healthRequest());

    // then
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      status: "ok",
      checks: { database: "ok" },
    });
    expect(ping).toHaveBeenCalledTimes(1);
  });
});

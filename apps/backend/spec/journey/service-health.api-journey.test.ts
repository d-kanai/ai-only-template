// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, type TestContext } from "vitest";
import { CheckHealthQuery } from "../../features/health/internal/application/check-health.query";
import { PostgresHealthRepository } from "../../features/health/internal/infra/health-repository.postgres";
import {
  GetHealthApi,
  type GetHealthResponse,
} from "../../features/health/internal/presentation/get-health.api";
import { CreateTodoCommand } from "../../features/todo/internal/application/create-todo.command";
import { ListTodosQuery } from "../../features/todo/internal/application/list-todos.query";
import { todos } from "../../features/todo/internal/infra/schema";
import { PostgresTodoRepository } from "../../features/todo/internal/infra/todo-repository.postgres";
import {
  CreateTodoApi,
  type CreateTodoResponse,
} from "../../features/todo/internal/presentation/create-todo.api";
import {
  ListTodosApi,
  type ListTodosResponse,
} from "../../features/todo/internal/presentation/list-todos.api";
import { changeLogs } from "../../shared/change-log/change-log.schema";
import { PostgresTransactionRunner } from "../../shared/drizzle/transaction.postgres";
import { ApiCoverage } from "../../test-support/api-coverage";
import { TestDatabase } from "../../test-support/database";

// API ジャーニーテスト（Issue #107）: 外からの監視がサービスの稼働を確かめる間に、利用者が Todo を作って一覧を見るという流れに沿って、
//   ヘルスチェックと Todo の作成・一覧の API を、実 Postgres の上で本番と同じ組み立てで順に呼ぶ。WHY（API ジャーニーという層・本番の
//   export を使わずここで組み立てる・テストダブル無し・変更系の後に DB を読む・step 間の値を変数で渡す・技術の検証をここに閉じる・
//   Stryker で実行しない）は todo-lifecycle.api-journey.test.ts の冒頭と同じ。
// WHY ヘルスチェックの後にも DB を読む: ヘルスチェックは GET なので規則（rule-tests/api-journey.test.ts）は DB の読み取りを求めないが、
//   稼働の確認が何も書かない（Todo も変更の記録も増えない）ことを、業務の流れの中で確かめる。
// WHY ヘルスチェックを Todo と同じ db で組み立てる: 本番も同じプール（AppDatabase.get().db）を使う。Todo を書いた接続と同じ保存先に
//   問い合わせられることを確かめる。DB に問い合わせられない場合（503）は API 仕様（spec/api/health）と単体テストが確かめる。

let database: TestDatabase;
let handlers: ReturnType<typeof api>;

beforeAll(async () => {
  database = await TestDatabase.create();
  await database.migrate();
  handlers = api();
});

afterAll(async () => {
  await database.close();
});

// 本番の api ファイルの最下部と同じ組み立てで、テスト用のスキーマの db を使う handler をそろえる。
// WHY 名前を HTTP メソッドで始める・ApiCoverage.track で包む: todo-lifecycle.api-journey.test.ts の api() のコメント。
function api() {
  const repository = new PostgresTodoRepository(database.db);
  const transactions = new PostgresTransactionRunner(database.db);
  return {
    getHealth: ApiCoverage.track(
      new GetHealthApi(
        new CheckHealthQuery(new PostgresHealthRepository(database.db)),
      ),
    ),
    postTodo: ApiCoverage.track(
      new CreateTodoApi(new CreateTodoCommand(repository, transactions)),
    ),
    listTodos: ApiCoverage.track(
      new ListTodosApi(new ListTodosQuery(repository)),
    ),
  };
}

const BASE_URL = "http://localhost";

function healthRequest(): Request {
  return new Request(`${BASE_URL}/api/health`);
}

// 使えるときの応答の本文（200）。
const AVAILABLE: GetHealthResponse = {
  status: "ok",
  checks: { database: "ok" },
};

// API の応答の Todo を、todos の行の期待値にする（todo-lifecycle.api-journey.test.ts の rowOf と同じ）。
function rowOf(todo: CreateTodoResponse): typeof todos.$inferSelect {
  return { ...todo, createdAt: new Date(todo.createdAt) };
}

const feature = await loadFeature("./service-health.feature");

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    // WHY Background で表を空にする: todo-lifecycle.api-journey.test.ts の Background と同じ。
    Given("Todo が 1 件も無い", async () => {
      await database.db.execute(
        sql`truncate change_logs, todo_status_changes, todos`,
      );
    });
  });

  Scenario("稼働を確かめながら Todo を使う", ({ When, Then, And }) => {
    let response: Response;
    let milk: CreateTodoResponse;
    // 変更の記録の件数（Todo を作った後の値）。稼働の確認で増えないことを確かめる。
    let changeLogCount: number;

    When("サービスが使えるかを確かめる", async () => {
      response = await handlers.getHealth(healthRequest());
    });

    Then("サービスは使えると返る", async () => {
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toStrictEqual(AVAILABLE);
    });

    And("確かめても Todo は増えない", async () => {
      await expect(database.db.select().from(todos)).resolves.toStrictEqual([]);
      await expect(
        database.db.select().from(changeLogs),
      ).resolves.toStrictEqual([]);
    });

    When("Todo {string} を作る", async (_ctx: TestContext, title: string) => {
      response = await handlers.postTodo(
        new Request(`${BASE_URL}/api/todos`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title }),
        }),
      );
    });

    Then(
      "Todo は {string} の 1 件だけになる",
      async (_ctx: TestContext, title: string) => {
        expect(response.status).toBe(201);
        milk = (await response.json()) as CreateTodoResponse;
        expect(milk).toMatchObject({ title, completed: false });
        await expect(database.db.select().from(todos)).resolves.toStrictEqual([
          rowOf(milk),
        ]);
        changeLogCount = (await database.db.select().from(changeLogs)).length;
      },
    );

    When(
      "Todo を作った後に、もう一度サービスが使えるかを確かめる",
      async () => {
        response = await handlers.getHealth(healthRequest());
      },
    );

    Then("作った後もサービスは使えると返る", async () => {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual(AVAILABLE);
    });

    And(
      "確かめても Todo は {string} の 1 件のまま変わらない",
      async (_ctx: TestContext, title: string) => {
        await expect(database.db.select().from(todos)).resolves.toStrictEqual([
          rowOf({ ...milk, title }),
        ]);
        expect(await database.db.select().from(changeLogs)).toHaveLength(
          changeLogCount,
        );
      },
    );

    When("Todo の一覧を見る", async () => {
      response = await handlers.listTodos(new Request(`${BASE_URL}/api/todos`));
    });

    Then(
      "一覧に {string} だけが並ぶ",
      async (_ctx: TestContext, title: string) => {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({
          todos: [{ ...milk, title }],
        } satisfies ListTodosResponse);
      },
    );
  });
});

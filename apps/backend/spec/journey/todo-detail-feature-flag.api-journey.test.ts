// @vitest-environment node
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, type TestContext } from "vitest";
import { EvaluateFeatureFlagQuery } from "../../features/feature-flag/internal/application/evaluate-feature-flag.query";
import { EvaluateFeatureFlagsQuery } from "../../features/feature-flag/internal/application/evaluate-feature-flags.query";
import {
  FEATURE_FLAGS,
  type FeatureFlagKey,
} from "../../features/feature-flag/internal/domain/feature-flags";
import {
  EvaluateFeatureFlagApi,
  type EvaluateFeatureFlagResponse,
} from "../../features/feature-flag/internal/presentation/evaluate-feature-flag.api";
import {
  EvaluateFeatureFlagsApi,
  type EvaluateFeatureFlagsResponse,
} from "../../features/feature-flag/internal/presentation/evaluate-feature-flags.api";
import { CreateTodoCommand } from "../../features/todo/internal/application/create-todo.command";
import { GetTodoQuery } from "../../features/todo/internal/application/get-todo.query";
import { todos } from "../../features/todo/internal/infra/schema";
import { PostgresTodoRepository } from "../../features/todo/internal/infra/todo-repository.postgres";
import {
  CreateTodoApi,
  type CreateTodoResponse,
} from "../../features/todo/internal/presentation/create-todo.api";
import {
  GetTodoApi,
  type GetTodoResponse,
} from "../../features/todo/internal/presentation/get-todo.api";
import { changeLogs } from "../../shared/change-log/change-log.schema";
import { PostgresTransactionRunner } from "../../shared/drizzle/transaction.postgres";
import { ApiCoverage } from "../../test-support/api-coverage";
import { TestDatabase } from "../../test-support/database";

// API ジャーニーテスト（Issue #156）: Todo の詳細画面の出し分けという業務の流れに沿って、フィーチャーフラグの評価（OFREP の
//   一括・1 件）と Todo の作成・詳細の API を、実 Postgres の上で本番と同じ組み立てで順に呼ぶ。WHY（API ジャーニーという層・本番の
//   export を使わずここで組み立てる・テストダブル無し・変更系の後に DB を読む・step 間の値を変数で渡す・技術の検証をここに閉じる・
//   Stryker で実行しない）は todo-lifecycle.api-journey.test.ts の冒頭と同じ。
// WHY フラグの評価の後にも DB を読む: OFREP の評価は POST（評価の文脈を本文で送る。OFREP の仕様）なので、名前が post で始まり、
//   rule-tests/api-journey.test.ts は変更系として後の DB の読み取りを求める。評価は読むだけなので、Todo と変更の記録が増えない
//   （評価が何も書かない）ことを確かめる。
// WHY フラグの一覧は本番の FEATURE_FLAGS: 本番と同じ組み立てで、画面が実際に受け取る値の流れを確かめる。値の組み合わせ（off など）は
//   API 仕様（spec/api/feature-flag）と単体テストが確かめる。

// 画面が出し分けに使うフラグ（一覧から詳細へのリンク）。
// WHY 型で縛る: 本番の一覧に無い key を書くと型エラーにする（画面と同じく FeatureFlagKey で受ける）。
const DETAIL_SCREEN: FeatureFlagKey = "todo-detail-screen";

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

// 本番の api ファイルの最下部と同じ組み立てで、テスト用のスキーマの db を使う handler をそろえる（フラグは DB を使わない）。
// WHY 名前を HTTP メソッドで始める・ApiCoverage.track で包む: todo-lifecycle.api-journey.test.ts の api() のコメント。
function api() {
  const repository = new PostgresTodoRepository(database.db);
  const transactions = new PostgresTransactionRunner(database.db);
  return {
    postEvaluateFlags: ApiCoverage.track(
      new EvaluateFeatureFlagsApi(new EvaluateFeatureFlagsQuery(FEATURE_FLAGS)),
    ),
    postEvaluateFlag: ApiCoverage.track(
      new EvaluateFeatureFlagApi(new EvaluateFeatureFlagQuery(FEATURE_FLAGS)),
    ),
    postTodo: ApiCoverage.track(
      new CreateTodoApi(new CreateTodoCommand(repository, transactions)),
    ),
    getTodo: ApiCoverage.track(new GetTodoApi(new GetTodoQuery(repository))),
  };
}

const BASE_URL = "http://localhost";

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// API の応答の Todo を、todos の行の期待値にする（todo-lifecycle.api-journey.test.ts の rowOf と同じ）。
function rowOf(todo: CreateTodoResponse): typeof todos.$inferSelect {
  return { ...todo, createdAt: new Date(todo.createdAt) };
}

const feature = await loadFeature("./todo-detail-feature-flag.feature");

describeFeature(feature, ({ Background, Scenario }) => {
  Background(({ Given }) => {
    // WHY Background で表を空にする: todo-lifecycle.api-journey.test.ts の Background と同じ。
    Given("Todo が 1 件も無い", async () => {
      await database.db.execute(
        sql`truncate change_logs, todo_status_changes, todos`,
      );
    });
  });

  Scenario(
    "詳細画面が使えるかを確かめてから詳細を見る",
    ({ When, Then, And }) => {
      let response: Response;
      let milk: CreateTodoResponse;
      // 変更の記録の件数（Todo を作った後の値）。フラグの評価で増えないことを確かめる。
      let changeLogCount: number;

      // 画面の OFREP の web provider は context が無いと本文 {} を送る（evaluate-feature-flags.api.ts の requestSchema）。
      When("画面を開くときに機能の出し分けをまとめて読む", async () => {
        response = await handlers.postEvaluateFlags(
          jsonRequest("/api/ofrep/v1/evaluate/flags", {}),
        );
      });

      Then("詳細画面は使えると返る", async () => {
        expect(response.status).toBe(200);
        const body = (await response.json()) as EvaluateFeatureFlagsResponse;
        expect(body.flags).toContainEqual({
          key: DETAIL_SCREEN,
          value: true,
          reason: "STATIC",
        });
      });

      And("出し分けを読んでも Todo は増えない", async () => {
        await expect(database.db.select().from(todos)).resolves.toStrictEqual(
          [],
        );
        await expect(
          database.db.select().from(changeLogs),
        ).resolves.toStrictEqual([]);
      });

      When("Todo {string} を作る", async (_ctx: TestContext, title: string) => {
        response = await handlers.postTodo(
          jsonRequest("/api/todos", { title }),
        );
      });

      Then(
        "Todo は {string} の 1 件だけになる",
        async (_ctx: TestContext, title: string) => {
          expect(response.status).toBe(201);
          milk = (await response.json()) as CreateTodoResponse;
          expect(milk).toMatchObject({ title, completed: false });
          await expect(database.db.select().from(todos)).resolves.toStrictEqual(
            [rowOf(milk)],
          );
          changeLogCount = (await database.db.select().from(changeLogs)).length;
        },
      );

      // 画面のほか、サーバ側で 1 つのフラグだけを確かめる使い方（OFREP の 1 件の評価）。
      When("詳細画面が使えるかを 1 つだけ確かめる", async () => {
        response = await handlers.postEvaluateFlag(
          jsonRequest(`/api/ofrep/v1/evaluate/flags/${DETAIL_SCREEN}`, {
            context: { targetingKey: "user-123" },
          }),
          { params: Promise.resolve({ key: DETAIL_SCREEN }) },
        );
      });

      Then("詳細画面は使えると 1 つだけ返る", async () => {
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({
          key: DETAIL_SCREEN,
          value: true,
          reason: "STATIC",
        } satisfies EvaluateFeatureFlagResponse);
      });

      And(
        "確かめても Todo は {string} の 1 件のまま変わらない",
        async (_ctx: TestContext, title: string) => {
          await expect(database.db.select().from(todos)).resolves.toStrictEqual(
            [rowOf({ ...milk, title })],
          );
          expect(await database.db.select().from(changeLogs)).toHaveLength(
            changeLogCount,
          );
        },
      );

      When(
        "{string} の詳細を見る",
        async (_ctx: TestContext, title: string) => {
          expect(milk.title).toBe(title);
          response = await handlers.getTodo(
            new Request(`${BASE_URL}/api/todos/${milk.id}`),
            { params: Promise.resolve({ id: milk.id }) },
          );
        },
      );

      Then(
        "{string} の詳細が返る",
        async (_ctx: TestContext, title: string) => {
          expect(response.status).toBe(200);
          await expect(response.json()).resolves.toStrictEqual({
            ...milk,
            title,
          } satisfies GetTodoResponse);
        },
      );
    },
  );
});

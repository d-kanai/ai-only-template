import { expect, type Page } from "@playwright/test";
import { Fixture, Given, When } from "playwright-bdd/decorators";
import { E2eDatabase } from "../support/database";
import type { test } from "../support/fixtures";

// 複数の .feature が使う step（Issue #279）。.feature と対にならない唯一の step のファイル（rule-tests/e2e-feature.test.ts の
//   e2e-feature-pair の例外）。
// WHY 共有のファイルに置く: playwright-bdd の step はすべての .feature から見え、同じ文の step を 2 つのクラスに書くと、どちらを
//   使うか決まらず生成（bddgen）で失敗する。共通の前提・画面の開き方は 1 か所に書く。
@Fixture<typeof test>("sharedSteps")
export class SharedSteps {
  constructor(private readonly page: Page) {}

  // WHY Todo を空にする: データは Postgres に残り、サーバを起動し直しても、前のシナリオ・前回の実行（途中で失敗して削除まで
  //   届かなかったもの）の Todo が一覧に出る。シナリオごとに空の状態から始め、結果が実行順や過去の実行に左右されないようにする。
  //   接続先は webServer と同じ（apps/e2e/support/database.ts）。
  @Given("Todo が 1 件も無い")
  async noTodos(): Promise<void> {
    await E2eDatabase.resetTodos();
  }

  @When("Todo の一覧を開く")
  async openList(): Promise<void> {
    await this.page.goto("/");
  }

  // WHY 詳細の画面が開いたことまで確かめる: 後続の Then は詳細の画面の中身（完了・言語・記録）を見るので、遷移が終わる前に
  //   探し始めないようにする。見出しはどの言語でも Todo のタイトルなので、言語によらずに使える。
  @When("{string} の詳細を開く")
  async openDetail(title: string): Promise<void> {
    await this.page.getByRole("link", { name: title }).click();
    await expect(this.page).toHaveURL(/\/todo\/[^/]+$/);
    await expect(
      this.page.getByRole("heading", { name: title, level: 1 }),
    ).toBeVisible();
  }
}

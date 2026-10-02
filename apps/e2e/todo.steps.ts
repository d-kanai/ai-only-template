import { expect, type Page } from "@playwright/test";
import { Fixture, Then, When } from "playwright-bdd/decorators";
import { E2eDatabase } from "./database";
import type { test } from "./fixtures";

// todo.feature（画面での Todo の管理）の step（Issue #279。以前の todo.spec.ts）。API は Postgres（playwright.config.ts の webServer に
//   DATABASE_URL を渡す）で動く。
// WHY getByRole / getByLabel: 利用者が見る役割と名前（aria-label・label・見出し）で要素を探し、CSS クラスや DOM 構造の変更で
//   テストが壊れないようにする。
// WHY .feature に書いた値（Todo の名前）を固定値で書かない: 値は step の引数（{string}）で受け取る（API ジャーニーと同じ）。
//   .feature の値を書き換えても、step の実装を直さずに通る。
// WHY タイトルに実行ごとの番号を付けない（以前の todo.spec.ts は Date.now() を付けていた）: .feature の値をそのまま画面に出して
//   確かめるため。前のデータと名前が重ならないことは、Background の「Todo が 1 件も無い」（Postgres の表を空にする）で担保する。
@Fixture<typeof test>("todoSteps")
export class TodoSteps {
  constructor(private readonly page: Page) {}

  // WHY 読み込み中の表示が消えるのを待ってから数える: 読み込み中は一覧そのものが無く、件数が 0 に見えるため。
  @Then("一覧は空で表示される")
  async emptyList(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Todo", level: 1 }),
    ).toBeVisible();
    await expect(this.page.getByText("読み込み中…")).toHaveCount(0);
    await expect(this.page.getByRole("listitem")).toHaveCount(0);
  }

  @When("Todo {string} を追加する")
  async add(title: string): Promise<void> {
    await this.page.getByLabel("新しい Todo").fill(title);
    await this.page.getByRole("button", { name: "追加" }).click();
  }

  // 画面に出た Todo が Postgres に保存されていること（InMemory で動いていないこと）を DB から直接確かめる。
  @Then("一覧に {string} が表示され、保存されている")
  async added(title: string): Promise<void> {
    await expect(this.page.getByRole("link", { name: title })).toBeVisible();
    expect(await E2eDatabase.countTodosWithTitle(title)).toBe(1);
  }

  // WHY check() ではなく click(): チェックボックスは controlled で、checked は API の更新後に再取得した値で決まる。
  //   check() はクリック直後に状態が変わったかを検査し、応答前は React が元の値に戻すため失敗しうる。
  //   クリックだけ行い、Then の toBeChecked の自動リトライで API の反映を待つ。
  @When("一覧で {string} を完了にする")
  async complete(title: string): Promise<void> {
    await this.completeCheckbox(title).click();
  }

  @Then("一覧で {string} が完了になる")
  async completed(title: string): Promise<void> {
    await expect(this.completeCheckbox(title)).toBeChecked();
  }

  // 完了がサーバに保存されていることを、一覧とは別の画面（詳細）の表示で確かめる。
  @Then("詳細で {string} が完了になっている")
  async completedInDetail(title: string): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: title, level: 1 }),
    ).toBeVisible();
    await expect(
      this.page.getByRole("checkbox", { name: "完了" }),
    ).toBeChecked();
  }

  // WHY exact: 完了チェックの label「完了」など、他の名前に部分一致しないよう title の input だけを指す。
  @When("詳細でタイトルを {string} に変えて保存する")
  async rename(title: string): Promise<void> {
    await this.page.getByLabel("タイトル", { exact: true }).fill(title);
    await this.page.getByRole("button", { name: "保存" }).click();
  }

  @Then("詳細の見出しが {string} に変わる")
  async renamed(title: string): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: title, level: 1 }),
    ).toBeVisible();
  }

  @When("詳細から一覧に戻る")
  async backToList(): Promise<void> {
    await this.page.getByRole("link", { name: "一覧へ戻る" }).click();
  }

  @Then("一覧に {string} が表示され、元の名前 {string} は表示されない")
  async listedWithNewName(title: string, oldTitle: string): Promise<void> {
    await expect(this.page).toHaveURL(/\/$/);
    await expect(this.page.getByRole("link", { name: title })).toBeVisible();
    await expect(this.page.getByRole("link", { name: oldTitle })).toHaveCount(
      0,
    );
  }

  @When("一覧で {string} を削除する")
  async delete(title: string): Promise<void> {
    await this.page.getByRole("button", { name: `「${title}」を削除` }).click();
  }

  @Then("一覧から {string} が消え、保存からも消えている")
  async deleted(title: string): Promise<void> {
    await expect(this.page.getByRole("link", { name: title })).toHaveCount(0);
    expect(await E2eDatabase.countTodosWithTitle(title)).toBe(0);
  }

  private completeCheckbox(title: string) {
    return this.page.getByRole("checkbox", {
      name: `「${title}」を完了にする`,
    });
  }
}

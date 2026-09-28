import { expect, test } from "@playwright/test";

// Todo の CRUD を画面から一周する E2E テスト。
// WHY 1 テストで一周する: API は InMemory で、webServer の 1 プロセスを全テストが共有する（データはプロセスが
//   生きている間残る）。テストを分けると、前のテストが作った Todo が次のテストの一覧に残り、実行順や並列度で
//   結果が変わる。ここではテスト間の独立性ではなく、1 本の中の操作の順序で状態を担保する。
//   最後に削除まで行い、作ったデータを残さない。
// WHY getByRole / getByLabel: 利用者が見る役割と名前（aria-label・label・見出し）で要素を探し、
//   CSS クラスや DOM 構造の変更でテストが壊れないようにする。
test("Todo を追加し、完了にし、詳細で title を変えて、一覧から削除できる", async ({
  page,
}) => {
  // WHY title を実行ごとにユニークにする: ローカルでは reuseExistingServer で起動済みのサーバを使い回す。
  //   前回の実行が途中で失敗すると、削除まで到達せず Todo が InMemory に残る。固定の title だと、次の実行で
  //   同名の要素が複数見つかり（Playwright の strict mode 違反）、このテスト自身の不具合ではない理由で失敗しうる。
  //   実行時刻を付けて、残っているデータと名前が重ならないようにする。
  const runId = Date.now();
  const originalTitle = `牛乳を買う ${runId}`;
  const updatedTitle = `豆乳を買う ${runId}`;

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Todo", level: 1 }),
  ).toBeVisible();

  // 追加（Create）→ 一覧に出る（Read）
  await page.getByLabel("新しい Todo").fill(originalTitle);
  await page.getByRole("button", { name: "追加" }).click();
  await expect(page.getByRole("link", { name: originalTitle })).toBeVisible();

  // 完了にする（Update）
  // WHY check() ではなく click(): チェックボックスは controlled で、checked は API の更新後に再取得した値で決まる。
  //   check() はクリック直後に状態が変わったかを検査し、応答前は React が元の値に戻すため失敗しうる。
  //   クリックだけ行い、toBeChecked の自動リトライで API の反映を待つ。
  const completeCheckbox = page.getByRole("checkbox", {
    name: `「${originalTitle}」を完了にする`,
  });
  await completeCheckbox.click();
  await expect(completeCheckbox).toBeChecked();

  // 詳細へ移動し、完了がサーバに保存されていることを別画面の表示で確かめる
  await page.getByRole("link", { name: originalTitle }).click();
  await expect(page).toHaveURL(/\/todo\/[^/]+$/);
  await expect(
    page.getByRole("heading", { name: originalTitle, level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "完了" })).toBeChecked();

  // title を変えて保存（Update）→ 見出しが保存後の title に変わる
  // WHY exact: 完了チェックの label「完了」など、他の名前に部分一致しないよう title の input だけを指す。
  const titleInput = page.getByLabel("title", { exact: true });
  await titleInput.fill(updatedTitle);
  await page.getByRole("button", { name: "保存" }).click();
  await expect(
    page.getByRole("heading", { name: updatedTitle, level: 1 }),
  ).toBeVisible();

  // 一覧へ戻ると変更後の title で出る
  await page.getByRole("link", { name: "一覧へ戻る" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: updatedTitle })).toBeVisible();
  await expect(page.getByRole("link", { name: originalTitle })).toHaveCount(0);

  // 削除（Delete）→ 一覧から消える
  await page.getByRole("button", { name: `「${updatedTitle}」を削除` }).click();
  await expect(page.getByRole("link", { name: updatedTitle })).toHaveCount(0);
});

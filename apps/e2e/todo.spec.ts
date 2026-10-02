import { expect, test } from "@playwright/test";
import { E2eDatabase } from "./database";

// Todo の CRUD を画面から一周する E2E テスト。API は Postgres（playwright.config.ts の webServer に DATABASE_URL を渡す）で動く。
// WHY 各テストの前に todos を空にする: データは Postgres に残り、サーバを起動し直しても、前のテスト・前回の実行
//   （途中で失敗して削除まで届かなかったもの）の Todo が一覧に出る。テストごとに空の状態から始め、結果が実行順や
//   過去の実行に左右されないようにする（冪等性の主な担保）。接続先は webServer と同じ（apps/e2e/database.ts）。
// WHY 1 テストで一周する: 1 本の中の操作の順序で状態を担保する（追加 → 完了 → 詳細で変更 → 削除）。
//   最後に削除まで行い、作ったデータを残さない。
test.beforeEach(async () => {
  await E2eDatabase.resetTodos();
});

// WHY getByRole / getByLabel: 利用者が見る役割と名前（aria-label・label・見出し）で要素を探し、
//   CSS クラスや DOM 構造の変更でテストが壊れないようにする。
test("Todo を追加し、完了にし、詳細で title を変えて、一覧から削除できる", async ({
  page,
}) => {
  // WHY title を実行ごとにユニークにする: データの冪等性は beforeEach のリセットで担保している。これは補助で、
  //   リセットが効かなかった（DB を取り違えた、リセットの後に別のプロセスが書いた）ときに、残ったデータと名前が
  //   重なって同名の要素が複数見つかる（Playwright の strict mode 違反）のを避け、失敗の原因を分かりやすくする。
  const runId = Date.now();
  const originalTitle = `牛乳を買う ${runId}`;
  const updatedTitle = `豆乳を買う ${runId}`;

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Todo", level: 1 }),
  ).toBeVisible();
  // beforeEach のリセットで、一覧は空から始まる（前の実行のデータが残っていない）。
  // WHY 読み込み中の表示が消えるのを待ってから数える: 読み込み中は一覧そのものが無く、件数が 0 に見えるため。
  await expect(page.getByText("読み込み中…")).toHaveCount(0);
  await expect(page.getByRole("listitem")).toHaveCount(0);

  // 追加（Create）→ 一覧に出る（Read）
  await page.getByLabel("新しい Todo").fill(originalTitle);
  await page.getByRole("button", { name: "追加" }).click();
  await expect(page.getByRole("link", { name: originalTitle })).toBeVisible();
  // 画面に出た Todo が Postgres に保存されていること（InMemory で動いていないこと）を DB から直接確かめる。
  expect(await E2eDatabase.countTodosWithTitle(originalTitle)).toBe(1);

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
  const titleInput = page.getByLabel("タイトル", { exact: true });
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
  expect(await E2eDatabase.countTodosWithTitle(updatedTitle)).toBe(0);
});

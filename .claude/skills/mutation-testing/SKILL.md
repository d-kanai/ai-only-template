---
name: mutation-testing
description: Stryker による mutation testing（pnpm test:mutation）の実行と、生き残った変異（survived）の扱い。mutation score を確かめるとき、日次の Mutation ジョブが失敗したとき、survived を直す・Stryker disable を書くときに使う。
---

# mutation-testing（Stryker）

Stryker が実装に変異（条件の反転・戻り値の差し替え・文字列を空にする など）を入れ、Vitest の単体テストが失敗する（killed）か緑のまま（survived）かを数える。設定は `stryker.config.mjs`（各設定の WHY はファイル内のコメント）。
テストの書き方の規則と disable の一覧は `.claude/rules/quality/testing.md`、決定は ADR `docs/adr/quality/20260928-mutation-testing-daily-with-score-100.md`、実測の score・時間は 2026-09-28 の work-logs。

## 位置づけ
- 検証の弱いテスト（呼び出すだけ・値を見ていない）を日次でまとめて拾う。テストを書いたその場での「守っているコードを壊すと落ちる」確認（手作業）の代わりにはしない。
- ルール検査テストの fault injection は対象外（Stryker は `mutate` の実装コードしか変異させない）。そちらは `rule-check-test` スキル。

## 実行
1. Postgres を起動し、マイグレーションを当てる: `pnpm db:up && pnpm db:migrate`。WHY: 単体テストに実 Postgres を使うものがある。
2. 実行: `pnpm test:mutation`（`stryker run`）。ローカル 4 コアで約 3〜4 分。1 ファイルだけなら `pnpm test:mutation --mutate <path>`。
3. 結果: `reports/mutation/mutation.html`（ブラウザで開く）と `mutation.json`。`reports/` と `.stryker-tmp/` は `.gitignore` 済み。
   - score = killed / (killed + survived)。Ignored（static・disable）は分母に入らない。
   - しきい値は `thresholds: { high: 100, low: 95, break: 100 }`。survived が 1 件でもあると非 0 で終わる。
4. 後片付け: Stryker の後はテスト用スキーマ（`test_<UUID>`）が残る。次の `pnpm test` の最初に globalSetup が消す（Stryker の worker の中では消さない）。

## 対象と効かないもの
- 対象: `apps/frontend_customer/features/` `apps/frontend_customer/shared/` `apps/backend/` の `.ts` / `.tsx`（テストと `*.d.ts` を除く）。`apps/frontend_customer/app/`・`scripts/`・設定ファイル・ルール検査テスト・`apps/e2e/` は対象外。
- Vitest のカバレッジのしきい値は Stryker の実行では効かない（vitest-runner が coverage を切り、変異を通るテストだけを動かす）。
- テストで `@repo/backend/...` から backend の値を import すると、その変異はテストに届かない（サンドボックスの `node_modules` が元の `apps/backend` を指す）。backend の振る舞いは backend の中のテスト（相対 import）で確かめる。

## 生き残り（survived）の扱い
1. ロジック（条件・分岐・戻り値・状態の更新・依存配列など）の変異は、テストを足して殺す。テスト名は仕様文で書き、その変異で落ちることをレポートか手作業の変異で確かめる。
2. 文言の変異: API のエラーの本文（Problem Details の `title`・`detail` など。`problem.ts`・`problem-detail.en.ts`）は検証して殺す。内部のログの文言など検証しない文言だけ disable してよい。
3. **等価な変異**（変えても振る舞いが変わらず、どのテストでも検出できない）だけ、理由付きで除く: `// Stryker disable next-line <Mutator>: <理由>`。
   - `next-line` は、コメントを直前に持つ文・式の開始行にだけ効く。依存配列など式の途中に効かせたいときは、その式を別の行に書いて直前にコメントを置く。`disable` 〜 `restore` の範囲指定は `next-line` で書けないときだけ、最小範囲で。
   - 殺せるのにテストを書く手間を省くために使わない。disable を足した・消したら `.claude/rules/quality/testing.md` の一覧を更新する。
   - 「等価」と決める前にほかの実行経路を探す（例: React の `<Activity mode="hidden">` では unmount せずに effect の片付けが走り、state 更新も反映される）。
4. 等価な変異を生む書き方を避ける:
   - 判定の結果を変えない検査（`"error" in value` の後に `value.error` の型を見る など）は書かない。
   - 例外を握りつぶす `try` の範囲は、握りつぶしたい呼び出しだけにする。
   - 失敗の検証は `rejects.toEqual(new Error("..."))`（クラスと message を比べる）。WHY: Vitest 5.0.1 の `rejects.toThrow("文字列")` は reject 値が `undefined` だと通る。

## static な変異（`ignoreStatic: true`）
- モジュールの読み込み時にだけ実行される変異（最上位の式）は数えない（Ignored）。WHY: Stryker は static な変異で全テストを読み込み直し、読み込みが壊れるとテスト 0 件のまま Survived と数えるため。
- ロジックの定数（正規表現・変換表・URL・接頭辞）は最上位に置かず、呼び出し時に評価する関数の中に置く。WHY: 最上位だと static になり検査から外れる。
- 残る static は `apps/backend/features/todo/internal/infra/schema.ts` のテーブル宣言だけ（等価の理由は `stryker.config.mjs`）。

## 日次ジョブ
- `.github/workflows/mutation.yml` が main を毎日 08:55 JST（UTC 23:55）に実行し、`reports/mutation/` を artifact `mutation-report`（30 日保存）に残す。Actions の画面から手動実行もできる（`workflow_dispatch`）。PR ごとには実行しない（ユーザー判断、Issue #52）。
- 失敗したら artifact のレポートで survived を見て、上の「生き残りの扱い」で直す PR を作る（`pr-flow`）。

## 入れていないもの・パッチ
- `@stryker-mutator/typescript-checker` は入れていない（TypeScript 7 の `typescript` パッケージに必要な JS API が無い）。
- `@stryker-mutator/vitest-runner@10.0.0` に pnpm patch を当てている（テスト名の区切りを ` > ` に。無いと `describe` 内のテストで変異を検出できない）。上流が直ったら外す（`dependency-update` スキルの pnpm patch）。

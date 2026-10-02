// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは SQL を文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";

// drizzle のマイグレーションの SQL の決まり（.claude/rules/code/backend.md の「永続化」。Issue #192）を機械的に検査するテスト。
// Issue #247 で、データの移行（backfill）の仕組みを消したのに合わせて、backfill の規則（idempotent-insert-select・
//   backfill-after-traffic・backfill-file-name）を消した（本番環境が無く、規則の WHY の「毎回流す backfill」が無くなったため）。
// 違反にするもの（規則）:
//   - no-public-schema-qualifier: apps/backend/shared/drizzle/ の下の *.sql の文に、表のスキーマ修飾 `"public".`
//     （引用符なしの `public.` も。大文字小文字と `.` の前後の空白は問わない）がある（Issue #192）。
//     WHY: drizzle-kit 0.31.11 の generate は schema.ts の `.references()` を `REFERENCES "public"."todos"` と書く。
//     TestDatabase.create() はテストファイルごとの別スキーマ（search_path）にマイグレーションを当てるので、public を指す SQL は
//     テストのスキーマの表を指さず、外部キーが public の表を参照して壊れる。外部キーは --custom の SQL にスキーマなしで書く
//     （.claude/skills/db-migration/SKILL.md）。
//     読み方: `--` から行末と `/* … */` をコメントとして消し（コメントの中の WHY の説明で落とさない）、`;` と drizzle の区切り
//     `--> statement-breakpoint`（コメントとして消える）で文に分ける。違反は 1 始まりの文の番号で返す。
//     限界: 文字列リテラルの中の `public.` も違反にする（誤検出。今の SQL には無い）。文字列リテラルの中の `--`・`;` を
//     区別しない。`"public"` 以外のスキーマの修飾は見ない。
// 検査の対象の列挙（drizzle の *.sql）が 0 件なら、実ファイルのテストで失敗させる（0 件だと違反も 0 件で常に緑になる）。

const DRIZZLE_DIR = "apps/backend/shared/drizzle";

// コメント（`--` から行末と `/* … */`）を消して `;` で文に分け、空の文を除く。
function sqlStatements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

// 表をスキーマ名 public で修飾した文（1 始まりの文の番号）。
// WHY `\bpublic`: `is_public.`・`"is_public".` のように名前の一部の public は修飾ではない（`_` は単語の文字なので境界にならない）。
function findPublicSchemaQualifiers(sql: string): number[] {
  return sqlStatements(sql).flatMap((statement, index) =>
    /(?:"public"|\bpublic)\s*\.\s*["\w]/i.test(statement) ? [index + 1] : [],
  );
}

// ---- 列挙と検査（本番と fixture で同じ処理を通す） ----

// apps/backend/shared/drizzle/ の下の *.sql（再帰。meta/ などの下も）。リポジトリ相対の / 区切りで、名前順。無ければ空。
function listDrizzleSqlFiles(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(join(root, DRIZZLE_DIR), {
      recursive: true,
      encoding: "utf8",
    });
  } catch {
    return [];
  }
  return entries
    .map((path) => `${DRIZZLE_DIR}/${path.split(sep).join("/")}`)
    .filter((path) => path.endsWith(".sql"))
    .sort();
}

function collectMigrationViolations(root: string): string[] {
  return listDrizzleSqlFiles(root).flatMap((path) =>
    findPublicSchemaQualifiers(readFileSync(join(root, path), "utf8")).map(
      (n) =>
        `no-public-schema-qualifier: ${path} の ${n} 文目が表を "public". で修飾している`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");
const lines = (...parts: string[]) => parts.join("\n");

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "migration-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const feature = await loadFeature("./migration.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("public のスキーマ修飾の判定", ({ And }) => {
    And(
      '修飾の無い書き方は違反なし（修飾なしの外部キー・コメントの中の "public".・public を含む別の名前・空）',
      () => {
        // given
        const cases: [string, string][] = [
          [
            "修飾なしの外部キー（0002 の形）",
            'ALTER TABLE "c" ADD CONSTRAINT "c_fk" FOREIGN KEY ("p_id") REFERENCES "p"("id") ON DELETE cascade;',
          ],
          [
            'コメントの中の "public".（WHY の説明）',
            lines(
              '-- drizzle-kit は REFERENCES "public"."p" と書く',
              "/* public.p */",
              'CREATE TABLE "c" ("id" uuid);',
            ),
          ],
          [
            "public を含む別の名前（列 is_public・表 publications）",
            'CREATE TABLE "publications" ("is_public" boolean, "public_id" uuid);',
          ],
          ["空", ""],
        ];

        // when
        const result = casesByName(cases, ([, sql]) =>
          findPublicSchemaQualifiers(sql),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => []));
      },
    );

    And(
      "表を public で修飾した文は、文の番号で違反になる（drizzle-kit が生成する形・引用符なし・大文字と空白・複数の文）",
      () => {
        // given
        const cases: [string, string, number[]][] = [
          [
            "drizzle-kit が .references() から生成する形",
            lines(
              'CREATE TABLE "c" ("id" uuid);--> statement-breakpoint',
              'ALTER TABLE "c" ADD CONSTRAINT "c_fk" FOREIGN KEY ("p_id") REFERENCES "public"."p"("id");',
            ),
            [2],
          ],
          ["引用符なし", "insert into public.p select 1;", [1]],
          ["大文字と空白", 'SELECT 1 FROM "PUBLIC" . "p";', [1]],
          [
            "複数の文",
            'SELECT 1 FROM "public"."a";\nSELECT 1 FROM public.b;',
            [1, 2],
          ],
        ];

        // when
        const result = casesByName(cases, ([, sql]) =>
          findPublicSchemaQualifiers(sql),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );
  });

  Scenario("列挙と検査（fixture）", ({ And }) => {
    And(
      "drizzle の下の SQL のファイル（サブディレクトリを含む）だけを検査し、public で修飾した文をファイルと文の番号で返す",
      () => {
        // given
        const root = fixture({
          [`${DRIZZLE_DIR}/0000_create.sql`]: "CREATE TABLE x (a int);",
          [`${DRIZZLE_DIR}/0001_fk.sql`]: lines(
            '-- REFERENCES "public"."t" はコメントなので数えない',
            "CREATE TABLE y (a int);--> statement-breakpoint",
            'ALTER TABLE y ADD CONSTRAINT c FOREIGN KEY (a) REFERENCES "public"."t"("id");',
          ),
          [`${DRIZZLE_DIR}/nested/0002_x.sql`]: "SELECT 1 FROM public.t;",
          [`${DRIZZLE_DIR}/meta/_journal.json`]: '{"x": "public.t"}',
          [`${DRIZZLE_DIR}/drizzle.config.ts`]: "// public.t\n",
          "other/0000_x.sql": "SELECT 1 FROM public.t;",
        });

        // when
        const result = {
          sql: listDrizzleSqlFiles(root),
          violations: collectMigrationViolations(root),
        };

        // then
        expect(result).toEqual({
          sql: [
            `${DRIZZLE_DIR}/0000_create.sql`,
            `${DRIZZLE_DIR}/0001_fk.sql`,
            `${DRIZZLE_DIR}/nested/0002_x.sql`,
          ],
          violations: [
            `no-public-schema-qualifier: ${DRIZZLE_DIR}/0001_fk.sql の 2 文目が表を "public". で修飾している`,
            `no-public-schema-qualifier: ${DRIZZLE_DIR}/nested/0002_x.sql の 1 文目が表を "public". で修飾している`,
          ],
        });
      },
    );

    And(
      "drizzle のディレクトリが無ければ対象は 0 件で違反も 0 件になる（本番の検査は 0 件を失敗にする）",
      () => {
        // given
        const root = fixture({ "README.md": "# x\n" });

        // when
        const result = {
          sql: listDrizzleSqlFiles(root),
          violations: collectMigrationViolations(root),
        };

        // then
        expect(result).toEqual({ sql: [], violations: [] });
      },
    );
  });

  Scenario("実ファイル", ({ And }) => {
    And("drizzle の SQL は表を public で修飾しない", () => {
      // given: 実ファイル（repoRoot）
      // when
      const files = listDrizzleSqlFiles(repoRoot);
      const violations = collectMigrationViolations(repoRoot);

      // then
      // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
      //   最初のマイグレーションは消えない（消すと migrate の記録とずれる）ので、それが列挙に入ることを見る。
      expect(files).toContain(`${DRIZZLE_DIR}/0000_create_todos.sql`);
      expect(violations).toEqual([]);
    });
  });
});

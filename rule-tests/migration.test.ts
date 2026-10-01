// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは SQL とワークフローを文字列として読むだけで
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
import { afterAll, describe, expect, it } from "vitest";

// データの移行（backfill）の決まり（.claude/rules/backend.md の「永続化」。Issue #194。決定は
//   ADR docs/adr/workflow/20261001-backfill-after-traffic-switch.md）を機械的に検査するテスト。
// 決まり: スキーマの変更（drizzle のマイグレーション）はデプロイの切替の前、データの移行は切替の後に冪等な SQL で流す。
// WHY 検査する: 切替の前にデータを移すと、切替までの間に旧アプリが書いた行が漏れる（Issue #194 で、履歴の無い Todo が残り 500 に
//   なりうると分かった）。backfill は記録表を持たずに毎回すべてを流すので、冪等でない SQL は 2 回目で行を重ねる。どちらも
//   文章の決まりだけだと、ステップの並べ替え・冪等の書き忘れが黙って通る。
// 違反にするもの（規則）:
//   - idempotent-insert-select: apps/backend/shared/drizzle/ の下の *.sql（マイグレーションと backfill/）の文のうち、
//     `INSERT INTO … SELECT` を含む文に `WHERE NOT EXISTS` も `ON CONFLICT … DO NOTHING` も無い。
//     WHY マイグレーションも見る: マイグレーションのデータの移行（0002 の INSERT）も新しい DB では backfill と同じ形で流れ、
//     冪等にしておけば backfill に移すときに書き直さずに済む。
//     読み方: `--` から行末と `/* … */` をコメントとして消し（コメントの中の文字で通さない）、`;` と drizzle の区切り
//     `--> statement-breakpoint`（コメントとして消える）で文に分ける。大文字小文字と改行は問わない。
//     限界: 文字列リテラルの中の `--`・`;` を区別しない（backfill の SQL に文字列の中の `--` は無い想定）。`WHERE NOT EXISTS` が
//     どの副問い合わせの条件か（同じ行を見ているか）は見ない（backfill.test.ts の「2 回流しても行は増えない」が実 DB で確かめる）。
//     `INSERT … VALUES`・`UPDATE`・`DELETE` は見ない（今は INSERT … SELECT だけを使う）。
//     `WHERE NOT EXISTS` の並びの字句で見るので、`WHERE t.completed AND NOT EXISTS (…)` のように条件の途中の NOT EXISTS は
//     違反にする（誤検出。NOT EXISTS を WHERE の先頭に書く）。文字列リテラルの中の `where not exists` は通してしまう（見逃し）。
//   - no-public-schema-qualifier: apps/backend/shared/drizzle/ の下の *.sql の文に、表のスキーマ修飾 `"public".`
//     （引用符なしの `public.` も。大文字小文字と `.` の前後の空白は問わない）がある（Issue #192）。
//     WHY: drizzle-kit 0.31.11 の generate は schema.ts の `.references()` を `REFERENCES "public"."todos"` と書く。
//     createTestDatabase() はテストファイルごとの別スキーマ（search_path）にマイグレーションを当てるので、public を指す SQL は
//     テストのスキーマの表を指さず、外部キーが public の表を参照して壊れる。外部キーは --custom の SQL にスキーマなしで書く
//     （.claude/skills/db-migration/SKILL.md）。
//     読み方: idempotent-insert-select と同じくコメントを消して文に分ける（コメントの中の WHY の説明で落とさない）。
//     限界: 文字列リテラルの中の `public.` も違反にする（誤検出。今の SQL には無い）。`"public"` 以外のスキーマの修飾は見ない。
//   - backfill-after-traffic: .github/workflows/deploy.yml に `pnpm,db:backfill` を run に持つステップが無い、そのステップが
//     トラフィックの切替（run に `update-traffic`）のステップより前にある、run に `--wait` が無い、run に失敗を打ち消すつなぎ
//     （`||`・`; exit 0`・末尾の `&`・`| cat`）がある、ステップに `continue-on-error:`（`false` 以外）がある。
//     WHY --wait も: 待たないと backfill の失敗でステップが赤にならず、データの移行が終わっていないことに気づけない。
//     限界: ステップは「行頭が `- key:` の行」で区切り、コメントの行（`#` で始まる）は除いて読む（rule-tests/test-support.test.ts の
//     deploy-verifies-images と同じ読み方）。ステップの if・ジョブの名前・環境は見ない。
//   - backfill-file-name: apps/backend/shared/drizzle/backfill/ の直下のエントリの名前が `NNNN_<name>.sql`（4 桁の番号、`_`、
//     英小文字・数字の `_` 区切り）でない（ディレクトリ・.sql でないファイルも違反）。
//     WHY: backfill.ts は名前順に流すので、番号で順を決める。.sql でないファイルは流されないまま置かれる。
// 検査の対象の列挙（drizzle の *.sql・backfill/ のエントリ・deploy.yml のステップ）が 0 件なら、実ファイルのテストで失敗させる。

const DRIZZLE_DIR = "apps/backend/shared/drizzle";
const BACKFILL_DIR = `${DRIZZLE_DIR}/backfill`;
const DEPLOY_WORKFLOW = ".github/workflows/deploy.yml";

// ---- idempotent-insert-select ----

// コメント（`--` から行末と `/* … */`）を消して `;` で文に分け、空の文を除く。
function sqlStatements(sql: string): string[] {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

// INSERT … SELECT の文で、WHERE NOT EXISTS も ON CONFLICT … DO NOTHING も無いもの（1 始まりの文の番号）。
function findNonIdempotentInserts(sql: string): number[] {
  return sqlStatements(sql).flatMap((statement, index) => {
    if (!/\binsert\s+into\b[\s\S]*\bselect\b/i.test(statement)) return [];
    const guarded =
      /\bwhere\s+not\s+exists\b/i.test(statement) ||
      /\bon\s+conflict\b[^;]*?\bdo\s+nothing\b/i.test(statement);
    return guarded ? [] : [index + 1];
  });
}

// ---- no-public-schema-qualifier ----

// 表をスキーマ名 public で修飾した文（1 始まりの文の番号）。
// WHY `\bpublic`: `is_public.`・`"is_public".` のように名前の一部の public は修飾ではない（`_` は単語の文字なので境界にならない）。
function findPublicSchemaQualifiers(sql: string): number[] {
  return sqlStatements(sql).flatMap((statement, index) =>
    /(?:"public"|\bpublic)\s*\.\s*["\w]/i.test(statement) ? [index + 1] : [],
  );
}

// ---- backfill-after-traffic ----

const stepLine = (line: string) => line.trim().replace(/^-\s+/, "");
const indentOf = (line: string) => line.length - line.trimStart().length;

// ワークフローのステップ（`- key:` で始まるリストの要素）ごとの行。コメントの行と空行は除く
//   （rule-tests/test-support.test.ts の readSteps と同じ読み方。テストのファイルどうしは import しないので写している）。
function readSteps(yaml: string): string[][] {
  const lines = yaml
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  const steps: string[][] = [];
  let current: { indent: number; lines: string[] } | undefined;
  for (const line of lines) {
    const startsStep = /^\s*-\s+[\w-]+:/.test(line);
    if (
      current !== undefined &&
      (indentOf(line) < current.indent ||
        (startsStep && indentOf(line) === current.indent))
    ) {
      steps.push(current.lines);
      current = undefined;
    }
    if (current === undefined && startsStep) {
      current = { indent: indentOf(line), lines: [] };
    }
    current?.lines.push(line);
  }
  if (current !== undefined) steps.push(current.lines);
  return steps;
}

// ステップの run の中身（`run:` の行の後ろと、それより深い行）。run が無ければ空文字。
function runOf(step: string[]): string {
  const index = step.findIndex((line) => /^run:/.test(stepLine(line)));
  if (index === -1) return "";
  const runLine = step[index] ?? "";
  const keyIndent =
    indentOf(runLine) + (runLine.trim().startsWith("-") ? 2 : 0);
  const rest = step.slice(index + 1);
  const end = rest.findIndex((line) => indentOf(line) <= keyIndent);
  const body = end === -1 ? rest : rest.slice(0, end);
  return [stepLine(runLine).slice("run:".length), ...body].join("\n");
}

// 失敗を打ち消すつなぎ（`||`・`; exit 0`・行末の `&`・`| cat`）。
function swallowsFailure(run: string): boolean {
  return (
    /\|\|/.test(run) ||
    /;\s*exit\s+0\b/.test(run) ||
    /(^|[^&])&\s*$/m.test(run) ||
    /\|\s*cat\b/.test(run)
  );
}

// ステップに `continue-on-error:` があり、値が false でないか（`true`・式 `${{ … }}` も失敗を打ち消しうるので違反にする）。
// WHY: 付けると backfill が失敗しても job が緑のまま終わる（rule-tests/typecheck.test.ts・work-logs-check.test.ts と同じ判定）。
function continuesOnError(step: string[]): boolean {
  return step.some((line) => {
    const match = /^continue-on-error:\s*(.*)$/.exec(stepLine(line));
    return match !== null && match[1]?.trim() !== "false";
  });
}

function findBackfillStepViolations(yaml: string): string[] {
  const steps = readSteps(yaml);
  const runs = steps.map(runOf);
  const backfill = runs.findIndex((run) => run.includes("pnpm,db:backfill"));
  if (backfill === -1) return ["pnpm,db:backfill を実行するステップが無い"];
  const traffic = runs.findIndex((run) => run.includes("update-traffic"));
  const run = runs[backfill] ?? "";
  return [
    ...(traffic === -1
      ? ["update-traffic のステップが無い"]
      : traffic > backfill
        ? ["backfill のステップが update-traffic のステップより前にある"]
        : []),
    ...(/(^|\s)--wait(?=\s|$)/m.test(run)
      ? []
      : ["backfill の run に --wait が無い"]),
    ...(swallowsFailure(run)
      ? ["backfill の run に失敗を打ち消すつなぎがある"]
      : []),
    ...(continuesOnError(steps[backfill] ?? [])
      ? ["backfill のステップに continue-on-error がある"]
      : []),
  ];
}

// ---- backfill-file-name ----

function isBackfillFileName(name: string): boolean {
  return /^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/.test(name);
}

// ---- 列挙と検査（本番と fixture で同じ処理を通す） ----

// apps/backend/shared/drizzle/ の下の *.sql（再帰。backfill/ を含む）。リポジトリ相対の / 区切りで、名前順。無ければ空。
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

// apps/backend/shared/drizzle/backfill/ の直下のエントリの名前（ファイルもディレクトリも）。名前順。無ければ空。
function listBackfillEntries(root: string): string[] {
  try {
    return readdirSync(join(root, BACKFILL_DIR)).sort();
  } catch {
    return [];
  }
}

function collectMigrationViolations(root: string): string[] {
  const inserts = listDrizzleSqlFiles(root).flatMap((path) =>
    findNonIdempotentInserts(readFileSync(join(root, path), "utf8")).map(
      (n) =>
        `idempotent-insert-select: ${path} の ${n} 文目の INSERT … SELECT に WHERE NOT EXISTS も ON CONFLICT DO NOTHING も無い`,
    ),
  );
  const names = listBackfillEntries(root)
    .filter((name) => !isBackfillFileName(name))
    .map(
      (name) =>
        `backfill-file-name: ${BACKFILL_DIR}/${name} は NNNN_<name>.sql でない`,
    );
  let workflow: string;
  try {
    workflow = readFileSync(join(root, DEPLOY_WORKFLOW), "utf8");
  } catch {
    workflow = "";
  }
  const steps = findBackfillStepViolations(workflow).map(
    (message) => `backfill-after-traffic: ${DEPLOY_WORKFLOW}: ${message}`,
  );
  const qualifiers = listDrizzleSqlFiles(root).flatMap((path) =>
    findPublicSchemaQualifiers(readFileSync(join(root, path), "utf8")).map(
      (n) =>
        `no-public-schema-qualifier: ${path} の ${n} 文目が表を "public". で修飾している`,
    ),
  );
  return [...inserts, ...qualifiers, ...names, ...steps];
}

const repoRoot = join(import.meta.dirname, "..");
const lines = (...parts: string[]) => parts.join("\n");

describe("INSERT … SELECT の冪等（findNonIdempotentInserts）", () => {
  it.each([
    [
      "WHERE NOT EXISTS",
      lines(
        'INSERT INTO "x" ("a") SELECT "id" FROM "t"',
        'WHERE NOT EXISTS (SELECT 1 FROM "x" s WHERE s."a" = "t"."id");',
      ),
    ],
    [
      "ON CONFLICT DO NOTHING（対象の列なし）",
      'INSERT INTO "x" ("a") SELECT "id" FROM "t" ON CONFLICT DO NOTHING;',
    ],
    [
      "ON CONFLICT (列) DO NOTHING と FOR UPDATE OF",
      lines(
        "insert into x (a, b) select t.id, 0 from t",
        "for update of t",
        "on conflict (a, b) do nothing;",
      ),
    ],
    ["小文字と改行", "insert\ninto x select 1\nwhere\nnot\nexists (select 1);"],
    ["INSERT … VALUES（対象外）", "INSERT INTO x (a) VALUES (1);"],
    ["ALTER・CREATE だけ", 'ALTER TABLE "x" ADD CONSTRAINT "c" CHECK (true);'],
    [
      "コメントの中だけの INSERT … SELECT",
      lines(
        "-- INSERT INTO x SELECT 1 FROM t;",
        "/* INSERT INTO x SELECT 1 */",
      ),
    ],
    [
      "drizzle の区切りでつないだ 2 文がどちらも冪等",
      lines(
        "INSERT INTO x SELECT 1 WHERE NOT EXISTS (SELECT 1);--> statement-breakpoint",
        "INSERT INTO y SELECT 1 ON CONFLICT DO NOTHING;",
      ),
    ],
    ["空", ""],
  ])("%s は違反なし", (_name, sql) => {
    expect(findNonIdempotentInserts(sql)).toEqual([]);
  });

  it.each<[string, string, number[]]>([
    ["守りが無い", 'INSERT INTO "x" ("a") SELECT "id" FROM "t";', [1]],
    [
      "WHERE だけ（NOT EXISTS でない）",
      'INSERT INTO "x" SELECT "id" FROM "t" WHERE "completed";',
      [1],
    ],
    [
      "NOT EXISTS がコメントの中だけ",
      lines(
        "INSERT INTO x SELECT 1 FROM t -- WHERE NOT EXISTS (SELECT 1)",
        ";",
      ),
      [1],
    ],
    [
      "NOT EXISTS がブロックコメントの中だけ",
      "INSERT INTO x SELECT 1 FROM t /* ON CONFLICT DO NOTHING */;",
      [1],
    ],
    [
      "ON CONFLICT DO UPDATE（DO NOTHING でない）",
      "INSERT INTO x SELECT 1 FROM t ON CONFLICT (a) DO UPDATE SET a = 1;",
      [1],
    ],
    [
      "2 文目だけ守りが無い（drizzle の区切り）",
      lines(
        "INSERT INTO x SELECT 1 WHERE NOT EXISTS (SELECT 1);--> statement-breakpoint",
        "INSERT INTO y SELECT 1 FROM t WHERE completed;",
      ),
      [2],
    ],
    [
      "前の文の NOT EXISTS は次の文を守らない",
      lines(
        "SELECT 1 WHERE NOT EXISTS (SELECT 1);",
        "INSERT INTO y SELECT 1 FROM t;",
      ),
      [2],
    ],
    ["小文字と改行", "insert\ninto\nx\nselect\n1\nfrom t", [1]],
  ])("%s は違反", (_name, sql, expected) => {
    expect(findNonIdempotentInserts(sql)).toEqual(expected);
  });
});

describe("public のスキーマ修飾（findPublicSchemaQualifiers）", () => {
  it.each([
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
  ])("%s は違反なし", (_name, sql) => {
    expect(findPublicSchemaQualifiers(sql)).toEqual([]);
  });

  it.each([
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
  ])("%s は違反", (_name, sql, expected) => {
    expect(findPublicSchemaQualifiers(sql)).toEqual(expected);
  });
});

describe("backfill のステップの位置（findBackfillStepViolations）", () => {
  const step = (name: string, run: string) =>
    lines(
      "      - if: steps.config.outputs.ready == 'true'",
      `        name: ${name}`,
      `        run: ${run}`,
    );
  const traffic = step(
    "Route traffic to latest revision",
    'gcloud run services update-traffic "$SERVICE" --to-latest --region "$REGION" --quiet',
  );
  const backfillRun =
    'gcloud run jobs execute "$MIGRATE_JOB" --region "$REGION" --wait --args=pnpm,db:backfill';
  const backfill = step("Run backfill", backfillRun);
  const migrate = step(
    "Run migrations",
    'gcloud run jobs execute "$MIGRATE_JOB" --region "$REGION" --wait',
  );
  const workflow = (...steps: string[]) =>
    lines("jobs:", "  deploy:", "    steps:", ...steps);

  it.each([
    ["update-traffic の直後", workflow(migrate, traffic, backfill)],
    [
      "間に別のステップ・コメントがある",
      workflow(
        traffic,
        "      # 確認",
        step("Smoke test", "curl -f https://example.com"),
        backfill,
      ),
    ],
    [
      "run が複数行（|）",
      workflow(
        traffic,
        lines(
          "      - name: Run backfill",
          "        run: |",
          '          gcloud run jobs execute "$MIGRATE_JOB" \\',
          "            --wait --args=pnpm,db:backfill",
        ),
      ),
    ],
    [
      "continue-on-error: false",
      workflow(traffic, lines(backfill, "        continue-on-error: false")),
    ],
  ])("%s は違反なし", (_name, yaml) => {
    expect(findBackfillStepViolations(yaml)).toEqual([]);
  });

  it.each<[string, string, string[]]>([
    [
      "backfill のステップが無い",
      workflow(migrate, traffic),
      ["pnpm,db:backfill を実行するステップが無い"],
    ],
    [
      "update-traffic の前（migrate の直後）にある",
      workflow(migrate, backfill, traffic),
      ["backfill のステップが update-traffic のステップより前にある"],
    ],
    [
      "update-traffic のステップが無い",
      workflow(migrate, backfill),
      ["update-traffic のステップが無い"],
    ],
    [
      "コメントアウトしたステップ",
      workflow(
        traffic,
        backfill
          .split("\n")
          .map((line) => `      # ${line.trim()}`)
          .join("\n"),
      ),
      ["pnpm,db:backfill を実行するステップが無い"],
    ],
    [
      "名前だけで run に pnpm,db:backfill が無い",
      workflow(traffic, step("Run backfill", "echo pnpm db:backfill")),
      ["pnpm,db:backfill を実行するステップが無い"],
    ],
    [
      "continue-on-error: true（失敗しても job が緑）",
      workflow(traffic, lines(backfill, "        continue-on-error: true")),
      ["backfill のステップに continue-on-error がある"],
    ],
    [
      "continue-on-error が式",
      workflow(
        traffic,
        lines(backfill, `        continue-on-error: $\{{ vars.X == 'y' }}`),
      ),
      ["backfill のステップに continue-on-error がある"],
    ],
    [
      "--wait が無い",
      workflow(
        traffic,
        step(
          "Run backfill",
          'gcloud run jobs execute "$MIGRATE_JOB" --args=pnpm,db:backfill',
        ),
      ),
      ["backfill の run に --wait が無い"],
    ],
    [
      "--wait-x（別のフラグ）",
      workflow(
        traffic,
        step(
          "Run backfill",
          "gcloud run jobs execute j --wait-x --args=pnpm,db:backfill",
        ),
      ),
      ["backfill の run に --wait が無い"],
    ],
    ...[
      `${backfillRun} || true`,
      `${backfillRun}; exit 0`,
      `${backfillRun} &`,
      `${backfillRun} | cat`,
    ].map((run): [string, string, string[]] => [
      `失敗を打ち消すつなぎ（${run.slice(backfillRun.length).trim()}）`,
      workflow(traffic, step("Run backfill", run)),
      ["backfill の run に失敗を打ち消すつなぎがある"],
    ]),
    ["空", "", ["pnpm,db:backfill を実行するステップが無い"]],
  ])("%s は違反", (_name, yaml, expected) => {
    expect(findBackfillStepViolations(yaml)).toEqual(expected);
  });
});

describe("backfill のファイル名（isBackfillFileName）", () => {
  it.each(["0001_todo_status_changes.sql", "0002_x.sql", "9999_a1_b2.sql"])(
    "%s は違反なし",
    (name) => {
      expect(isBackfillFileName(name)).toBe(true);
    },
  );

  it.each([
    "001_x.sql",
    "00001_x.sql",
    "0001-x.sql",
    "0001_.sql",
    "0001_X.sql",
    "0001_x-y.sql",
    "0001_x.SQL",
    "0001_x.sql.bak",
    "0001_x",
    "x_0001.sql",
    "README.md",
    "",
  ])("%s は違反", (name) => {
    expect(isBackfillFileName(name)).toBe(false);
  });
});

describe("列挙と検査（fixture）", () => {
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

  it("drizzle の *.sql（backfill/ を含む）・backfill/ の名前・deploy.yml を検査し、違反を規則ごとに返す（冪等・public の修飾・名前・ステップの順）", () => {
    const root = fixture({
      [`${DRIZZLE_DIR}/0000_create.sql`]: "CREATE TABLE x (a int);",
      [`${DRIZZLE_DIR}/0001_data.sql`]: "INSERT INTO x SELECT 1 FROM t;",
      [`${DRIZZLE_DIR}/meta/_journal.json`]: "{}",
      [`${DRIZZLE_DIR}/drizzle.config.ts`]:
        "// INSERT INTO x SELECT 1 FROM t;\n",
      [`${BACKFILL_DIR}/0001_ok.sql`]:
        'INSERT INTO x SELECT 1 FROM "public"."t" ON CONFLICT DO NOTHING;',
      [`${BACKFILL_DIR}/0002_bad.sql`]:
        "INSERT INTO x SELECT 1 FROM t WHERE NOT EXISTS (SELECT 1);\nINSERT INTO y SELECT 1 FROM t;",
      [`${BACKFILL_DIR}/notes.md`]: "INSERT INTO x SELECT 1 FROM t;",
      [`${BACKFILL_DIR}/nested/0003_x.sql`]: "SELECT 1;",
      [DEPLOY_WORKFLOW]: lines(
        "jobs:",
        "  deploy:",
        "    steps:",
        "      - name: Run backfill",
        "        run: gcloud run jobs execute j --wait --args=pnpm,db:backfill",
        "      - name: Route traffic",
        "        run: gcloud run services update-traffic s --to-latest",
      ),
    });
    expect({
      sql: listDrizzleSqlFiles(root),
      backfill: listBackfillEntries(root),
      violations: collectMigrationViolations(root),
    }).toEqual({
      sql: [
        `${DRIZZLE_DIR}/0000_create.sql`,
        `${DRIZZLE_DIR}/0001_data.sql`,
        `${BACKFILL_DIR}/0001_ok.sql`,
        `${BACKFILL_DIR}/0002_bad.sql`,
        `${BACKFILL_DIR}/nested/0003_x.sql`,
      ],
      backfill: ["0001_ok.sql", "0002_bad.sql", "nested", "notes.md"],
      violations: [
        `idempotent-insert-select: ${DRIZZLE_DIR}/0001_data.sql の 1 文目の INSERT … SELECT に WHERE NOT EXISTS も ON CONFLICT DO NOTHING も無い`,
        `idempotent-insert-select: ${BACKFILL_DIR}/0002_bad.sql の 2 文目の INSERT … SELECT に WHERE NOT EXISTS も ON CONFLICT DO NOTHING も無い`,
        `no-public-schema-qualifier: ${BACKFILL_DIR}/0001_ok.sql の 1 文目が表を "public". で修飾している`,
        `backfill-file-name: ${BACKFILL_DIR}/nested は NNNN_<name>.sql でない`,
        `backfill-file-name: ${BACKFILL_DIR}/notes.md は NNNN_<name>.sql でない`,
        `backfill-after-traffic: ${DEPLOY_WORKFLOW}: backfill のステップが update-traffic のステップより前にある`,
      ],
    });
  });

  it("drizzle・backfill/・deploy.yml が無ければ、SQL と名前の対象は 0 件で、ステップが無い違反だけになる（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      sql: listDrizzleSqlFiles(root),
      backfill: listBackfillEntries(root),
      violations: collectMigrationViolations(root),
    }).toEqual({
      sql: [],
      backfill: [],
      violations: [
        `backfill-after-traffic: ${DEPLOY_WORKFLOW}: pnpm,db:backfill を実行するステップが無い`,
      ],
    });
  });
});

describe("マイグレーションと backfill（実ファイル）", () => {
  it("drizzle の SQL は冪等で public の修飾が無く、backfill/ の名前は NNNN_<name>.sql、deploy.yml は切替の後に backfill を流す", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    expect(listDrizzleSqlFiles(repoRoot)).toEqual(
      expect.arrayContaining([
        `${DRIZZLE_DIR}/0002_todo_status_changes_foreign_key_and_backfill.sql`,
        `${BACKFILL_DIR}/0001_todo_status_changes.sql`,
      ]),
    );
    expect(listBackfillEntries(repoRoot)).toContain(
      "0001_todo_status_changes.sql",
    );
    expect(
      readSteps(readFileSync(join(repoRoot, DEPLOY_WORKFLOW), "utf8")).length,
    ).toBeGreaterThan(0);
    expect(collectMigrationViolations(repoRoot)).toEqual([]);
  });
});

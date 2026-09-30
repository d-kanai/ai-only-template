// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストは backend のソースを文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// 永続化の save の規則（.claude/rules/backend.md の「永続化」の `save`。Issue #165 / #172 / #177）を、backend のソースで
// 機械的に検査するテスト。対象は apps/backend/ の下のテスト以外の .ts（*.test.ts を除く）。
// 違反にするもの:
//   - no-upsert: `onConflictDoUpdate` / `onConflictDoNothing`（Drizzle の upsert）の名前がコードにあること。
//     WHY `.` と `(` を要求しない（名前だけを語の境界で探す）: 変数に入れ直す（`const f = q.onConflictDoUpdate`）・
//       ブラケット（`q["onConflictDoUpdate"](…)`）・`.` の後で改行する書き方も拾う。`onConflictDoUpdateLater` のような
//       名前の一部が一致するだけの別の名前は通す。
//     WHY: save は新規なら素の INSERT（2 回目は一意制約違反で気づく）、読み込み済みなら変わった列だけの UPDATE。upsert は
//       2 回目の save や id の衝突を黙って通し、全列を書いて同時更新の他方の変更を巻き戻す（lost update）。
//   - save-uses-changed-props: *.postgres.ts に save のメソッド定義（行の先頭が `save(` / `async save(`。`public` などの修飾子も可）が
//     あるのに、shared/infra/changed-props を値として import していない（`import type` は数えない）。
//     WHY: 読み込み済みの save は、読み込んだときの値（origin）と今の値を changedProps で比べて変わった列だけを書く。
//       自前の比較や全列の UPDATE に戻ると lost update が再発する。
//   - entity-with-reconstruct-has-origin: apps/backend/features/<f>/internal/domain/ の下で `static reconstruct(` を持つファイルが
//     `get origin()` を持たない。
//     WHY: Repository が差分を取るために、読み込んだとき（reconstruct）の値を Entity が持つ。
//   - no-update-delete-on-append-only-tables（Issue #188）: *.postgres.ts で `.update(<表>)` / `.delete(<表>)` の引数の表の名前
//     （識別子。`schema.x` のようなメンバーの参照は最後の名前）が `Changes` / `Events` / `Logs`（変更履歴。Issue #189）で終わる（`db.` / `tx.` などの受け手は
//     問わない。`.` と名前と `(` と引数の間の空白・改行は可）。行は update / delete の名前の行。`.insert(` と `.select()` は通す。
//     WHY: 遷移の履歴（todo_status_changes のような `*_changes` の子表）は insert のみの記録で、後から書き換える・消すと
//       「いつ何に変わったか」が失われる。消えるのは親を消したときの外部キーの on delete cascade だけ（ADR
//       docs/adr/architecture/20260930-status-transitions-as-append-only-child-table.md）。
//     WHY 表の名前の接尾辞で見分ける: insert のみの表を列挙すると、表を足したときに一覧への追加を忘れて素通りする。
//       命名（`*Changes` / `*Events`）に縛れば、足した表も同じ検査にかかる。
//     WHY *.postgres.ts だけ: DB に SQL を発行するのは Postgres の Repository だけ。InMemory の `Map#delete(id)` などは表ではない。
//     限界: 表を別名の変数に入れ直す（`const t = todoStatusChanges; db.delete(t)`）・ブラケット（`db["delete"](…)`）・生の SQL
//       （sql`delete from todo_status_changes`）は見ない。表の変数名が接尾辞に従っているかは、schema.ts で宣言した表なら
//       次の append-only-table-naming が見る。
//   - append-only-table-naming（Issue #188）: apps/backend/features/<f>/internal/infra/schema.ts（と shared/infra/schema.ts）で、
//     `pgTable("<表名>"` の表名が `_changes` / `_events` / `_logs` で終わるのに、それを受ける変数（`const <名前> =` の直後の
//     pgTable）の名前が `Changes` / `Events` / `Logs` で終わらない（変数で受けていない `export default pgTable(…)` も違反）。行は pgTable の行。`pgTable(` と表名の間の空白・改行は可、
//     表名の引用符は `"` / `'` / `` ` ``。
//     WHY: no-update-delete-on-append-only-tables は変数名の接尾辞で insert のみの表を見分けるので、
//       `export const statusLog = pgTable("todo_status_changes", …)` のように表名と変数名がずれると素通りする。表名（DB の命名）
//       から変数名を縛れば、insert のみの表は必ずその検査にかかる。
//     WHY schema.ts だけ: 表の宣言の置き場所は features/<f>/internal/infra/schema.ts と、横断の表の shared/infra/schema.ts だけ
//       （drizzle-kit の設定が読む場所。.claude/rules/backend.md）。
//     限界: 表名が `_changes` / `_events` で終わらない insert のみの表（命名の規約そのもの）、`pgSchema("s").table(…)`・
//       pgTable を別名で import した宣言、型注釈付きの変数（`const x: T = pgTable(…)`。違反と数える）、分割代入は見ない。
//   - writes-through-write-in-transaction（Issue #189 の writes-record-change-log を Issue #205 で置き換え）: *.postgres.ts に書き込み
//     （`.insert(` / `.update(` / `.delete(`。`.` と名前と `(` の間の空白・改行は可）があるのに、書き込みの唯一の入口
//     shared/infra/write（writeInTransaction）を値として import していない。行は書き込みの名前の行（書き込みごと）。
//     WHY: 書き込みは writeInTransaction を通す。通れば、変更履歴（change_logs。ADR
//       docs/adr/architecture/20260930-change-logs-written-by-repository.md）が本体と同じトランザクションで書かれ、前後のログが
//       Repository ごとの記述なしに出る（ADR docs/adr/architecture/20260930-repository-write-log.md）。import が無ければ通っていない。
//     WHY change-log の import では満たさない（以前の writes-record-change-log）: 記録の組み立て（insertEntry など）の import だけで
//       は、トランザクション・記録の書き込み・ログを通したことにならない。
//     限界: import していても、書き込みが writeInTransaction のコールバックの中（tx）で行われているかは見ない（コールバックから
//       呼ぶ private メソッドの中の `writer.insert(` もあり、字句の範囲では決められない）。`db` を直接使った書き込みは次の
//       no-direct-db-write が止める。Repository のテストがログと記録の行を固定する。
//     限界: 生の SQL（`this.db.execute(sql\`insert …\`)`）・ドライバの直接の呼び出し（`this.db.$client.query(…)`）の書き込みは
//       `.insert(` などの形でないので見ない。import はブロックコメント（`/* … */`）の中にあるだけでも満たしたと見なす。
//   - no-direct-transaction（Issue #205）: *.postgres.ts に `transaction` の名前（語の境界。`db.transaction(`・`tx.transaction(`
//     （セーブポイント）・ブラケット `db["transaction"]`・分割代入 `const { transaction } = db`・`.` の後の改行）がある。行はその名前の行。
//     WHY: トランザクションを張るのは writeInTransaction だけにする。Repository が直接張ると、前後のログと変更履歴の書き込みを
//       通らない書き込みができる。
//     WHY `.` と `(` を要求しない（no-upsert と同じ）: 変数に入れ直す・ブラケットで呼ぶ書き方も拾う。`transactional(`・
//       `myTransaction(`・`transactions`・型の `Transaction`（大文字）は別の名前として通す。
//     限界: 文字列の中の `transaction`（ログの文言など）も違反と数える（安全側）。`db["trans" + "action"]` のような組み立ては見ない。
//       生の SQL（`this.db.execute(sql\`begin\`)`）・ドライバの直接の呼び出し（`this.db.$client.query("begin")`）でのトランザクションは
//       名前が出ないので見ない。文字列の中の `//` の後ろ（`"a//b"; db.transaction(…)` の同じ行）は、行の `//` 以降を落とすので見逃す。
//   - no-direct-record-change（Issue #205。Issue #189 の record-change-in-transaction を置き換え）: *.postgres.ts に `recordChange` の
//     名前（語の境界。呼び出し・import・別名の import の元の名前・名前空間の `changeLog.recordChange`）がある。行はその名前の行。
//     WHY: 変更履歴は writeInTransaction がコールバックの返した記録を同じトランザクションの最後に書く。Repository が直接書くと、
//       記録を 2 度書く・トランザクションの外で書く（記録の失敗で本体だけが残る）書き方ができる。以前の record-change-in-transaction
//       （`recordChange(` が `transaction(` の括弧の中か）は、記録の書き込みが writeInTransaction の中だけになり、要らなくなった
//       （記録が本体と同じトランザクションで書かれることは write.test.ts と todo-repository.postgres.test.ts が実行で固定する）。
//     限界: 文字列の中の `recordChange` も違反と数える（安全側）。名前を組み立てて参照する書き方は見ない。
//   - no-direct-db-write（Issue #205）: *.postgres.ts で `db` を受け手にした書き込み（`db.insert(` / `db.update(` / `db.delete(`。
//     `this.db.` も `database.db.` も。`db` と `.` と名前と `(` の間の空白・改行は可）がある。行は書き込みの名前の行。
//     WHY: write を import したうえでコールバックの外で `this.db.insert(` と書くと、トランザクションもログも変更履歴も無しに書けて
//       しまう。書き込みは writeInTransaction がコールバックに渡す tx（とそれを受け取る private メソッドの writer）で行う。
//     WHY 受け手の名前 `db`（語の境界）で見る: Repository は db をコンストラクタで受け取り `this.db` で使う（.claude/rules/backend.md）。
//       `mydb`・`this.dbx` のような名前に db を含むだけの受け手は通す。
//     限界: `const w = this.db; w.insert(…)` のような別名、`this["db"]`、分割代入した関数の呼び出し、`db?.insert(` / `db!.insert(`
//       （`?.` / `!` は受け手の正規表現に一致しない）は見ない。文字列の中の `db.insert(` は違反と数える（安全側）。
//   - aggregate-loads-all-children（Issue #189。ユーザー判断 2026-09-30）: insert のみの子表（`Changes` / `Events` で終わる名前）を
//     import した *.postgres.ts で、(a) 親の `.from(<表>)` の chain に子表の `.leftJoin(` が無い（行ロック `.for(` の chain は除く）、
//     (b) 子表だけを `.from(<子表>)` で読む、(c) `.limit(` / `.offset(` / `.selectDistinctOn(`、(d) `.where(` の引数に子表の列がある。
//     WHY: 集約は常に全体（全件の履歴）を読んで reconstruct の不変条件で検証する。WHY と限界は partialAggregateReads のコメント。
// 変更履歴の表（change_logs。変数名 changeLogs）も insert のみ: no-update-delete-on-append-only-tables と append-only-table-naming は
//   `Logs` / `_logs` も対象にし、append-only-table-naming は横断の表の置き場所 shared/infra/schema.ts も見る（Issue #189）。
// コメントと文字列の扱い（限界）: 各行の `//` 以降を落としてから探す（「// .onConflictDoUpdate( は使わない」を違反と数えない）。
//   文字列の中身は解釈しない。そのため、文字列の中の `//` の後ろは見逃し、文字列の中の `.onConflictDoUpdate(` は違反と数える。
//   ブロックコメント（`/* … */`）の中はコードと同じに扱う（upsert は安全側で違反になるが、`get origin()` と changed-props の
//   import は、ブロックコメントの中にあるだけで満たしたと見なす）。生の SQL（sql`… ON CONFLICT …`）、`save = async (…) =>`
//   のようなプロパティでの定義、import した changedProps を実際に呼んでいるかは見ない。
// 判定の粒度の限界:
//   - `get origin()` の有無はファイル単位で見る（1 ファイルに class が 2 つあると、片方だけが origin を持っていても通る）。
//   - `static async reconstruct(` / `static reconstruct = …` のような書き方の reconstruct は見ない。
//   - `import { type changedProps } from "…/changed-props"`（inline の type）も値の import と数える（`import type` だけを除く）。
//   - 行頭が `save(` の行は定義と見なすので、行頭の素の呼び出し（`save(x);`）も定義として数える（安全側）。
// WHY 文字列で判定する（AST にしない）: 見るのはメソッド名・import の参照先・getter の有無だけで、行単位の正規表現で足りる。

type RuleId =
  | "no-upsert"
  | "save-uses-changed-props"
  | "entity-with-reconstruct-has-origin"
  | "no-update-delete-on-append-only-tables"
  | "append-only-table-naming"
  | "writes-through-write-in-transaction"
  | "no-direct-transaction"
  | "no-direct-record-change"
  | "no-direct-db-write"
  | "aggregate-loads-all-children";

type PersistenceViolation = { rule: RuleId; line: number };

// 各行の `//` 以降を落とした行の配列（行の数と位置は変えない。行番号を元のソースと合わせるため）。
function codeLines(source: string): string[] {
  return source.split("\n").map((line) => line.split("//")[0] ?? "");
}

// パターンに一致する行の行番号（1 始まり）。
function matchingLines(lines: string[], pattern: RegExp): number[] {
  return lines.flatMap((line, index) =>
    pattern.test(line) ? [index + 1] : [],
  );
}

// shared/infra/<name> を値として import しているか（複数行の import も読む。`import type` は数えない）。
function importsSharedInfra(code: string, name: string): boolean {
  const imports = code.matchAll(
    /\bimport\s+(type\s+)?[^;]*?\bfrom\s*(["'])([^"'\n]+)\2/g,
  );
  // WHY 前後を区切る: `changed-props-x` や shared/infra でない `./changed-props` は別のモジュール。
  const module = new RegExp(`(?:^|/)shared/infra/${name}(?:\\.[cm]?[jt]s)?$`);
  return [...imports].some(
    ([, typeOnly, , specifier = ""]) =>
      typeOnly === undefined && module.test(specifier),
  );
}

// code の中の位置（0 始まり）が何行目か（1 始まり）。
function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// open の位置の `(` に対応する `)` の位置。閉じが無ければ code の長さ（最後まで中とみなす）。
// WHY 括弧を数える: where( の引数は入れ子の括弧（関数の呼び出し）を含む。
// 限界: 文字列・正規表現の中の括弧も数える（今の Repository の書き方には現れない）。
function closingParen(code: string, open: number): number {
  let depth = 0;
  for (let index = open; index < code.length; index++) {
    if (code[index] === "(") depth++;
    if (code[index] === ")" && --depth === 0) return index;
  }
  return code.length;
}

// 書き込み（`.insert(` / `.update(` / `.delete(`。`.` と名前と `(` の間の空白・改行は可）の、名前の行番号（1 始まり）。
// receiver を渡すと、受け手がその正規表現に一致する書き込みだけを返す（no-direct-db-write の `db`）。
function writeLines(code: string, receiver = ""): number[] {
  return [
    ...code.matchAll(
      new RegExp(`${receiver}\\.\\s*(insert|update|delete)\\s*\\(`, "g"),
    ),
  ].map(({ 0: whole, index }) =>
    lineAt(code, index + whole.search(/insert|update|delete/)),
  );
}

// import の { … } で読んだ名前（`a as b` は b。`type` の印は除く）のうち、insert のみの子表（Changes / Events で終わる）。
// WHY Logs を含めない: 変更履歴（changeLogs。Issue #189）は監査用の横断の表で、集約の子ではない（集約の読み出しで JOIN しない）。
function importedChildTables(code: string): string[] {
  return [...code.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}/g)].flatMap(
    ({ 1: names = "" }) =>
      names
        .split(",")
        .map(
          (name) =>
            name
              .trim()
              .split(/\s+as\s+/)
              .at(-1)
              ?.trim() ?? "",
        )
        .filter((name) => /(?:Changes|Events)$/.test(name)),
  );
}

// 子表を import した *.postgres.ts の、集約を一部だけ読む書き方の行番号（1 始まり）。
//   (a) 子表でない表の `.from(<表>)` の chain（`.from(` から次の `;` まで）に、import した子表ごとの `.leftJoin(<子表>` が無い。
//       chain に `.for(`（行ロック）があれば対象外（save の存在確認。集約を組み立てない）。行は from の行。
//   (b) 子表の `.from(<子表>)`（子表だけを読む）。行は from の行。
//   (c) `.limit(` / `.offset(`（件数を絞る・飛ばす）、`.selectDistinctOn(`（親ごとに 1 行だけを読む）。行はその名前の行。
//   (d) `.where(` の引数に子表の列（`<子表>.<列>`）がある。行は where の行。orderBy・select の中は可。
// WHY: 集約は常に全体（全件の履歴）を読み、reconstruct の不変条件（最後の completed = completed など）で検証する。最新だけ・
//   一部だけを読むと不変条件を検証できず、部分的な集約が domain に入る。LEFT JOIN の WHERE で子表の列を絞ると、履歴の無い
//   親も外れる（INNER JOIN と同じになる）。
// 限界（字句の推定）: from / leftJoin / where の引数が変数経由（`.where(where)` に子表の条件を渡す、表を別名の変数に入れ直す）
//   なら見ない。leftJoin の結合条件（ON）で子表を絞る書き方、`;` を含む chain、`.for(` を含む chain での集約の読み出しは見逃す。
//   子表の import が名前空間（`import * as schema`）なら対象外。子表を import した *.postgres.ts で別の表だけ（change_logs など）を
//   `.from(` で読む書き方も (a) の違反になる（誤検知。今は無い）。`.for(` の付いた chain は行ロック（save の存在確認）と
//   みなして (a) を見ないので、`.for("update")` で集約を読む書き方は見逃す。
function partialAggregateReads(code: string): number[] {
  const children = importedChildTables(code);
  if (children.length === 0) {
    return [];
  }
  const isChild = (table: string) =>
    children.includes(table.split(".").at(-1)?.trim() ?? "");
  const lines: number[] = [];
  // WHY 大文字で始まる名前の .from( を除く: `Array.from(…)`・`Buffer.from(…)` はクラスの static メソッドで、クエリではない。
  for (const { 0: whole, 1: table = "", index } of code.matchAll(
    /(?<!\b[A-Z][\w$]*\s*)\.\s*from\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g,
  )) {
    const line = lineAt(code, index + whole.search(/from/));
    if (isChild(table)) {
      lines.push(line);
      continue;
    }
    const end = code.indexOf(";", index);
    const chain = code.slice(index, end === -1 ? code.length : end);
    const joinsAllChildren = children.every((child) =>
      new RegExp(`\\.\\s*leftJoin\\s*\\(\\s*${child}\\b`).test(chain),
    );
    if (!joinsAllChildren && !/\.\s*for\s*\(/.test(chain)) {
      lines.push(line);
    }
  }
  for (const { index } of code.matchAll(
    /\.\s*(?:limit|offset|selectDistinctOn)\s*\(/g,
  )) {
    lines.push(lineAt(code, index + code.slice(index).search(/[a-zA-Z]/)));
  }
  for (const { 0: whole, index } of code.matchAll(/\.\s*where\s*\(/g)) {
    const open = index + whole.length - 1;
    const args = code.slice(open, closingParen(code, open));
    const filtersChild = children.some((child) =>
      new RegExp(`\\b${child}\\s*\\.\\s*[A-Za-z_$]`).test(args),
    );
    if (filtersChild) {
      lines.push(lineAt(code, index + whole.search(/where/)));
    }
  }
  return lines;
}

// insert のみの表（名前が Changes / Events で終わる）への `.update(` / `.delete(` の、update / delete の名前の行番号（1 始まり）。
// WHY 行ではなく、行をつないだコード全体で探す: `.delete(` と表の名前の間に改行を挟む書き方（Biome の整形で chain が折り返される）も拾う。
// WHY 表の名前は `a.b.c` の最後の名前で見る: `schema.todoStatusChanges` のように名前空間から参照しても見分ける。
function appendOnlyTableWrites(lines: string[]): number[] {
  const code = lines.join("\n");
  const writes = code.matchAll(
    /\.\s*(?:update|delete)\s*\(\s*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)/g,
  );
  return [...writes].flatMap(({ 0: whole, 1: table = "", index }) => {
    const name = table.split(".").at(-1)?.trim() ?? "";
    if (!/(?:Changes|Events|Logs)$/.test(name)) {
      return [];
    }
    // `.` の後の空白・改行を飛ばした、update / delete の名前の位置で行を数える。
    const methodAt = index + whole.search(/update|delete/);
    return [code.slice(0, methodAt).split("\n").length];
  });
}

// schema.ts の `pgTable("<表名>"` で、表名が _changes / _events で終わるのに、受ける変数の名前が Changes / Events で終わらない
//   ものの、pgTable の行番号（1 始まり）。
// WHY 行ではなく、行をつないだコード全体で探す: `pgTable(` と表名の間に改行を挟む書き方（Biome の整形で引数が折り返される）も拾う。
// WHY 受ける変数は pgTable の直前が `const <名前> =` かで見る: `export const x = pgTable(` の形だけが今の書き方で、それ以外の
//   受け方（変数で受けない・関数で包む）は名前を確かめられないので違反にする（安全側）。
function appendOnlyTableNamingViolations(lines: string[]): number[] {
  const code = lines.join("\n");
  const tables = code.matchAll(/\bpgTable\s*\(\s*(["'`])([^"'`\n]*)\1/g);
  return [...tables].flatMap(({ 2: table = "", index }) => {
    if (!/_(?:changes|events|logs)$/.test(table)) {
      return [];
    }
    const before = code.slice(0, index);
    const variable =
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*$/.exec(before)?.[1] ??
      "";
    return /(?:Changes|Events|Logs)$/.test(variable)
      ? []
      : [before.split("\n").length];
  });
}

// path はリポジトリ相対の / 区切り。規則ごとに対象のパスを絞り、違反を行の順に返す。
function findPersistenceViolations(
  path: string,
  source: string,
): PersistenceViolation[] {
  if (!/^apps\/backend\/.+\.ts$/.test(path) || /\.test\.ts$/.test(path)) {
    return [];
  }
  const lines = codeLines(source);
  const violations: PersistenceViolation[] = matchingLines(
    lines,
    /\bonConflictDo(?:Update|Nothing)\b/,
  ).map((line) => ({ rule: "no-upsert", line }));

  if (/\.postgres\.ts$/.test(path)) {
    const code = lines.join("\n");
    violations.push(
      ...appendOnlyTableWrites(lines).map((line) => ({
        rule: "no-update-delete-on-append-only-tables" as const,
        line,
      })),
      ...(importsSharedInfra(code, "write") ? [] : writeLines(code)).map(
        (line) => ({
          rule: "writes-through-write-in-transaction" as const,
          line,
        }),
      ),
      ...matchingLines(lines, /\btransaction\b/).map((line) => ({
        rule: "no-direct-transaction" as const,
        line,
      })),
      ...matchingLines(lines, /\brecordChange\b/).map((line) => ({
        rule: "no-direct-record-change" as const,
        line,
      })),
      ...writeLines(code, "\\bdb\\s*").map((line) => ({
        rule: "no-direct-db-write" as const,
        line,
      })),
      ...partialAggregateReads(code).map((line) => ({
        rule: "aggregate-loads-all-children" as const,
        line,
      })),
    );
  }

  if (
    /^apps\/backend\/(?:features\/[^/]+\/internal|shared)\/infra\/schema\.ts$/.test(
      path,
    )
  ) {
    violations.push(
      ...appendOnlyTableNamingViolations(lines).map((line) => ({
        rule: "append-only-table-naming" as const,
        line,
      })),
    );
  }

  if (
    /\.postgres\.ts$/.test(path) &&
    !importsSharedInfra(lines.join("\n"), "changed-props")
  ) {
    const saveDefinitions = matchingLines(
      lines,
      /^\s*(?:(?:public|private|protected|override)\s+)*(?:async\s+)?save\s*[(<]/,
    );
    violations.push(
      ...saveDefinitions.map((line) => ({
        rule: "save-uses-changed-props" as const,
        line,
      })),
    );
  }

  // WHY domain の下の入れ子も対象にする: 規則の文書は features/<f>/internal/domain/*.ts だが、入れ子に Entity を置いたときに黙って
  //   外れないよう広めに取る（今は入れ子のディレクトリは無い）。
  if (
    /^apps\/backend\/features\/[^/]+\/internal\/domain\/.+\.ts$/.test(path) &&
    !lines.some((line) => /\bget\s+origin\s*\(\s*\)/.test(line))
  ) {
    violations.push(
      ...matchingLines(lines, /\bstatic\s+reconstruct\s*[(<]/).map((line) => ({
        rule: "entity-with-reconstruct-has-origin" as const,
        line,
      })),
    );
  }
  return violations.sort((a, b) => a.line - b.line);
}

// root の下を再帰的にたどり、ファイルのリポジトリ相対パス（/ 区切り）を返す。
// WHY node_modules と . で始まるディレクトリに入らない: 依存やビルド結果は検査の対象ではない。
function walk(root: string, dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name.startsWith(".")
        ? []
        : walk(root, path);
    }
    return entry.isFile() ? [path] : [];
  });
}

// 検査の対象: apps/backend の下のテスト以外の .ts。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listBackendSources(root: string): string[] {
  return walk(root, "apps/backend")
    .filter((path) => /\.ts$/.test(path) && !/\.test\.ts$/.test(path))
    .sort();
}

// 違反を「<規則>: <パス>:<行>」で返す。
function collectPersistenceViolations(root: string): string[] {
  return listBackendSources(root).flatMap((path) =>
    findPersistenceViolations(path, readFileSync(join(root, path), "utf8")).map(
      ({ rule, line }) => `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const POSTGRES =
  "apps/backend/features/x/internal/infra/x-repository.postgres.ts";
const IN_MEMORY =
  "apps/backend/features/x/internal/infra/x-repository.in-memory.ts";
const ENTITY = "apps/backend/features/x/internal/domain/x.ts";
const SCHEMA = "apps/backend/features/x/internal/infra/schema.ts";
const SHARED_SCHEMA = "apps/backend/shared/infra/schema.ts";
const IMPORT_CHANGED_PROPS =
  'import { changedProps } from "../../../../shared/infra/changed-props";';
const IMPORT_WRITE =
  'import { writeInTransaction } from "../../../../shared/infra/write";';
const IMPORT_CHILD = 'import { todoStatusChanges, todos } from "./schema";';
// 書き込み（insert / update / delete）を含む例に write の import を最後の行に足す（writes-through-write-in-transaction を満たす）。
// WHY 最後の行に足す: ほかの規則の例の行番号を変えずに、その規則だけを見る例にする（検査は import の位置を問わない）。
const withWrite = (...lines: string[]) => source(...lines, IMPORT_WRITE);

describe("永続化の判定（findPersistenceViolations）: must pass", () => {
  it.each([
    [
      "*.postgres.ts の save が changed-props を import している（素の INSERT と差分の UPDATE）",
      POSTGRES,
      withWrite(
        IMPORT_CHANGED_PROPS,
        "export class XRepository {",
        "  async save(x: X): Promise<void> {",
        "    await tx.insert(xs).values(row);",
        "  }",
        "}",
      ),
    ],
    [
      "複数行の import で changed-props を読む（拡張子付き）",
      POSTGRES,
      source(
        "import {",
        "  changedProps,",
        '} from "../../../../shared/infra/changed-props.ts";',
        "class XRepository {",
        "  save(x: X) {}",
        "}",
      ),
    ],
    [
      "save を定義していない *.postgres.ts は import 不要（save を呼ぶだけの行も定義ではない）",
      POSTGRES,
      source(
        "export class XReader {",
        "  async findAll(): Promise<X[]> {",
        "    await other.save(x);",
        "    return [];",
        "  }",
        "}",
      ),
    ],
    [
      "*.postgres.ts でない Repository（in-memory）の save は import 不要",
      IN_MEMORY,
      source("class InMemoryXRepository {", "  async save(x: X) {}", "}"),
    ],
    [
      "コメントの中の .onConflictDoUpdate( / .onConflictDoNothing(",
      POSTGRES,
      withWrite(
        "// .onConflictDoUpdate( で上書きしない。",
        "await tx.insert(xs).values(row); // .onConflictDoNothing() も使わない",
      ),
    ],
    [
      "名前の一部が一致するだけの別のメソッド（onConflictDoUpdateLater / saveAll / resave）",
      POSTGRES,
      source(
        "q.onConflictDoUpdateLater(x);",
        "class XRepository {",
        "  async saveAll(xs: X[]) {}",
        "  resave(x: X) {}",
        "}",
      ),
    ],
    [
      "Entity が static reconstruct( と get origin() を持つ",
      ENTITY,
      source(
        "export class X {",
        "  get origin(): Readonly<XProps> | undefined {",
        "    return this.#origin;",
        "  }",
        "  static reconstruct(values: XProps): X {",
        "    return new X(values, (valid) => valid);",
        "  }",
        "}",
      ),
    ],
    [
      "reconstruct も origin も無い domain のファイル",
      "apps/backend/features/x/internal/domain/x-repository.ts",
      source(
        "export interface XRepository {",
        "  save(x: X): Promise<void>;",
        "}",
      ),
    ],
    [
      "コメントの中の static reconstruct(",
      ENTITY,
      source(
        "// static reconstruct( は Repository が使う。",
        "export class X {}",
      ),
    ],
    [
      "テストファイル（*.test.ts）は対象外",
      "apps/backend/features/x/internal/infra/x-repository.postgres.test.ts",
      source(
        "async save(x) {}",
        "q.onConflictDoUpdate({});",
        "static reconstruct(v) {}",
      ),
    ],
    [
      "shared/domain の reconstruct（entity-with-reconstruct-has-origin は features の domain だけ）",
      "apps/backend/shared/domain/x.ts",
      source("export class X {", "  static reconstruct(v: V) {}", "}"),
    ],
    [
      "backend の外（frontend）は対象外",
      "apps/frontend_customer/features/x/x.ts",
      source("q.onConflictDoUpdate({});"),
    ],
    // Issue #208: feature の層は internal/ の下だけ。internal/ を挟まない旧の置き場所（置き場所の規則 backend-placement が
    //   違反にする）は、domain・schema.ts の規則の対象外。
    [
      "internal/ を挟まない features/x/domain/ の reconstruct は entity-with-reconstruct-has-origin の対象外",
      "apps/backend/features/x/domain/x.ts",
      source("export class X {", "  static reconstruct(v: V) {}", "}"),
    ],
    [
      "internal/ を挟まない features/x/infra/schema.ts は append-only-table-naming の対象外",
      "apps/backend/features/x/infra/schema.ts",
      source('export const statusLog = pgTable("todo_status_changes", {});'),
    ],
    [
      "insert のみの表（*Changes / *Events / *Logs）への insert と select、それ以外の表の update / delete",
      POSTGRES,
      withWrite(
        "await tx.insert(todoStatusChanges).values(rows);",
        "await tx.insert(orderEvents).values(rows);",
        "await writer.insert(changeLogs).values(rows);",
        "await this.db.select().from(todoStatusChanges);",
        "await tx.update(todos).set(changed);",
        "await tx.delete(todos).where(eq(todos.id, id));",
      ),
    ],
    [
      "名前の途中に Changes / Events / Logs を含むだけの表（todoChangesLog / eventsArchive / logsArchive）",
      POSTGRES,
      withWrite(
        "await tx.delete(todoChangesLog);",
        "await tx.update(eventsArchive).set(row);",
        "await tx.delete(logsArchive);",
      ),
    ],
    [
      "update / delete で始まる別のメソッド（updateChanges( / deleted( / predelete(）",
      POSTGRES,
      source(
        "q.updateChanges(todoStatusChanges);",
        "q.deleted(todoStatusChanges);",
        "q.predelete(todoStatusChanges);",
      ),
    ],
    [
      "コメントの中の .delete(todoStatusChanges)",
      POSTGRES,
      withWrite(
        "// this.db.delete(todoStatusChanges) は書かない（cascade で消える）。",
        "await tx.delete(todos); // tx.update(todoStatusChanges) も書かない",
      ),
    ],
    [
      "*.postgres.ts 以外（in-memory）の .delete(xChanges)",
      IN_MEMORY,
      source("this.statusChanges.delete(todoStatusChanges);"),
    ],
    [
      "schema.ts の _changes / _events / _logs の表を Changes / Events / Logs で終わる変数で受ける",
      SCHEMA,
      source(
        'export const todoStatusChanges = pgTable("todo_status_changes", {',
        "});",
        "export const orderEvents = pgTable('order_events', {});",
        "export const accessLogs = pgTable(`access_logs`, {});",
      ),
    ],
    [
      "shared/infra/schema.ts の change_logs を changeLogs で受ける（横断の表の置き場所）",
      SHARED_SCHEMA,
      source(
        "export const changeLogs = pgTable(",
        '  "change_logs",',
        "  {},",
        ");",
      ),
    ],
    [
      '改行を挟んだ pgTable(\\n  "x_changes" を Changes で終わる変数で受ける',
      SCHEMA,
      source(
        "export const todoStatusChanges = pgTable(",
        '  "todo_status_changes",',
        "  {},",
        ");",
      ),
    ],
    [
      "_changes / _events / _logs で終わらない表は対象外（変数名は問わない）",
      SCHEMA,
      source(
        'export const todos = pgTable("todos", {});',
        'export const changeLog = pgTable("todo_changes_log", {});',
        'export const history = pgTable("todo_changesx", {});',
        'export const audit = pgTable("todo_logsx", {});',
      ),
    ],
    [
      'コメントの中の pgTable("x_changes")',
      SCHEMA,
      source('// export const statusLog = pgTable("todo_status_changes", {});'),
    ],
    [
      "schema.ts でないファイル（schema.test.ts・infra の別のファイル）は append-only-table-naming の対象外",
      "apps/backend/features/x/internal/infra/x-tables.ts",
      source('export const statusLog = pgTable("todo_status_changes", {});'),
    ],
    [
      "*.postgres.ts の書き込みが write を import し、writeInTransaction のコールバックで書いて記録を返す（複数行の import・拡張子付き・改行を挟む）",
      POSTGRES,
      source(
        IMPORT_CHANGED_PROPS,
        'import { deleteEntry, insertEntry } from "../../../../shared/infra/change-log";',
        "import {",
        "  type Transaction,",
        "  writeInTransaction,",
        '} from "../../../../shared/infra/write.ts";',
        "class A {",
        "  async save(x: X) {",
        '    await writeInTransaction(this.db, { table: xs, rowId: x.id, operation: "insert" }, async (tx) => {',
        "      const inserted = await this.insert(tx, x);",
        "      return [insertEntry(xs, inserted, this.actorId)];",
        "    });",
        "  }",
        "  async delete(id: string) {",
        "    await writeInTransaction(",
        "      this.db,",
        '      { table: xs, rowId: id, operation: "delete" },',
        "      async (tx: Transaction) => {",
        "        const deleted = await tx.delete(xs).where(eq(xs.id, id)).returning();",
        "        return deleted.map((row) => deleteEntry(xs, row, this.actorId));",
        "      },",
        "    );",
        "  }",
        "}",
      ),
    ],
    [
      "transaction / recordChange で始まる・終わる・含むだけの別の名前（transactional( / myTransaction( / transactions / recordChanges( / recordChangeLater(）と型の Transaction",
      POSTGRES,
      source(
        "await this.transactional(async (tx) => {});",
        "await myTransaction(async (tx) => {});",
        "const transactions = [];",
        "await recordChanges(tx, entries);",
        "recordChangeLater(entries);",
        "type T = Transaction;",
      ),
    ],
    [
      "db でない受け手（tx / writer / 名前に db を含むだけの mydb・this.dbx）の書き込みと、db の読み取り（select / execute）",
      POSTGRES,
      withWrite(
        "await tx.insert(xs).values(row);",
        "await writer.update(xs).set(row);",
        "await mydb.delete(xs);",
        "await this.dbx.insert(xs).values(row);",
        "await this.db.select().from(xs);",
        "await this.db.execute(sql`select 1`);",
      ),
    ],
    [
      "書き込みの唯一の入口（shared/infra/write.ts。*.postgres.ts でない）は db.transaction( と recordChange( を呼んでよい",
      "apps/backend/shared/infra/write.ts",
      source(
        'import { recordChange } from "./change-log";',
        "entries = await db.transaction(async (tx) => {",
        "  const written = await write(tx);",
        "  await recordChange(tx, written);",
        "  return written;",
        "});",
      ),
    ],
    [
      "書き込みの無い *.postgres.ts（読み取りだけ）は write の import 不要。update / insert / delete で始まる別の名前も書き込みではない",
      POSTGRES,
      source(
        "const rows = await this.db.select().from(xs);",
        "q.updateChanges(x); q.inserted(x); q.deleteLater(x);",
      ),
    ],
    [
      "コメントの中の書き込み・transaction(・recordChange(・this.db.insert(",
      POSTGRES,
      source(
        "// await this.db.insert(xs).values(row); は write を import して書く",
        "// this.db.transaction( と recordChange(tx, entries) は直接呼ばない",
        "const rows = await this.db.select().from(xs); // db.transaction(async (tx) => recordChange(tx, e))",
      ),
    ],
    [
      "*.postgres.ts 以外（in-memory）の書き込みと、transaction( と recordChange(",
      IN_MEMORY,
      source(
        "this.todos.delete(id);",
        "this.logs.push(...entries);",
        "await this.db.transaction(async (tx) => {});",
        "await recordChange(this.db, entries);",
      ),
    ],
    [
      "子表を import した *.postgres.ts の集約の読み出しが、leftJoin で子表の全件を読む（where は親の列、orderBy に子の position）",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "const rows = await this.db",
        "  .select({ todo: todos, change: { completed: todoStatusChanges.completed } })",
        "  .from(todos)",
        "  .leftJoin(todoStatusChanges, eq(todoStatusChanges.todoId, todos.id))",
        "  .where(eq(todos.id, id))",
        "  .orderBy(asc(todos.createdAt), asc(todoStatusChanges.position));",
      ),
    ],
    [
      "子表を import した *.postgres.ts の行ロック（.for(）の存在確認は、親だけを from で読んでよい",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "const [row] = await writer",
        "  .select()",
        "  .from(todos)",
        "  .where(eq(todos.id, todo.id))",
        '  .for("key share");',
      ),
    ],
    [
      "子表を import していない *.postgres.ts の from( / limit( / where は対象外（*Logs は集約の子表ではない）",
      POSTGRES,
      source(
        'import { changeLogs } from "../../../../shared/infra/schema";',
        "await this.db.select().from(xs).limit(1);",
        "await this.db.select().from(changeLogs).where(eq(changeLogs.rowId, id)).limit(10);",
        "await this.db.select().from(todoStatusChanges);",
      ),
    ],
    [
      "コメントの中の .from(todoStatusChanges) / .limit(1) / where の子表の列",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "// this.db.select().from(todoStatusChanges).limit(1) は書かない",
        "const rows = await this.db.select().from(todos).leftJoin(todoStatusChanges, on); // .where(eq(todoStatusChanges.position, 0))",
      ),
    ],
    [
      "クラスの static な from（Array.from / Buffer.from）はクエリではない",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "return Array.from(grouped.values(), ({ row }) => toTodo(row));",
        "const bytes = Buffer . from(text);",
      ),
    ],
    [
      "(a) 大文字を途中に含む小文字で始まる受け手（todoReader.from(todos)）はクエリとして見る",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "const rows = await todoReader.from(todos).leftJoin(todoStatusChanges, on);",
      ),
    ],
    [
      "別名で import した子表（x as orderEvents）も leftJoin で読めばよい",
      POSTGRES,
      source(
        'import { orders, orderEventsTable as orderEvents } from "./schema";',
        "const rows = await this.db.select().from(orders).leftJoin(orderEvents, on).orderBy(orderEvents.position);",
      ),
    ],
  ])("%s は違反なし", (_name, path, text) => {
    expect(findPersistenceViolations(path, text)).toEqual([]);
  });
});

describe("永続化の判定（findPersistenceViolations）: must reject", () => {
  it.each<[string, string, string, PersistenceViolation[]]>([
    [
      ".onConflictDoUpdate(（chain の次の行）",
      POSTGRES,
      withWrite(
        IMPORT_CHANGED_PROPS,
        "await tx",
        "  .insert(xs)",
        "  .values(row)",
        "  .onConflictDoUpdate({ target: xs.id, set: row });",
      ),
      [{ rule: "no-upsert", line: 5 }],
    ],
    [
      ".onConflictDoNothing()（同じ行）",
      POSTGRES,
      withWrite(
        IMPORT_CHANGED_PROPS,
        "await tx.insert(xs).values(row).onConflictDoNothing();",
      ),
      [{ rule: "no-upsert", line: 2 }],
    ],
    [
      "空白を挟んだ . onConflictDoNothing (",
      POSTGRES,
      source("q . onConflictDoNothing ( );"),
      [{ rule: "no-upsert", line: 1 }],
    ],
    [
      "変数に入れ直して呼ぶ（const f = q.onConflictDoUpdate; f({})）",
      POSTGRES,
      source("const f = q.onConflictDoUpdate;", "f({});"),
      [{ rule: "no-upsert", line: 1 }],
    ],
    [
      'ブラケットで呼ぶ（q["onConflictDoUpdate"](…)）',
      POSTGRES,
      source('q["onConflictDoUpdate"]({ target: xs.id, set: row });'),
      [{ rule: "no-upsert", line: 1 }],
    ],
    [
      ". の後で改行する（q.\\n  onConflictDoUpdate(）",
      POSTGRES,
      source("q.", "  onConflictDoUpdate({});"),
      [{ rule: "no-upsert", line: 2 }],
    ],
    [
      "*.postgres.ts 以外（in-memory / shared/infra / application）の upsert",
      "apps/backend/shared/infra/x.ts",
      source("q.onConflictDoUpdate({});"),
      [{ rule: "no-upsert", line: 1 }],
    ],
    [
      "*.postgres.ts の async save( が changed-props を import していない",
      POSTGRES,
      withWrite(
        "export class XRepository {",
        "  async save(x: X): Promise<void> {",
        "    await tx.update(xs).set(row);",
        "  }",
        "}",
      ),
      [{ rule: "save-uses-changed-props", line: 2 }],
    ],
    [
      "async の無い save( / public async save( / 型引数付きの save<",
      POSTGRES,
      source(
        "class A {",
        "  save(x: X) {}",
        "}",
        "class B {",
        "  public async save(x: X) {}",
        "}",
        "class C {",
        "  save<T>(x: T) {}",
        "}",
      ),
      [
        { rule: "save-uses-changed-props", line: 2 },
        { rule: "save-uses-changed-props", line: 5 },
        { rule: "save-uses-changed-props", line: 8 },
      ],
    ],
    [
      "changed-props の import がコメントの中だけ",
      POSTGRES,
      source(
        `// ${IMPORT_CHANGED_PROPS}`,
        "class A {",
        "  async save(x: X) {}",
        "}",
      ),
      [{ rule: "save-uses-changed-props", line: 3 }],
    ],
    [
      "changed-props を import type だけで読む（関数を呼べない）",
      POSTGRES,
      source(
        'import type { changedProps } from "../../../../shared/infra/changed-props";',
        "class A {",
        "  async save(x: X) {}",
        "}",
      ),
      [{ rule: "save-uses-changed-props", line: 3 }],
    ],
    [
      "名前が同じ別のモジュール（./changed-props / shared/infra/changed-props-x）",
      POSTGRES,
      source(
        'import { changedProps } from "./changed-props";',
        'import { diff } from "../../../../shared/infra/changed-props-x";',
        "class A {",
        "  async save(x: X) {}",
        "}",
      ),
      [{ rule: "save-uses-changed-props", line: 4 }],
    ],
    [
      "Entity が static reconstruct( を持つのに get origin() が無い",
      ENTITY,
      source(
        "export class X {",
        "  static reconstruct(values: XProps): X {",
        "    return new X(values);",
        "  }",
        "}",
      ),
      [{ rule: "entity-with-reconstruct-has-origin", line: 2 }],
    ],
    [
      "get origin() がコメントの中だけ・getter でない origin のフィールド",
      ENTITY,
      source(
        "export class X {",
        "  // get origin() は持たない",
        "  readonly origin?: XProps;",
        "  public static reconstruct(values: XProps): X {",
        "    return new X(values);",
        "  }",
        "}",
      ),
      [{ rule: "entity-with-reconstruct-has-origin", line: 4 }],
    ],
    [
      "domain の下の入れ子の Entity",
      "apps/backend/features/x/internal/domain/nested/y.ts",
      source("export class Y {", "  static reconstruct(v: V) {}", "}"),
      [{ rule: "entity-with-reconstruct-has-origin", line: 2 }],
    ],
    [
      "tx.delete(todoStatusChanges)（insert のみの表の DELETE）",
      POSTGRES,
      withWrite("await tx.delete(todoStatusChanges);"),
      [{ rule: "no-update-delete-on-append-only-tables", line: 1 }],
    ],
    [
      "tx.update(todoStatusChanges)（トランザクションの中の UPDATE）",
      POSTGRES,
      withWrite(
        "await writeInTransaction(this.db, target, async (tx) => {",
        "  await tx.update(todoStatusChanges).set({ completed: true });",
        "});",
      ),
      [{ rule: "no-update-delete-on-append-only-tables", line: 2 }],
    ],
    [
      "改行を挟んだ .delete( と表の名前（chain の次の行で .delete(、その次の行に表。行は delete の行）",
      POSTGRES,
      withWrite(
        "await tx",
        "  .delete(",
        "    todoStatusChanges",
        "  )",
        "  .where(eq(todoStatusChanges.todoId, id));",
      ),
      [{ rule: "no-update-delete-on-append-only-tables", line: 2 }],
    ],
    [
      "空白を挟んだ . update ( orderEvents )（*Events の表）",
      POSTGRES,
      withWrite("q . update ( orderEvents ).set(row);"),
      [{ rule: "no-update-delete-on-append-only-tables", line: 1 }],
    ],
    [
      "メンバーの参照（schema.todoStatusChanges）",
      POSTGRES,
      withWrite("await tx.delete(schema.todoStatusChanges);"),
      [{ rule: "no-update-delete-on-append-only-tables", line: 1 }],
    ],
    [
      "1 行に 2 つ・複数の行（行の順に、見つけた数だけ返す）",
      POSTGRES,
      withWrite(
        "await tx.update(aChanges).set(r); await tx.delete(bEvents);",
        "await tx.delete(todos);",
        "await tx.delete(cChanges);",
      ),
      [
        { rule: "no-update-delete-on-append-only-tables", line: 1 },
        { rule: "no-update-delete-on-append-only-tables", line: 1 },
        { rule: "no-update-delete-on-append-only-tables", line: 3 },
      ],
    ],
    [
      "schema.ts の _changes の表を Changes で終わらない変数で受ける（表名と変数名のずれ）",
      SCHEMA,
      source(
        'export const todos = pgTable("todos", {});',
        'export const statusLog = pgTable("todo_status_changes", {});',
      ),
      [{ rule: "append-only-table-naming", line: 2 }],
    ],
    [
      "改行を挟んだ pgTable(\\n  'x_events'（行は pgTable の行）",
      SCHEMA,
      source(
        "export const orderLog = pgTable(",
        "  'order_events',",
        "  {},",
        ");",
      ),
      [{ rule: "append-only-table-naming", line: 1 }],
    ],
    [
      "変数で受けない _changes の表（export default pgTable(…)）",
      SCHEMA,
      source('export default pgTable("todo_status_changes", {});'),
      [{ rule: "append-only-table-naming", line: 1 }],
    ],
    [
      "*.postgres.ts の insert / update / delete（改行・空白を挟む）が write を import していない（書き込みの行ごと）",
      POSTGRES,
      source(
        "await tx.insert(xs).values(row);",
        "await tx",
        "  .update(xs)",
        "  .set(row);",
        "await tx . delete (xs);",
      ),
      [
        { rule: "writes-through-write-in-transaction", line: 1 },
        { rule: "writes-through-write-in-transaction", line: 3 },
        { rule: "writes-through-write-in-transaction", line: 5 },
      ],
    ],
    [
      "write を import type だけ・コメントの中だけ・名前が同じ別のモジュール（./write・shared/infra/write-x・shared/infra/writer）で読む。change-log の import では満たさない",
      POSTGRES,
      source(
        'import type { Transaction } from "../../../../shared/infra/write";',
        `// ${IMPORT_WRITE}`,
        'import { writeInTransaction } from "./write";',
        'import { x } from "../../../../shared/infra/write-x";',
        'import { y } from "../../../../shared/infra/writer";',
        'import { insertEntry } from "../../../../shared/infra/change-log";',
        "await tx.insert(xs).values(r);",
      ),
      [{ rule: "writes-through-write-in-transaction", line: 7 }],
    ],
    [
      "*.postgres.ts で transaction を直接使う（db.transaction( / 空白を挟む / tx.transaction( のセーブポイント / ブラケット / 分割代入 / . の後の改行）",
      POSTGRES,
      withWrite(
        "await this.db.transaction(async (tx) => {",
        "});",
        "await db . transaction (async (tx) => {});",
        "await tx.transaction(async (sp) => {});",
        'await this.db["transaction"](async (tx) => {});',
        "const { transaction } = this.db;",
        "await this.db.",
        "  transaction(async (tx) => {});",
      ),
      [
        { rule: "no-direct-transaction", line: 1 },
        { rule: "no-direct-transaction", line: 3 },
        { rule: "no-direct-transaction", line: 4 },
        { rule: "no-direct-transaction", line: 5 },
        { rule: "no-direct-transaction", line: 6 },
        { rule: "no-direct-transaction", line: 8 },
      ],
    ],
    [
      "*.postgres.ts で db を直接使って書き込む（this.db.insert( / 空白を挟む db . update ( / 改行を挟む this.db\\n  .delete( / database.db）",
      POSTGRES,
      withWrite(
        "await this.db.insert(xs).values(row);",
        "await db . update ( xs ).set(row);",
        "await this.db",
        "  .delete(xs)",
        "  .where(eq(xs.id, id));",
        "await database.db.insert(xs).values(row);",
      ),
      [
        { rule: "no-direct-db-write", line: 1 },
        { rule: "no-direct-db-write", line: 2 },
        { rule: "no-direct-db-write", line: 4 },
        { rule: "no-direct-db-write", line: 6 },
      ],
    ],
    [
      "*.postgres.ts で recordChange を直接使う（import・別名の import・writeInTransaction のコールバックの中の呼び出し・名前空間の参照）",
      POSTGRES,
      withWrite(
        'import { recordChange } from "../../../../shared/infra/change-log";',
        'import { recordChange as rc } from "../../../../shared/infra/change-log";',
        "await writeInTransaction(this.db, target, async (tx) => {",
        "  await recordChange(tx, entries);",
        "  return [];",
        "});",
        "await changeLog . recordChange (tx, entries);",
      ),
      [
        { rule: "no-direct-record-change", line: 1 },
        { rule: "no-direct-record-change", line: 2 },
        { rule: "no-direct-record-change", line: 4 },
        { rule: "no-direct-record-change", line: 7 },
      ],
    ],
    [
      "(a) 子表を import した *.postgres.ts で、親の from(todos) に子表の leftJoin が無い（innerJoin・別の表の leftJoin も）",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "const a = await this.db.select().from(todos).where(eq(todos.id, id));",
        "const b = await this.db.select().from(todos).innerJoin(todoStatusChanges, on);",
        "const c = await this.db.select().from(schema.todos).leftJoin(others, on);",
      ),
      [
        { rule: "aggregate-loads-all-children", line: 2 },
        { rule: "aggregate-loads-all-children", line: 3 },
        { rule: "aggregate-loads-all-children", line: 4 },
      ],
    ],
    [
      "(b)(d) 子表だけを from で読み（改行を挟んだ chain）、where で子表の列を絞る",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "const rows = await this.db",
        "  .select()",
        "  .from(",
        "    todoStatusChanges,",
        "  )",
        "  .where(eq(todoStatusChanges.todoId, id));",
      ),
      [
        { rule: "aggregate-loads-all-children", line: 4 },
        { rule: "aggregate-loads-all-children", line: 7 },
      ],
    ],
    [
      "(c) limit( で件数を絞る（leftJoin で読んでいても）",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "const rows = await this.db.select().from(todos).leftJoin(todoStatusChanges, on)",
        "  .limit(1);",
      ),
      [{ rule: "aggregate-loads-all-children", line: 3 }],
    ],
    [
      "(c) offset( で行を飛ばす・selectDistinctOn で各 Todo の 1 行だけを読む（leftJoin で読んでいても）",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "const rows = await this.db.select().from(todos).leftJoin(todoStatusChanges, on)",
        "  .offset(1);",
        "const latest = await this.db",
        "  .selectDistinctOn([todos.id], { id: todos.id })",
        "  .from(todos).leftJoin(todoStatusChanges, on);",
      ),
      [
        { rule: "aggregate-loads-all-children", line: 3 },
        { rule: "aggregate-loads-all-children", line: 5 },
      ],
    ],
    [
      "(d) where で子表の position / changedAt を絞る（and の奥・改行を挟む。orderBy の子表の列は可）",
      POSTGRES,
      source(
        IMPORT_CHILD,
        "const latest = await this.db.select().from(todos).leftJoin(todoStatusChanges, on).where(eq(todoStatusChanges.position, 0)).orderBy(todoStatusChanges.position);",
        "const recent = await this.db",
        "  .select()",
        "  .from(todos)",
        "  .leftJoin(todoStatusChanges, on)",
        "  .where(",
        "    and(eq(todos.id, id), gt(todoStatusChanges . changedAt, since)),",
        "  );",
      ),
      [
        { rule: "aggregate-loads-all-children", line: 2 },
        { rule: "aggregate-loads-all-children", line: 7 },
      ],
    ],
    [
      "insert のみの表（*Logs）への update / delete",
      POSTGRES,
      withWrite(
        "await writer.delete(changeLogs);",
        "await tx.update(schema.accessLogs).set(row);",
      ),
      [
        { rule: "no-update-delete-on-append-only-tables", line: 1 },
        { rule: "no-update-delete-on-append-only-tables", line: 2 },
      ],
    ],
    [
      "_logs の表を Logs で終わらない変数で受ける（shared/infra/schema.ts も対象）",
      SHARED_SCHEMA,
      source('export const changeLog = pgTable("change_logs", {});'),
      [{ rule: "append-only-table-naming", line: 1 }],
    ],
    [
      "1 つのファイルに upsert と import の無い save（行の順に返す）",
      POSTGRES,
      source(
        "class A {",
        "  async save(x: X) {",
        "    await q.onConflictDoUpdate({});",
        "  }",
        "}",
      ),
      [
        { rule: "save-uses-changed-props", line: 2 },
        { rule: "no-upsert", line: 3 },
      ],
    ],
  ])("%s は違反", (_name, path, text, expected) => {
    expect(findPersistenceViolations(path, text)).toEqual(expected);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（apps/backend の下のテスト以外の .ts の見つけ方）が漏れれば見逃す。一時ディレクトリに
//   架空のツリーを置き、本番と同じ collectPersistenceViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
describe("backend のソースの列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "persistence-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const saveMethod = source("class A {", "  async save(x: X) {}", "}");
  const reconstructOnly = source(
    "export class Y {",
    "  static reconstruct(v: V) {}",
    "}",
  );

  it("apps/backend の下のテスト以外の .ts を対象にし、違反を「規則: パス:行」で返す", () => {
    const root = fixture({
      [POSTGRES]: source(IMPORT_CHANGED_PROPS, saveMethod),
      "apps/backend/features/y/internal/infra/y-repository.postgres.ts": source(
        saveMethod,
        "q.onConflictDoUpdate({});",
      ),
      "apps/backend/features/y/internal/infra/y-reader.postgres.ts": source(
        "export class YReader {}",
        "await this.db.delete(yChanges);",
      ),
      [IN_MEMORY]: source(saveMethod, "q.onConflictDoNothing();"),
      "apps/backend/shared/infra/z.ts": source("", "q.onConflictDoNothing();"),
      [ENTITY]: source(
        "export class X {",
        "  get origin() {}",
        "  static reconstruct(v: V) {}",
        "}",
      ),
      "apps/backend/features/y/internal/domain/y.ts": reconstructOnly,
      [SCHEMA]: source(
        'export const xStatusChanges = pgTable("x_status_changes", {});',
      ),
      "apps/backend/features/y/internal/infra/schema.ts": source(
        'export const ys = pgTable("ys", {});',
        'export const yLog = pgTable("y_events", {});',
      ),
      "apps/backend/features/y/internal/domain/y-repository.ts": source(
        "export interface YRepository {}",
      ),
      // 書き込みの入口と集約の読み出しの規則（Issue #189・#205）: transaction と recordChange を直接呼び、子表を import して親だけを読む。
      "apps/backend/features/z/internal/infra/z-repository.postgres.ts": source(
        IMPORT_WRITE,
        'import { zChanges, zs } from "./schema";',
        "await this.db.transaction(async (tx) => { await tx.insert(zs).values(r); });",
        "await recordChange(this.db, entries);",
        "const rows = await this.db.select().from(zs).limit(1);",
      ),
      // 規則を満たす Repository（write を import し、writeInTransaction のコールバックで書き、子表を leftJoin で読む）。
      "apps/backend/features/z/internal/infra/z-writer.postgres.ts": source(
        IMPORT_WRITE,
        'import { zChanges, zs } from "./schema";',
        "await writeInTransaction(this.db, target, async (tx) => {",
        "  await tx.delete(zs);",
        "  return entries;",
        "});",
        "const rows = await this.db.select().from(zs).leftJoin(zChanges, on);",
      ),
      // 書き込みの唯一の入口（*.postgres.ts でない）は transaction と recordChange を呼んでよい。
      "apps/backend/shared/infra/write.ts": source(
        "await db.transaction(async (tx) => {",
        "  await recordChange(tx, await write(tx));",
        "});",
      ),
      "apps/backend/shared/infra/schema.ts": source(
        'export const changeLog = pgTable("change_logs", {});',
      ),
      // 対象外: テスト、features でない domain の reconstruct、.ts でないファイル、backend の外、node_modules の中。
      "apps/backend/features/y/internal/infra/y-repository.postgres.test.ts":
        source(
          saveMethod,
          "q.onConflictDoUpdate({});",
          "await this.db.delete(yChanges);",
        ),
      "apps/backend/features/y/internal/infra/y-repository.in-memory.ts":
        source("this.yEvents.delete(id);", "q.update(yEvents);"),
      "apps/backend/features/y/internal/domain/y.test.ts": reconstructOnly,
      "apps/backend/shared/domain/w.ts": reconstructOnly,
      "apps/backend/shared/drizzle/0000_x.sql":
        "INSERT ... ON CONFLICT DO UPDATE;",
      "apps/frontend_customer/features/x/x.ts": source(
        "q.onConflictDoUpdate({});",
      ),
      "apps/backend/node_modules/x/x.postgres.ts": saveMethod,
    });
    expect({
      files: listBackendSources(root),
      violations: collectPersistenceViolations(root),
    }).toEqual({
      files: [
        "apps/backend/features/x/internal/domain/x.ts",
        "apps/backend/features/x/internal/infra/schema.ts",
        "apps/backend/features/x/internal/infra/x-repository.in-memory.ts",
        "apps/backend/features/x/internal/infra/x-repository.postgres.ts",
        "apps/backend/features/y/internal/domain/y-repository.ts",
        "apps/backend/features/y/internal/domain/y.ts",
        "apps/backend/features/y/internal/infra/schema.ts",
        "apps/backend/features/y/internal/infra/y-reader.postgres.ts",
        "apps/backend/features/y/internal/infra/y-repository.in-memory.ts",
        "apps/backend/features/y/internal/infra/y-repository.postgres.ts",
        "apps/backend/features/z/internal/infra/z-repository.postgres.ts",
        "apps/backend/features/z/internal/infra/z-writer.postgres.ts",
        "apps/backend/shared/domain/w.ts",
        "apps/backend/shared/infra/schema.ts",
        "apps/backend/shared/infra/write.ts",
        "apps/backend/shared/infra/z.ts",
      ],
      violations: [
        "no-upsert: apps/backend/features/x/internal/infra/x-repository.in-memory.ts:4",
        "entity-with-reconstruct-has-origin: apps/backend/features/y/internal/domain/y.ts:2",
        "append-only-table-naming: apps/backend/features/y/internal/infra/schema.ts:2",
        "no-update-delete-on-append-only-tables: apps/backend/features/y/internal/infra/y-reader.postgres.ts:2",
        "writes-through-write-in-transaction: apps/backend/features/y/internal/infra/y-reader.postgres.ts:2",
        "no-direct-db-write: apps/backend/features/y/internal/infra/y-reader.postgres.ts:2",
        "save-uses-changed-props: apps/backend/features/y/internal/infra/y-repository.postgres.ts:2",
        "no-upsert: apps/backend/features/y/internal/infra/y-repository.postgres.ts:4",
        "no-direct-transaction: apps/backend/features/z/internal/infra/z-repository.postgres.ts:3",
        "no-direct-record-change: apps/backend/features/z/internal/infra/z-repository.postgres.ts:4",
        "aggregate-loads-all-children: apps/backend/features/z/internal/infra/z-repository.postgres.ts:5",
        "aggregate-loads-all-children: apps/backend/features/z/internal/infra/z-repository.postgres.ts:5",
        "append-only-table-naming: apps/backend/shared/infra/schema.ts:1",
        "no-upsert: apps/backend/shared/infra/z.ts:2",
      ],
    });
  });

  it("apps/backend が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listBackendSources(root),
      violations: collectPersistenceViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("永続化（実ファイル）", () => {
  it("upsert を使わず、*.postgres.ts の save は changed-props を import し、reconstruct を持つ Entity は origin を持ち、insert のみの表を update / delete せず、その表を Changes / Events / Logs で終わる変数で宣言し、書き込みは writeInTransaction を通し（transaction と recordChange を直接呼ばない）、集約は子表の全件を JOIN で読む", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    const files = listBackendSources(repoRoot);
    expect(files).toContain(
      "apps/backend/features/todo/internal/infra/todo-repository.postgres.ts",
    );
    expect(files).toContain(
      "apps/backend/features/todo/internal/domain/todo.ts",
    );
    expect(files).toContain(
      "apps/backend/features/todo/internal/infra/schema.ts",
    );
    expect(files).toContain("apps/backend/shared/infra/schema.ts");
    expect(collectPersistenceViolations(repoRoot)).toEqual([]);
  });
});

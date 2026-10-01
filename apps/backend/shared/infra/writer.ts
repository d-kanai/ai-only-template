import { randomUUID } from "node:crypto";
import { logger } from "@repo/shared/logger";
import { DrizzleQueryError, eq, getTableName, type Table } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Transaction } from "../application/transaction";
import type { ChangeOperation } from "../domain/change-operation";
import {
  type ChangeEntry,
  deleteEntry,
  insertEntry,
  recordChange,
  updateEntries,
} from "./change-log";
import { maskRow } from "./column-classification";
import type { Database } from "./database";
import type { Changes } from "./schema";

// 書き込みの唯一の口（Writer。Issue #215。ADR docs/adr/architecture/20260930-transaction-from-application.md）。Repository
//   （*.postgres.ts）は行の変換だけを書き、insert / update / delete をこの Writer に渡す。Writer は 1 文ごとに次を横断的に行う:
//   (a) drizzle の insert / update / delete を .returning() で実行する。
//   (b) 変更履歴（change_logs。Issue #189）の記録を change-log.ts の組み立てで作り、同じトランザクションの change_logs に書く
//       （recordChange。文ごとに 1 回）。insert は全列の after、update は同じトランザクションで FOR UPDATE で読んだ行を before、
//       渡した列を after、delete は消した行（returning）の全列の before。
//   (c) 書き込みの前後に 1 行ずつログ（event.name は db_write。Issue #205・#209）を出す。
// WHY Repository ではなく Writer が記録する（Issue #215 のユーザー判断「AOP のように共通で記録したい」）: 以前は Repository が
//   書き込みごとに記録（ChangeEntry）を組み立てて返していた（writeInTransaction。Issue #205）。Repository を足すたびに同じ組み立てを
//   書くことになり、書き忘れた書き込みは記録されない。Writer を通れば必ず記録とログが残る。Repository が change-log を import
//   することは rule-tests/persistence.test.ts の no-change-log-in-repository が止め、書き込みが Writer を通ることは
//   writes-through-writer が見る。
// WHY 以前の writeInTransaction（write.ts）を置き換える: トランザクションを張るのは command（application）の runner になり
//   （shared/infra/transaction.postgres.ts）、書き込みごとにトランザクションを張る入口は要らなくなった。
// 前提: 書き込む表はすべて uuid の id 列（主キー）を持つ（Issue #213）。update / delete は id で 1 行を指す。

// db.transaction のコールバックが受け取る tx の型（drizzle-orm の NodePgTransaction）。
// WHY Database（NodePgDatabase）の型から取る: drizzle の型引数（スキーマ・リレーション）を手で書かず、db と必ず一致させる。
export type DrizzleTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];

// Writer が書ける表: id 列を持つ Postgres の表。
export type TableWithId = PgTable & { readonly id: PgColumn };

// Repository が使う書き込みの口。
// WHY 狭い interface にする（drizzle の tx をそのまま渡さない）: tx をそのまま渡すと、Repository が記録もログも通らない
//   tx.insert(...).values(...) を書けてしまう。書き込みは表と行（と id）だけを受け取る形にし、記録とログを必ず通す。
export interface Writer {
  // 読み取りは drizzle の select のまま（同じトランザクションで読む。findByIdForUpdate の LEFT JOIN と FOR UPDATE に使う）。
  // WHY 読み取りは包まない: 読み取りは変更履歴もログも要らず、JOIN・並べ替え・ロックの書き方は drizzle のものが使いやすい。
  readonly select: DrizzleTransaction["select"];
  // 行を 1 文で INSERT し、DB が保存した行（全列）を入れた順に返す。行が空なら何もせず空配列を返す。
  insert<T extends TableWithId>(
    table: T,
    rows: readonly T["$inferInsert"][],
  ): Promise<T["$inferSelect"][]>;
  // id の行の changes の列だけを UPDATE し、更新後の行を返す。changes が空なら何もせず undefined を返す。行が無ければ Error。
  update<T extends TableWithId>(
    table: T,
    id: string,
    changes: Partial<T["$inferInsert"]>,
  ): Promise<T["$inferSelect"] | undefined>;
  // id の行を DELETE し、消した行を返す。無い id なら何もせず undefined を返す。
  delete<T extends TableWithId>(
    table: T,
    id: string,
  ): Promise<T["$inferSelect"] | undefined>;
}

// 記録（change-log.ts の組み立て）が受け取る行の形（id は記録の row_id）。
type RecordedRow = { readonly id: string } & Readonly<Record<string, unknown>>;

// Writer の Postgres の実装。1 つのトランザクション（drizzle の tx）に 1 つ作る（PostgresTransactionRunner の run）。
// WHY actorId（変更した利用者の id）を持つ: 変更履歴の actor_id に入れる。actor は要求の文脈（ログインした利用者）で、Repository
//   ではなく runner（要求ごとに組み立てる）が持つ。ログインが無い今は常に null（ADR
//   docs/adr/architecture/20260930-change-logs-written-by-repository.md）。
// WHY drizzle の型引数に合わせる cast（as never・as T["$inferSelect"]）: 表を型引数 T で受けると、drizzle の insert の values・
//   update の set・returning の行の型が T から決まらず（条件型が解決されない）、型が合わない。呼び出し側の型は Writer の
//   シグネチャ（T の $inferInsert / $inferSelect）で縛っているので、中の cast はここに閉じる。
export class PostgresWriter implements Writer {
  readonly select: DrizzleTransaction["select"];

  constructor(
    private readonly tx: DrizzleTransaction,
    private readonly actorId: string | null,
  ) {
    // WHY bind: drizzle の select は this（tx のセッション）を使う。Repository が writer.select() と呼んでも tx で読む。
    this.select = tx.select.bind(tx);
  }

  async insert<T extends TableWithId>(
    table: T,
    rows: readonly T["$inferInsert"][],
  ): Promise<T["$inferSelect"][]> {
    // WHY 空なら何もしない: drizzle-orm の insert は空の values を受け付けない。完了の履歴の増分が無い update などで呼ばれる。
    if (rows.length === 0) {
      return [];
    }
    // WHY id の無い行に Writer が id を作る: 前のログ（row_id）と変更履歴（row_id）に、文を実行する前に行の id が要る。DB の既定値
    //   （defaultRandom）の id は INSERT の後にしか分からない。渡された id はそのまま使う（Todo の id は Todo.create が作る）。
    // WHY `row.id ?? randomUUID()` を row の後ろに置く（`{ id: randomUUID(), ...row }` にしない）: row が `id: undefined` を明示して
    //   持つと、スプレッドが作った id を undefined で上書きし、INSERT の id が NULL（NOT NULL 違反）、ログと変更履歴の row_id も
    //   undefined になる。id が無い・undefined のときだけ作る（Issue #215 の reviewer の指摘）。
    const withIds = rows.map((row) => ({
      ...row,
      id: (row as { id?: string }).id ?? randomUUID(),
    })) as (T["$inferInsert"] & { id: string })[];
    return this.logged(
      table,
      "insert",
      withIds.map((row) => row.id),
      async () => {
        const inserted = (await this.tx
          .insert(table)
          .values(withIds as never)
          .returning()) as T["$inferSelect"][];
        return {
          result: inserted,
          entries: inserted.map((row) =>
            insertEntry(table, row as RecordedRow, this.actorId),
          ),
        };
      },
    );
  }

  async update<T extends TableWithId>(
    table: T,
    id: string,
    changes: Partial<T["$inferInsert"]>,
  ): Promise<T["$inferSelect"] | undefined> {
    // WHY 空なら何もしない（SQL もログも無し）: 空の SET は SQL にならない。Repository は差分（changedProps）をそのまま渡すので、
    //   変わった列が無い update は何もしない。行の有無も確かめない（呼び出し側は同じトランザクションで行を読んでいる）。
    if (Object.keys(changes).length === 0) {
      return undefined;
    }
    return this.logged(table, "update", [id], async () => {
      // WHY 同じトランザクションで FOR UPDATE で読む: 記録の before を、DB が UPDATE の直前に持っていた値にする。読んでから
      //   UPDATE するまでの間に別のトランザクションが同じ行を変えられないよう、行をロックする（UPDATE も同じロックを取るので、
      //   ロックの順序は変わらない）。
      const [before] = await this.tx
        .select()
        .from(table as PgTable)
        .where(eq(table.id, id))
        .for("update");
      // WHY Error（not_found にしない）: Repository は同じトランザクションで行を FOR UPDATE で読んでから update する（command の
      //   findByIdForUpdate）ので、行が無いのは呼び出し側の実装ミス。英語: 開発者向けのエラー（Issue #116）。
      if (before === undefined) {
        throw new Error(`${getTableName(table)} has no row to update: ${id}`);
      }
      const [after] = (await this.tx
        .update(table)
        .set(changes as never)
        .where(eq(table.id, id))
        .returning()) as T["$inferSelect"][];
      return {
        result: after,
        entries: updateEntries(
          table,
          id,
          before as Readonly<Record<string, unknown>>,
          changes as Readonly<Record<string, unknown>>,
          this.actorId,
        ),
      };
    });
  }

  async delete<T extends TableWithId>(
    table: T,
    id: string,
  ): Promise<T["$inferSelect"] | undefined> {
    return this.logged(table, "delete", [id], async () => {
      // WHY 消した行を returning で受け取る（先に SELECT しない）: 1 文で消した行の値が分かり、SELECT と DELETE の間に別の要求が
      //   変えた値を記録する取り違えも起きない。子表の行（外部キーの on delete cascade で消える）は記録しない（親の delete の
      //   記録 1 件で分かる。cascade の行は SQL に現れない）。
      const [deleted] = (await this.tx
        .delete(table)
        .where(eq(table.id, id))
        .returning()) as T["$inferSelect"][];
      return {
        result: deleted,
        entries:
          deleted === undefined
            ? []
            : [deleteEntry(table, deleted as RecordedRow, this.actorId)],
      };
    });
  }

  // statement（本体の 1 文と記録の組み立て）を実行し、記録を同じトランザクションの change_logs に書く。前後に 1 行ずつ logger で
  //   ログを出し、失敗なら失敗の 1 行を出して同じ例外を投げ直す。
  // ログの形（Issue #209。ADR docs/adr/architecture/20260930-log-format-cloud-logging-otel.md。どれも event.name は db_write で、
  //   db.collection.name（表名）・db.operation.name（操作）・行の id（1 行なら row_id、複数なら row_ids）を持つ）:
  //   - 前: "db write start"（event.phase は start。INFO）
  //   - 後: "db write done"（event.phase は done。INFO）。event.duration_ms（所要時間）と changes（記録の table・row_id・operation と、
  //     列の分類表でマスクした before / after。下の loggedChanges）
  //   - 失敗: "db write failed"（event.phase は failed。WARNING）。event.duration_ms と error（logger が { type, message } にする）。
  //     DB のエラーなら error は pg のエラーの { type, message }（message は引用符の部分を *** にしたもの）で、
  //     db.response.status_code（SQLSTATE）・constraint（制約の名前）・params（SQL に渡した値。logger が値をすべて *** にする）を
  //     出す（下の failureFields）
  // WHY db.* の名前: OTel semconv の DB の属性（db.collection.name・db.operation.name・db.response.status_code。
  //   https://opentelemetry.io/docs/specs/semconv/registry/attributes/db/ ）にそろえ、入れ子のオブジェクトにする（Logs Explorer で
  //   jsonPayload.db.collection.name と書ける）。操作の名前は OTel の例（SELECT など）と違い、変更履歴と同じ insert / update / delete。
  // WHY 段階を event.phase に入れる（event.name を db_write_start などに分けない）: 1 回の書き込みの前後を event.name="db_write" の
  //   1 つの条件で引け、種類の一覧（apps/shared/log-event.ts）を段階の数だけ増やさずに済む。
  // WHY changes に値（before / after）を出し、列の分類でマスクする（Issue #216。以前（Issue #205〜#215）は値を出さなかった）:
  //   ログだけで「何がどう変わったか」を追えるようにし、障害の調査で本番の change_logs を読む回数を減らす。個人情報を含みうる
  //   列（todos.title など）は schema.ts の分類表で sensitive にし、*** にする。change_logs の表には生の値を残す（監査）。
  // 重大度（INFO / WARNING）は logger が event.name と phase で決める（apps/shared/log-event.ts の severityOf。Issue #216）。失敗が
  //   ERROR でなく WARNING なのは、500 になる想定外の例外は presentation の toProblemResponse が server_error（ERROR）で別に残すため。
  // 限界: 後のログは文と記録を書き終えた時点で出す（COMMIT の前）。後から COMMIT が失敗した（遅延制約など）ときは、このログは
  //   done のまま残り、失敗は toProblemResponse の 500 のログで分かる（トランザクションを張るのは runner で、Writer は COMMIT を
  //   見ない）。
  private async logged<R>(
    table: Table,
    operation: ChangeOperation,
    rowIds: readonly string[],
    statement: () => Promise<{ result: R; entries: readonly ChangeEntry[] }>,
  ): Promise<R> {
    const collection = { name: getTableName(table) };
    const db = { collection, operation: { name: operation } };
    // WHY 1 行なら row_id（複数なら row_ids）: 1 行の書き込み（update / delete と、根の insert）は以前（Issue #205）の形のまま
    //   row_id で引ける。複数行の insert（完了の履歴）は 1 文で書いた行をすべて並べる。
    const rows =
      rowIds.length === 1 ? { row_id: rowIds[0] } : { row_ids: rowIds };
    logger.emit({
      message: "db write start",
      event: { name: "db_write", phase: "start" },
      db,
      ...rows,
    });
    const startedAt = performance.now();
    let entries: readonly ChangeEntry[];
    let result: R;
    // WHY try は文と記録の書き込みだけを囲む: 失敗のログの対象は書き込み（本体・記録）の失敗だけ。後のログは外に置く。
    try {
      ({ result, entries } = await statement());
      await recordChange(this.tx, entries);
    } catch (error) {
      const failure = failureFields(error);
      logger.emit({
        message: "db write failed",
        event: {
          name: "db_write",
          phase: "failed",
          duration_ms: elapsedMs(startedAt),
        },
        db: {
          ...db,
          // WHY SQLSTATE が無ければ undefined（JSON.stringify がキーごと落とす）: DB のエラーでないとき・code が文字列でない
          //   ときに、空の response: {} を出さない。
          response:
            failure.statusCode === undefined
              ? undefined
              : { status_code: failure.statusCode },
        },
        ...rows,
        constraint: failure.constraint,
        params: failure.params,
        error: failure.error,
      });
      throw error;
    }
    logger.emit({
      message: "db write done",
      event: {
        name: "db_write",
        phase: "done",
        duration_ms: elapsedMs(startedAt),
      },
      db,
      ...rows,
      changes: loggedChanges(table, entries),
    });
    return result;
  }
}

// 後のログの changes: 記録（ChangeEntry）ごとの { table, row_id, operation, before, after }。before / after は記録の changes
//   （DB の列名 → { before?, after? }）を側ごとの「DB の列名 → 値」に分け、列の分類表（column-classification.ts）でマスクする。
//   側の値が 1 列も無ければ null（insert の before・delete の after）。
// WHY snake_case の { table, row_id, operation } にする（ChangeEntry の tableName・rowId をそのまま出さない）: ログのキーは
//   OTel の名前にそろえた snake_case で、行の中で表記を混ぜない。
// WHY 側ごとの「列 → 値」にする（記録の「列 → { before, after }」のまま出さない）: マスクを行（列 → 値）の 1 つの関数（maskRow）で
//   済ませ、Logs Explorer で jsonPayload.changes.after.completed のように側と列で引ける。
// WHY table（Writer が書いた表）でマスクする: 記録はすべてこの表の行（1 文 = 1 つの表）。分類は表のオブジェクトで引く。
function loggedChanges(table: Table, entries: readonly ChangeEntry[]) {
  return entries.map(({ tableName, rowId, operation, changes }) => ({
    table: tableName,
    row_id: rowId,
    operation,
    before: maskedSide(table, changes, "before"),
    after: maskedSide(table, changes, "after"),
  }));
}

function maskedSide(
  table: Table,
  changes: Changes,
  side: "before" | "after",
): Record<string, unknown> | null {
  const values = Object.entries(changes).filter(([, change]) => side in change);
  if (values.length === 0) {
    return null;
  }
  return maskRow(
    table,
    Object.fromEntries(values.map(([name, change]) => [name, change[side]])),
  );
}

// Writer を Transaction（shared/application/transaction の brand の型）にする（PostgresTransactionRunner が work に渡す値）。
// WHY cast をここに閉じる: Transaction は domain の brand の型で、infra の実体（Writer）を application・domain に見せない。
//   作るのはこの関数、取り出すのは writerOf だけにする。
export function transactionOf(writer: PostgresWriter): Transaction {
  return writer as unknown as Transaction;
}

// Repository が Transaction から Writer を取り出す 1 か所の関数。
// WHY instanceof で確かめる（cast で取り出さない）: InMemory の runner の Transaction（テスト用）などを Postgres の Repository に
//   渡すのは組み立ての誤りで、黙って別の値を Writer として使わせない。英語: 開発者向けのエラー（Issue #116）。
export function writerOf(tx: Transaction): Writer {
  if (!(tx instanceof PostgresWriter)) {
    throw new Error(
      "the transaction was not started by PostgresTransactionRunner",
    );
  }
  return tx;
}

// 失敗のログに載せる例外。DB のエラー（drizzle-orm の DrizzleQueryError）は、元の pg のエラー（cause）の name（error.type）と
//   引用符の部分を *** にした message（maskQuoted）、SQLSTATE（statusCode → db.response.status_code）・制約の名前（constraint。
//   pg の DatabaseError のプロパティ）、SQL に渡した値（params。logger のスキーマが値をすべて *** にする）にする。それ以外
//   （Error など）はそのまま（logger が { type, message } にする）。
// WHY DrizzleQueryError の message を出さない: 「Failed query: <SQL>\nparams: <値>」（drizzle-orm 0.45.3 の errors.js）で、行の値
//   （個人情報を含みうる）がそのまま入る。値は params として構造で渡し、logger に *** にさせる（Issue #216）。
// WHY pg の message は引用符の部分を *** にして出す（Issue #216。以前（Issue #205）は message を出さなかった）: 何が起きたかの文
//   （duplicate key value violates unique constraint・invalid input syntax for type uuid など）は調査に要る。一方でデータ例外
//   （SQLSTATE 22 系）の message は入力値を "..." で囲んで含む（22P02 の invalid input syntax for type uuid: "<入力>"、22003 の
//   value "<入力>" is out of range for type integer。2026-10-01 に実 Postgres で実測）。logger の freeText（メール・トークンなど
//   既知の形だけを *** にする）では任意の入力値は消えないので、Writer が先に引用符の部分を消す。
// WHY SQLSTATE と constraint を出す: message の制約の名前（引用符の中）は *** になるので、何の失敗か（23505・23503 など）とどの
//   制約かはこの 2 つで引く。どちらも DB が決める名前・コードで、入力値を含まない。文字列でないとき（想定外）は出さない。
// WHY cause が Error でなければ DrizzleQueryError の name（type）と params だけを出す: drizzle は pg の例外を cause に入れるが、
//   想定外の形のときに DrizzleQueryError の message（SQL と値）を出さない（fail closed）。
function failureFields(error: unknown): {
  error: unknown;
  statusCode?: string;
  constraint?: string;
  params?: readonly unknown[];
} {
  if (!(error instanceof DrizzleQueryError)) {
    return { error };
  }
  if (!(error.cause instanceof Error)) {
    return { error: { type: error.name }, params: error.params };
  }
  const { name, message, code, constraint } = error.cause as Error & {
    code?: unknown;
    constraint?: unknown;
  };
  return {
    error: { type: name, message: maskQuoted(message) },
    statusCode: typeof code === "string" ? code : undefined,
    constraint: typeof constraint === "string" ? constraint : undefined,
    params: error.params,
  };
}

// message の最初の " から最後の " までを "***" にする（" が 1 つだけならその後ろをすべて *** にする。" が無ければそのまま）。
// WHY 最初から最後までを 1 つにまとめる（"..." の組ごとに置き換えない）: pg は入力値の中の " を逃がさずに "<入力>" と書く
//   （入力 ab"cd x → invalid input syntax for type uuid: "ab"cd x"。2026-10-01 実測）。組ごとに置き換えると "ab" だけが消え、
//   cd x が残る。入力値はどれも " で囲まれるので、最初と最後の " の間に必ず収まる。
// 限界: 引用符の中の識別子（列名・制約名・表名）も消える（not-null 違反の列名など）。制約名は constraint、表名は db.collection.name に
//   別に出る。引用符で囲まない形の入力値は消えない（実測した 22003 の numeric field overflow などは値を含まない。logger の freeText が
//   最後の網）。
function maskQuoted(message: string): string {
  const first = message.indexOf('"');
  if (first === -1) {
    return message;
  }
  const last = message.lastIndexOf('"');
  return last === first
    ? `${message.slice(0, first)}"***`
    : `${message.slice(0, first)}"***"${message.slice(last + 1)}`;
}

// startedAt（performance.now()）からの経過時間（ミリ秒の整数に四捨五入）。
// WHY performance.now（now() にしない）: 経過時間の計測で、時刻ではない（単調に増え、時計の補正で戻らない）。現在時刻の
//   唯一の出口 now() の規則 now-single-source の対象外（rule-tests/architecture.test.ts）。
// WHY 整数に丸める: ミリ秒未満は書き込みの遅さの判断に要らず、浮動小数の桁（12.300000000000182 のような）で行が読みにくくなる。
function elapsedMs(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

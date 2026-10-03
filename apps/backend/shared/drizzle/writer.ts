import { randomUUID } from "node:crypto";
import { eq, getTableName, type Table } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { type ChangeEntry, ChangeRecords } from "../change-log/change-log";
import type { ChangeOperation } from "../change-log/change-operation";
import type { Transaction } from "../transaction/transaction";
import type { Database } from "./database";
import { DbWriteLog } from "./db-write-log";

// 書き込みの唯一の口（Writer。Issue #215。ADR docs/adr/architecture/20260930-transaction-from-application.md）。Repository
//   （*.postgres.ts）は行の変換だけを書き、insert / update / delete をこの Writer に渡す。Writer は 1 文ごとに次を横断的に行う:
//   (a) drizzle の insert / update / delete を .returning() で実行する。
//   (b) 変更履歴（change_logs。Issue #189）の記録を change-log.ts の組み立てで作り、同じトランザクションの change_logs に書く
//       （ChangeRecords.recordChange。文ごとに 1 回）。insert は全列の after、update は呼び出し側が渡した変える前の値（origin）を before、
//       渡した列を after、delete は消した行（returning）の全列の before。
//   (c) 書き込みの前後に 1 行ずつログ（event.name は db_write。Issue #205・#209）を出す（形と WHY は db-write-log.ts の DbWriteLog）。
// WHY Repository ではなく Writer が記録する（Issue #215 のユーザー判断「AOP のように共通で記録したい」）: 以前は Repository が
//   書き込みごとに記録（ChangeEntry）を組み立てて返していた（writeInTransaction。Issue #205）。Repository を足すたびに同じ組み立てを
//   書くことになり、書き忘れた書き込みは記録されない。Writer を通れば必ず記録とログが残る。Repository が change-log を import
//   することは rule-tests/persistence.test.ts の no-change-log-in-repository が止め、書き込みが Writer を通ることは
//   writes-through-writer が見る。
// WHY 以前の writeInTransaction（write.ts）を置き換える: トランザクションを張るのは command（application）の runner になり
//   （shared/drizzle/transaction.postgres.ts）、書き込みごとにトランザクションを張る入口は要らなくなった。
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
  // id の行の changes の列だけを UPDATE し、更新後の行を返す。origin は変える前の値（変更履歴とログの before）で、changes の列を
  //   すべて持つ（無ければ Error）。changes が空なら何もせず undefined を返す。行が無ければ Error。
  update<T extends TableWithId>(
    table: T,
    id: string,
    origin: Readonly<Partial<T["$inferSelect"]>>,
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
            ChangeRecords.insertEntry(table, row as RecordedRow, this.actorId),
          ),
        };
      },
    );
  }

  async update<T extends TableWithId>(
    table: T,
    id: string,
    origin: Readonly<Partial<T["$inferSelect"]>>,
    changes: Partial<T["$inferInsert"]>,
  ): Promise<T["$inferSelect"] | undefined> {
    // WHY 空なら何もしない（SQL もログも無し）: 空の SET は SQL にならない。Repository は差分（ChangedProps.of）をそのまま渡すので、
    //   変わった列が無い update は何もしない。行の有無も確かめない（呼び出し側は同じトランザクションで行を読んでいる）。
    if (Object.keys(changes).length === 0) {
      return undefined;
    }
    return this.logged(table, "update", [id], async () => {
      // WHY before に呼び出し側の origin を使う（Writer が行を読み直さない。Issue #312）: Repository は同じトランザクションで先に
      //   行を FOR UPDATE でロックして読み込み（command の findByIdForUpdate）、その値（origin）との差分を changes に渡す。ロックが
      //   取れているので origin は DB が UPDATE の直前に持っていた値と同じで、読み直すと update のたびに SELECT が 1 文増えるだけになる
      //   （Issue #215 から #312 までは Writer が SELECT … FOR UPDATE で読み直していた）。
      // WHY origin に無い列を、SQL を発行する前に Error にする: before が分からず記録が欠ける。呼び出し側の実装ミスで、UPDATE して
      //   から気づくより書く前に止める。英語: 開発者向けのエラー（Issue #116）。
      // WHY Object.hasOwn: "toString" のような Object.prototype の名前を「列がある」と取り違えない。
      const missing = Object.keys(changes).find(
        (key) => !Object.hasOwn(origin, key),
      );
      if (missing !== undefined) {
        throw new Error(
          `${getTableName(table)} origin has no column to update: ${missing}`,
        );
      }
      const [after] = (await this.tx
        .update(table)
        .set(changes as never)
        .where(eq(table.id, id))
        .returning()) as T["$inferSelect"][];
      // WHY Error（not_found にしない）: Repository は同じトランザクションで行を FOR UPDATE で読んでから update する（command の
      //   findByIdForUpdate）ので、行が無いのは呼び出し側の実装ミス。行が無いことは returning が 0 行であることで分かる。
      //   例外で logged の失敗のログになり、runner のトランザクションも ROLLBACK する。英語: 開発者向けのエラー（Issue #116）。
      if (after === undefined) {
        throw new Error(`${getTableName(table)} has no row to update: ${id}`);
      }
      return {
        result: after,
        entries: ChangeRecords.updateEntries(
          table,
          {
            rowId: id,
            origin: origin as Readonly<Record<string, unknown>>,
            changed: changes as Readonly<Record<string, unknown>>,
          },
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
            : [
                ChangeRecords.deleteEntry(
                  table,
                  deleted as RecordedRow,
                  this.actorId,
                ),
              ],
      };
    });
  }

  // statement（本体の 1 文と記録の組み立て）を実行し、記録を同じトランザクションの change_logs に書く。前後に 1 行ずつ logger で
  //   ログを出し（DbWriteLog。ログの形と WHY は db-write-log.ts）、失敗なら失敗の 1 行を出して同じ例外を投げ直す。
  private async logged<R>(
    table: Table,
    operation: ChangeOperation,
    rowIds: readonly string[],
    statement: () => Promise<{ result: R; entries: readonly ChangeEntry[] }>,
  ): Promise<R> {
    const log = DbWriteLog.start(table, operation, rowIds);
    let entries: readonly ChangeEntry[];
    let result: R;
    // WHY try は文と記録の書き込みだけを囲む: 失敗のログの対象は書き込み（本体・記録）の失敗だけ。後のログは外に置く。
    try {
      ({ result, entries } = await statement());
      await ChangeRecords.recordChange(this.tx, entries);
    } catch (error) {
      log.failed(error);
      throw error;
    }
    log.done(entries);
    return result;
  }

  // この Writer を Transaction（shared/transaction/transaction の brand の型）にする（PostgresTransactionRunner が work に渡す値）。
  // WHY cast をここに閉じる: Transaction は domain の brand の型で、infra の実体（Writer）を application・domain に見せない。
  //   作るのはこのメソッド、取り出すのは PostgresWriter.of だけにする。
  asTransaction(): Transaction {
    return this as unknown as Transaction;
  }

  // Repository が Transaction から Writer を取り出す 1 か所のメソッド（PostgresWriter.of(tx)）。
  // WHY instanceof で確かめる（cast で取り出さない）: InMemory の runner の Transaction（テスト用）などを Postgres の Repository に
  //   渡すのは組み立ての誤りで、黙って別の値を Writer として使わせない。英語: 開発者向けのエラー（Issue #116）。
  // WHY static メソッドの名前を of にする: Repository の書き込みが Writer を通ることを rule-tests/persistence.test.ts の
  //   writes-through-writer が `PostgresWriter.of(` の形で見る。
  // WHY 戻り値の型を PostgresWriter にする（以前は interface の Writer）: static を置いてよいのは自分のクラスを返すファクトリだけ
  //   （規則 no-static-in-instance-class。Issue #300）。取り出したものは tx そのもの（PostgresWriter）で、型を広げても値は変わらない。
  static of(tx: Transaction): PostgresWriter {
    if (!(tx instanceof PostgresWriter)) {
      throw new Error(
        "the transaction was not started by PostgresTransactionRunner",
      );
    }
    return tx;
  }
}

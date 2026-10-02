import { randomUUID } from "node:crypto";
import { now } from "@repo/shared/now";
import {
  todoStatusChanges,
  todos,
} from "../../features/todo/internal/infra/schema";
import type { Database } from "../../shared/infra/database";

// Todo のテストデータビルダー（Issue #240）。テストの前提の Todo を、todos と todo_status_changes に直接 INSERT して用意する。
//   使い方: `await aTodo(db).title("牛乳を買う").completed(true).createdAt(date).build()`。指定しなかった値は既定値になり、
//   build() が入れた値（BuiltTodo）を返す。
// WHY API（作成・完了の handler）を通さずに表に直接入れる（ユーザー判断 2026-10-01、Issue #240）:
//   - 前提の用意を、仕様の対象でない API の組み合わせに依存させない。表（集約の子表など）が増えるたびに「前提を作る API の手順」が
//     変わると、対象の API と関係の無い API の変更で仕様が落ちる。表に入れる値をここ 1 か所で決めれば、表が増えたときもここを直すだけ。
//   - API では作れない前提を作れる: 作成日時は API が now() で決めるので「同じ日時に作られた」「作成日時の古い順」を作れず（時計は
//     差し替えない。API 仕様は vi を使わない）、不変条件を満たさない行（完了の履歴の日時が作成日時より前・逆順の「壊れた Todo」）や
//     履歴の無い行（デプロイの途中で古い版が作ったもの）は API では作れない。
//   - 前提の変更の記録（change_logs）が混ざらない: Writer（shared/infra/writer.ts）を通らないので記録を書かず、仕様が確かめる記録は
//     対象の操作が残したものだけになる。
// WHY test-support/<feature>/ に置く（Issue #181 / #191）: テストだけが使うコード。本番のコードからの import は
//   rule-tests/test-support.test.ts が止め、Docker のイメージにも入らない（.dockerignore の **/test-support）。
// WHY Todo（domain）を通さない: Todo.create は作成日時を自分で決め、コンストラクタは不変条件を検証するので、壊れた行を作れない。
//   入れる値は表の列そのもので、Repository が読むとき（toTodo）に検証される。

// 完了の履歴の 1 件（Todo.statusChanges と同じ形）。
export type BuiltTodoStatusChange = { completed: boolean; changedAt: Date };

// build() が表に入れた値。id・title・completed・createdAt は todos の行、statusChanges は todo_status_changes の行を position の順に。
export type BuiltTodo = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  statusChanges: readonly BuiltTodoStatusChange[];
};

export function aTodo(db: Database): TodoBuilder {
  return new TodoBuilder(db, {});
}

// WHY setter ごとに新しいビルダーを返す（自分を書き換えない）: 共通の前提のビルダーを変数に入れて何度も build するときに、ある Todo
//   だけに足した指定（completed(true) など）がほかの Todo に漏れない。
export class TodoBuilder {
  constructor(
    private readonly db: Database,
    private readonly specified: Partial<BuiltTodo>,
  ) {}

  id(id: string): TodoBuilder {
    return this.with({ id });
  }

  title(title: string): TodoBuilder {
    return this.with({ title });
  }

  completed(completed: boolean): TodoBuilder {
    return this.with({ completed });
  }

  createdAt(createdAt: Date): TodoBuilder {
    return this.with({ createdAt });
  }

  // 完了の履歴をそのまま指定する（completed から導かない）。日時を createdAt より前・逆順にすると壊れた Todo、空にすると履歴の無い
  //   Todo（これも壊れた Todo。Repository は補わない。Issue #260）になる。
  statusChanges(statusChanges: readonly BuiltTodoStatusChange[]): TodoBuilder {
    return this.with({ statusChanges });
  }

  async build(): Promise<BuiltTodo> {
    const todo = this.values();
    await this.db.insert(todos).values({
      id: todo.id,
      title: todo.title,
      completed: todo.completed,
      createdAt: todo.createdAt,
    });
    // WHY 空なら INSERT しない: drizzle の values([]) は行の無い INSERT を作れずに例外を投げる。
    if (todo.statusChanges.length > 0) {
      await this.db.insert(todoStatusChanges).values(
        todo.statusChanges.map((change, position) => ({
          todoId: todo.id,
          position,
          ...change,
        })),
      );
    }
    return todo;
  }

  private with(values: Partial<BuiltTodo>): TodoBuilder {
    return new TodoBuilder(this.db, { ...this.specified, ...values });
  }

  // 指定と既定値を合わせた値。
  // WHY 既定値を build のたびに決める: id（randomUUID）と作成日時（now()）は Todo ごとに変える値で、ビルダーを作ったときに決めると
  //   同じビルダーから入れた 2 件が同じ id になる。
  // WHY タイトルの既定値は英語の固定の文字列: test-support は日本語の文言の規則（server-hardcoded-text）の対象外だが、既存の
  //   test-support に倣って英語にする。前提でタイトルを気にしない Todo に使う。
  private values(): BuiltTodo {
    const createdAt = this.specified.createdAt ?? now();
    const completed = this.specified.completed ?? false;
    return {
      id: this.specified.id ?? randomUUID(),
      title: this.specified.title ?? "Buy milk",
      completed,
      createdAt,
      statusChanges:
        this.specified.statusChanges ??
        defaultStatusChanges(completed, createdAt),
    };
  }
}

// 履歴を指定しないときの完了の履歴。作成時の未完了の 1 件、完了なら作成日時の完了をもう 1 件。
// WHY backfill（shared/drizzle/backfill/0001_todo_status_changes.sql）と同じ規則: 不変条件
//   （履歴は 1 件以上・作成日時より前にならない・最後の completed が今の値）を満たす最小の履歴で、前提の Todo を正しい Todo にする。
function defaultStatusChanges(
  completed: boolean,
  createdAt: Date,
): BuiltTodoStatusChange[] {
  const created = { completed: false, changedAt: createdAt };
  return completed
    ? [created, { completed: true, changedAt: createdAt }]
    : [created];
}

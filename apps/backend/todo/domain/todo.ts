import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../../shared/domain/domain-error";

// タイトルの不変条件: 前後の空白を除いて 1〜100 文字。規則はこのスキーマ 1 か所に宣言する（Issue #88）。
// WHY trim してから数え、trim した値を保持する: 空白だけのタイトルを「空」とみなし、
//   前後の空白の有無だけが違う Todo が混ざらないようにする。z.string().trim() は値を置き換える（後の refine も parse の結果も
//   trim 後の値）。
// WHY 文字数を Array.from で数える（zod の .min / .max を使わない）: .min / .max は String#length（UTF-16 のコード単位の数）で
//   数え、絵文字（サロゲートペア）を 2 と数える。利用者の感覚の「文字数」に近いコードポイント数で数える。
// WHY refine を 2 つに分ける: 空と長すぎで message を変える（どちらも API の ErrorResponse の message として画面に出る契約）。
//   zod は同じスキーマの refine をすべて実行するが、同じ値で両方が失敗することは無い（0 文字と 101 文字以上は両立しない）。
// WHY 100 文字: 一覧で 1 行に収まる程度の上限。上限を設けないと巨大な文字列でメモリと画面が埋まる。
// WHY 関数にする（スキーマを最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に作れば、上限や message の変異を
//   テストで検出できる（Issue #55）。
// WHY branded 型（TodoTitle）にしない: restore は保存済みの値を検証せずに受け取る（下の restore のコメント）ので、
//   brand を付けるには as で「検証済み」と偽ることになる。Todo のコンストラクタは private で、値を作る口（create /
//   rename / restore）が限られているので、Todo 型そのものが「口を通った値」であることを表している。
function todoTitleSchema() {
  const maxLength = 100;
  return z
    .string()
    .trim()
    .refine((title) => Array.from(title).length >= 1, {
      error: "タイトルを入力してください",
    })
    .refine((title) => Array.from(title).length <= maxLength, {
      error: `タイトルは ${maxLength} 文字以内で入力してください`,
    });
}

// Todo が持つ値のすべて（完全コンストラクタが受け取る値）の規則。
// WHY create でタイトル以外（id・作成日時）も検証する: コンストラクタに渡る値がすべて規則を満たすことを 1 つのスキーマで
//   宣言する。id は randomUUID で作るので常に満たすが、作成日時は引数で受け取れる（Invalid Date を渡せる）。
function todoPropsSchema() {
  return z.object({
    id: z.uuid(),
    title: todoTitleSchema(),
    completed: z.boolean(),
    createdAt: z.date({ error: "作成日時が不正です" }),
  });
}

// WHY 型をスキーマから導出する: 規則と型を 1 か所で宣言し、項目を足したときのずれを無くす。
type TodoProps = z.output<ReturnType<typeof todoPropsSchema>>;

// 規則で検証し、違反なら DomainError(validation_error) を投げる。
// WHY ZodError をそのまま投げない: domain の外（presentation の toErrorResponse）は DomainError だけを見て 400 に変換する。
//   zod を使っていることを domain の外に漏らさない。
// WHY message は最初の issue: 失敗した safeParse の issues は必ず 1 件以上ある。タイトルの規則は同じ値で 1 つしか
//   失敗しないので、最初の 1 件がそのまま理由になる。
function validate<Schema extends z.ZodType>(
  schema: Schema,
  value: z.input<Schema>,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new DomainError("validation_error", result.error.issues[0].message);
  }
  return result.data;
}

// Todo の Entity（集約ルート）。
// WHY 不変（immutable）にする: 変更系のメソッドは新しい Todo を返し、自分は変えない。
//   InMemory リポジトリは Todo をそのまま Map に保持するため、可変だと「取得した Todo を書き換えただけで
//   save 前にリポジトリの中身が変わる」ことが起きる。不変にすれば状態が変わるのは save したときだけになり、
//   DB に差し替えても同じ振る舞いになる。
// 完全コンストラクタ: コンストラクタは検証済みの値（TodoProps）だけを受け取り、自分では検証しない。
// WHY コンストラクタを private にする: 値を作る口を create / rename（todoPropsSchema・todoTitleSchema で検証する）と
//   restore（保存済みの値。検証しない理由は restore のコメント）に限り、規則を通らない Todo が作られないようにする。
// WHY コンストラクタで検証しない: restore（保存済みの値をそのまま受け取る）と changeCompletion（タイトルに触れない）で
//   タイトルを検証し直さないため。検証するのは値が外から入る口（create / rename）だけにする。
export class Todo {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
  readonly createdAt: Date;

  private constructor(props: TodoProps) {
    this.id = props.id;
    this.title = props.title;
    this.completed = props.completed;
    this.createdAt = props.createdAt;
  }

  // WHY createdAt を引数で受け取れるようにする: 一覧の並び順（作成日時の昇順）をテストで
  //   決まった時刻で検証するため。通常は省略して現在時刻を使う。
  static create(title: string, createdAt: Date = new Date()): Todo {
    return new Todo(
      validate(todoPropsSchema(), {
        id: randomUUID(),
        title,
        completed: false,
        createdAt,
      }),
    );
  }

  // 永続化した値から Todo を組み立て直す（Repository の実装が読み込みに使う）。
  // WHY create と分ける: create は新しい Todo を作る操作で、id と作成日時を自分で決め、未完了から始める。
  //   保存済みの Todo は id・完了状態・作成日時が決まっているので、それをそのまま受け取る口が要る
  //   （コンストラクタは private のため、Repository の実装から new できない）。
  // WHY todoPropsSchema で parse しない（Issue #88 で決めた）:
  //   - タイトルの規則: 値は保存するときに create / rename で検査済み。後から規則を厳しくした
  //     （上限の文字数を減らすなど）ときに、既存のデータを読んだだけで例外になり一覧が 500 になるのを避ける。
  //   - 型（id が文字列、completed が boolean、作成日時が Date）: DB の列の型と NOT NULL を Drizzle のスキーマ
  //     （infra/schema.ts）が保証し、Repository は型の付いた行から渡す。一覧のたびに全行を parse し直す意味が無い。
  //   そのため、利用者の入力から Todo を作るときには使わない（入力は create / rename を通す）。
  // WHY 引数をオブジェクトにする: 同じ型（string / boolean）の引数が並ぶので、順番の取り違えを防ぐ。
  static restore(values: TodoProps): Todo {
    return new Todo(values);
  }

  // WHY タイトルだけを検証する（todoPropsSchema で全体を parse しない）: 他の値は作ったとき（create）か保存済み（restore）の
  //   もので、ここで変えない。全体を検証し直すと、restore した値に今の規則を当てることになる（restore のコメント）。
  rename(title: string): Todo {
    return new Todo({ ...this, title: validate(todoTitleSchema(), title) });
  }

  // WHY toggle（反転）ではなく値を受け取る: API は「完了にする / 未完了に戻す」を completed の値で指定する。
  //   反転だと同じリクエストを 2 回送ったときに結果が変わる（冪等でなくなる）。
  // WHY タイトルを検証し直さない: 規則を厳しくした後の保存済みの Todo（restore したもの）でも、タイトルに触れない操作は
  //   できるようにする。completed は型（boolean）だけが規則。
  changeCompletion(completed: boolean): Todo {
    return new Todo({ ...this, completed });
  }
}

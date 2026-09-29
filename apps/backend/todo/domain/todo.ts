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
// WHY branded 型（TodoTitle）にしない: Todo のコンストラクタは private で、どの口（create / reconstruct / rename /
//   changeCompletion）もコンストラクタの検証（todoPropsSchema）を通る。Todo 型そのものが「不変条件を満たす値」で
//   あることを表しているので、title だけに brand を付けても守れるものが増えない。
// WHY todoPropsSchema の中でだけ使う: 口ごとに一部の項目だけを検証すると、どの口を通ったかで守られる規則が変わる
//   （Issue #94 で撤回した分け方）。規則はいつも全体で当てる。
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

// Todo が持つ値のすべて（完全コンストラクタが検証する値）の規則 = Todo の不変条件。
// WHY タイトル以外（id・完了状態・作成日時）も規則に含める: どの口から来た値も、すべてが規則を満たすことを 1 つの
//   スキーマで宣言する。create の id は randomUUID で常に満たすが、reconstruct は DB の行（Postgres の uuid 型は
//   版の桁が 0 の値も受け付ける）を、create の作成日時は引数（Invalid Date を渡せる）を受け取る。
// WHY 項目ごとに日本語の message を付ける: validate が最初の issue の message を DomainError の message にする。
//   zod の既定の文言（英語で zod の語彙を含む）を domain の外に出さない。
// WHY id は z.uuid()（RFC 9562 の形）: presentation の parseUuidParam と同じ形にそろえる。Todo の id は randomUUID（v4）で
//   作るので必ず満たす（docs/architecture-decisions.md の「入力検証を zod に統一」の実測）。
function todoPropsSchema() {
  return z.object({
    id: z.uuid({ error: "id が不正です" }),
    title: todoTitleSchema(),
    completed: z.boolean({ error: "完了状態が不正です" }),
    createdAt: z.date({ error: "作成日時が不正です" }),
  });
}

// WHY 型をスキーマから導出する: 規則と型を 1 か所で宣言し、項目を足したときのずれを無くす。
// WHY 入力の型（z.input）にする: コンストラクタは検証する前の値を受け取る（出力の型と同じ形だが、「検証済み」を意味しない）。
type TodoProps = z.input<ReturnType<typeof todoPropsSchema>>;

// 規則で検証し、違反なら DomainError(validation_error) を投げる。
// WHY ZodError をそのまま投げない: domain の外（presentation の toErrorResponse）は DomainError だけを見て 400 に変換する。
//   zod を使っていることを domain の外に漏らさない。
// WHY message は最初の issue: 失敗した safeParse の issues は必ず 1 件以上ある。タイトルの規則は同じ値で 1 つしか
//   失敗しないので、最初の 1 件がそのまま理由になる。複数の項目が同時に違反するとき（id とタイトルなど）は
//   スキーマの項目の順で最初のものになる。利用者の入力で違反しうるのはタイトルだけなので、1 件で足りる。
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
// 完全コンストラクタ: コンストラクタが毎回、値のすべてを不変条件（todoPropsSchema）で検証する（Issue #94）。
//   create / reconstruct / rename / changeCompletion はコンストラクタに値を渡すだけで、自分では検証しない。
// WHY 口によらず常に全体を検証する（口ごとに検証の範囲を分けない）: 「Todo 型の値 = 不変条件を満たす値」が
//   いつも成り立ち、どの口を通ったかを考えずに済む（ユーザー判断、Issue #94）。
//   以前（Issue #88）は reconstruct（当時の restore）は検証しない・rename はタイトルだけ・changeCompletion は検証しない、
//   と分けていた。規則を厳しくしたときに既存のデータを読んだだけで失敗させないためだったが、その代わりに
//   「規則を満たさない Todo」が存在しうる状態になっていた。
//   規則を変えるときは、既存のデータを先に移行（スキル db-migration）して規則に追従させる。
// WHY コンストラクタを private にする: 値を作る口を上の 4 つに限り、コンストラクタの検証を通らない Todo を作らせない。
// WHY 検証の結果（parse した値）を持つ: タイトルは trim した値が規則の対象で、その値を保持する（todoTitleSchema のコメント）。
export class Todo {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
  readonly createdAt: Date;

  private constructor(props: TodoProps) {
    const valid = validate(todoPropsSchema(), props);
    this.id = valid.id;
    this.title = valid.title;
    this.completed = valid.completed;
    this.createdAt = valid.createdAt;
  }

  // WHY createdAt を引数で受け取れるようにする: 一覧の並び順（作成日時の昇順）をテストで
  //   決まった時刻で検証するため。通常は省略して現在時刻を使う。
  static create(title: string, createdAt: Date = new Date()): Todo {
    return new Todo({ id: randomUUID(), title, completed: false, createdAt });
  }

  // 永続化した値から Todo を組み立て直す（Repository の実装が読み込みに使う）。
  // WHY create と分ける: create は新しい Todo を作る操作で、id と作成日時を自分で決め、未完了から始める。
  //   保存済みの Todo は id・完了状態・作成日時が決まっているので、それをそのまま受け取る口が要る
  //   （コンストラクタは private のため、Repository の実装から new できない）。
  // WHY 保存済みの値も検証する（Issue #94。Issue #88 の「検証しない」を撤回）: 他の口と同じく、コンストラクタが
  //   不変条件で検証する。満たさない値（規則を厳しくしたのに移行していない行、手で入れた行）は
  //   DomainError(validation_error) になる。それをどう扱うか（クライアントの誤りではないので 500）は
  //   Repository の実装が決める（infra/todo-repository.postgres.ts の toTodo）。
  // WHY 引数をオブジェクトにする: 同じ型（string / boolean）の引数が並ぶので、順番の取り違えを防ぐ。
  static reconstruct(values: TodoProps): Todo {
    return new Todo(values);
  }

  // WHY 他の値（id・完了状態・作成日時）を { ...this } で引き継ぐ: タイトルだけを変える操作。
  //   引き継いだ値も含めてコンストラクタが全体を検証する。
  rename(title: string): Todo {
    return new Todo({ ...this, title });
  }

  // WHY toggle（反転）ではなく値を受け取る: API は「完了にする / 未完了に戻す」を completed の値で指定する。
  //   反転だと同じリクエストを 2 回送ったときに結果が変わる（冪等でなくなる）。
  // completed の規則（boolean であること）も含めて、コンストラクタが全体を検証する。
  changeCompletion(completed: boolean): Todo {
    return new Todo({ ...this, completed });
  }
}

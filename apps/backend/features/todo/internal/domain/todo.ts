import { randomUUID } from "node:crypto";
import { Clock } from "@repo/shared/now";
import { z } from "zod";
import { KeyedIssue } from "../../../../shared/domain/keyed-issue";
import { DomainValidation } from "../../../../shared/domain/validate";

// タイトルの上限の文字数（前後の空白を除いたコードポイント数）。
// WHY export する（Issue #144）: presentation のリクエストのスキーマ（create-todo.api.ts・rename-todo.api.ts）が同じ上限を
//   同じキー（todo.title.tooLong）で重ね、項目ごとの誤り（Problem の errors）として返す。数値を 2 か所に書くと片方だけ
//   直してずれ、presentation が domain より厳しく（domain が通す値を弾く）なりうるので、この定数を参照させる。
// WHY UPPER_SNAKE_CASE: presentation が feature の domain から値で import してよいのは、この形の名前の定数だけ
//   （規則 presentation。rule-tests/architecture.test.ts）。Entity や関数を値で使わせない。
// WHY 100 文字: 一覧で 1 行に収まる程度の上限。上限を設けないと巨大な文字列でメモリと画面が埋まる。
export const TODO_TITLE_MAX_LENGTH = 100;

// 完了の履歴の 1 件: 完了状態が completed に変わった日時（changedAt）。Todo の履歴（statusChanges）の要素。
// WHY id を持たない: 履歴は Todo（集約）の中の値で、Todo の外から 1 件を指すことは無い。DB の行の id は永続化の都合で、
//   Repository（infra）だけが扱う。
export type TodoStatusChange = {
  readonly completed: boolean;
  readonly changedAt: Date;
};

// WHY 型をスキーマから導出する: 規則と型を 1 か所で宣言し、項目を足したときのずれを無くす。
// WHY 入力の型（z.input）にする: コンストラクタは検証する前の値を受け取る（出力の型と同じ形だが、「検証済み」を意味しない）。
// WHY Todo["todoPropsSchema"] と添字で参照する: スキーマは Todo の private メソッドで、`Todo.prototype.todoPropsSchema` のような
//   参照はクラスの外から private を読めず型エラーになる。添字の型（indexed access type）は private のメンバーも参照できる（TypeScript の仕様）。
type TodoProps = z.input<ReturnType<Todo["todoPropsSchema"]>>;

// Todo の Entity（集約ルート）。
// WHY 不変（immutable）にする: 変更系のメソッドは新しい Todo を返し、自分は変えない。
//   InMemory リポジトリは Todo をそのまま Map に保持するため、可変だと「取得した Todo を書き換えただけで
//   update 前にリポジトリの中身が変わる」ことが起きる。不変にすれば状態が変わるのは update したときだけになり、
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
// WHY 検証の結果（parse した値）を持つ: タイトルは trim した値が規則の対象で、その値を保持する（todoPropsSchema の title のコメント）。
export class Todo {
  readonly id: string;
  readonly title: string;
  readonly completed: boolean;
  readonly createdAt: Date;
  // 完了の履歴（古い順）。凍結した配列（todoPropsSchema の statusChanges）。
  readonly statusChanges: readonly TodoStatusChange[];
  // 読み込んだとき（reconstruct）の値。新規（create）なら undefined。外からは origin（getter）で読む（Issue #165）。
  // WHY Entity が持つ: Repository の update が「読み込んだときから変わった列だけ」を書き（別の列の同時更新を巻き戻さない）、
  //   新規か読み込み済みかを見分けるため。「自分が読み込まれたときに何だったか」は Entity の事実で、差分をどの列・
  //   どの SQL にするか（永続化の都合）は infra（Repository と shared/infra/changed-props.ts）に置く。
  // WHY 遷移メソッドに「何を変えたか」を記録させない: 記録させると遷移メソッドを足すたびに書く必要があり、書き忘れた
  //   変更は保存されない。読み込んだときの値と今の値を比べれば、どの遷移を通っても差分が取れる。
  // WHY private フィールド（#）と getter にする（readonly の公開フィールドにしない）: 公開フィールドは列挙される
  //   プロパティになり、値の等価（テストの toEqual）が「読み込んだかどうか」で変わり、直列化にも混ざる。origin は
  //   永続化のための付帯情報で、Todo の値ではない。
  readonly #origin: Readonly<TodoProps> | undefined;

  // origin: 検証した後の props（valid）から origin を決める関数。create は () => undefined、reconstruct は
  //   (valid) => valid、状態遷移（transition）は () => this.#origin（引き継ぐ）。
  private constructor(
    props: TodoProps,
    origin: (valid: TodoProps) => Readonly<TodoProps> | undefined,
  ) {
    const valid = DomainValidation.validated(this.todoPropsSchema(), props);
    this.id = valid.id;
    this.title = valid.title;
    this.completed = valid.completed;
    this.createdAt = valid.createdAt;
    this.statusChanges = valid.statusChanges;
    // WHY reconstruct は検証後の値（valid）を origin にする: 引数の値ではなく、今の値と同じ形（title は trim 後）で持つ。
    //   引数のままだと、前後に空白のある行を読んで何も変えずに update しただけで title が「変わった」ことになる。
    // WHY 値ではなく関数で受け取る: 検証後の値はコンストラクタの中でしか得られない。reconstruct で先に検証して渡すと、
    //   検証が口ごとに増える（完全コンストラクタはコンストラクタの 1 か所だけで検証する）。関数なら、どの口も同じ形で
    //   「valid から origin を決める」ことを書け、特別な値（番兵）で分岐せずに済む。
    this.#origin = origin(valid);
  }

  get origin(): Readonly<TodoProps> | undefined {
    return this.#origin;
  }

  // 新しい Todo を作る。id は randomUUID、作成日時は現在時刻（Clock.now()）、完了状態は未完了で始める。
  //   完了の履歴は「作成日時に未完了になった」の 1 件から始める（Issue #188）。
  // WHY 作成日時を引数で受け取らない: 「作ったときの時刻が入る」は Todo の生成ルールで、呼び出し側が時刻を渡せると
  //   そのルールが呼び出し側に漏れ、任意の時刻の Todo を作れてしまう。テストで時刻を決めるときは、現在時刻の唯一の出口
  //   Clock.now（apps/shared/now.ts）を vi.mock で差し替える（.claude/rules/testing.md）。
  // WHY origin は undefined: 新規で、読み込んだ値が無い。Repository の insert は origin が undefined の
  //   Todo だけを、update は origin のある Todo だけを受け付ける（取り違えを Error にする。Issue #215）。
  static create(title: string): Todo {
    const createdAt = Clock.now();
    return new Todo(
      {
        id: randomUUID(),
        title,
        completed: false,
        createdAt,
        statusChanges: [{ completed: false, changedAt: createdAt }],
      },
      () => undefined,
    );
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
  // 完了の履歴（statusChanges）も DB の行（子表 todo_status_changes）から受け取り、不変条件で検証する（Issue #188）。
  // WHY 検証した後の値を origin にする: Repository の update が、読み込んだときから変わった列だけを書くため（Issue #165）。
  static reconstruct(values: TodoProps): Todo {
    return new Todo(values, (valid) => valid);
  }

  // タイトルだけを変える操作。他の値は transition が引き継ぎ、引き継いだ値も含めてコンストラクタが全体を検証する。
  rename(title: string): Todo {
    return this.transition({ title });
  }

  // WHY toggle（反転）ではなく値を受け取る: API は「完了にする / 未完了に戻す」を completed の値で指定する。
  //   反転だと同じリクエストを 2 回送ったときに結果が変わる（冪等でなくなる）。
  // completed の規則（boolean であること）も含めて、コンストラクタが全体を検証する。
  // 完了状態が変わるときは、変わった後の値と現在時刻（Clock.now()）を完了の履歴の末尾に足す（Issue #188）。
  // WHY 今と同じ値なら遷移しない（this を返す）: 同じ状態への遷移を履歴に積むとノイズになる（「いつ完了したか」の
  //   答えが複数になる）。Todo が変わらないので、Repository の update も差分が無く SQL を発行しない。
  changeCompletion(completed: boolean): Todo {
    if (completed === this.completed) {
      return this;
    }
    return this.transition({
      completed,
      statusChanges: [
        ...this.statusChanges,
        { completed, changedAt: Clock.now() },
      ],
    });
  }

  // 状態遷移の共通部分: 変える項目だけを受け取り、他の値と origin を引き継いだ新しい Todo を返す。
  // WHY 遷移メソッドではなくここで origin を引き継ぐ: origin は「読み込んだときの値」で、どの遷移でも変わらない。
  //   遷移メソッドごとに書くと、遷移を足したときに引き継ぎ忘れが起き、読み込んで変えた Todo が新規（全列の
  //   INSERT）として保存され、一意制約違反になる。遷移メソッドは「何を変えるか」だけを書く。
  // WHY id と createdAt を変えられない型にする: 遷移で変わらない値（id は同一性、作成日時は生成時に決まる）。
  private transition(
    changes: Partial<Omit<TodoProps, "id" | "createdAt">>,
  ): Todo {
    return new Todo({ ...this.props(), ...changes }, () => this.#origin);
  }

  // 今の値（コンストラクタに渡す props の形）。
  // WHY { ...this } で展開せず項目を明示する: 展開はインスタンスの列挙されるプロパティをすべて拾うので、Todo に
  //   値ではないもの（origin のような付帯情報）を公開フィールドで足したときに、それが props に混ざる。props は
  //   不変条件の対象の項目だけにそろえる。
  private props(): TodoProps {
    return {
      id: this.id,
      title: this.title,
      completed: this.completed,
      createdAt: this.createdAt,
      statusChanges: this.statusChanges,
    };
  }

  // WHY Todo の private メソッドにする（モジュールの最上位の関数にしない。Issue #262）: backend の本番コードはクラスを基本にし、
  //   補助の関数も使うクラスのメソッドにする（ADR docs/adr/architecture/20261002-class-based-backend.md）。不変条件は Todo の規則で、
  //   読むのは Todo（コンストラクタ）だけなので private。インスタンスの状態は使わないが static にしない: インスタンスで使うクラスに static を置かない（規則 no-static-in-instance-class。Issue #300）。
  //   コンストラクタの中でも prototype のメソッドは呼べるので、値を代入する前に this.todoPropsSchema() で検証できる。
  // Todo が持つ値のすべて（完全コンストラクタが検証する値）の規則 = Todo の不変条件。
  // WHY タイトル以外（id・完了状態・作成日時）も規則に含める: どの口から来た値も、すべてが規則を満たすことを 1 つの
  //   スキーマで宣言する。create の id は randomUUID で常に満たすが、reconstruct は DB の行（Postgres の uuid 型は
  //   版の桁が 0 の値も受け付ける）を受け取る。create の作成日時（Clock.now()）も Date であることを型でしか保証しないので、同じく検証する。
  // WHY 項目ごとにキーを付ける: DomainValidation.validated（shared/domain/validate.ts）が最初の issue の message（= キー）を DomainError の key にする。
  //   zod の既定の文言（英語で zod の語彙を含む）を domain の外に出さない。キーの無い issue を作らないよう、検査を持つ
  //   zod のスキーマ・refine にはすべて KeyedIssue.of / KeyedIssue.refine を渡す（z.object 自身は、値が型の上でオブジェクトなので
  //   失敗しない）。渡し忘れは DomainValidation.validated が DomainError ではない Error（500）にする。
  // WHY id は z.uuid()（RFC 9562 の形）: presentation の ResourceId.parseUuid と同じ形にそろえる。Todo の id は randomUUID（v4）で
  //   作るので必ず満たす（ADR docs/adr/architecture/20260929-zod-for-backend-validation.md。z.uuid() は RFC 9562 の形だけで大文字も通す。.claude/rules/backend.md）。
  // WHY メソッドにする（スキーマを最上位の定数・static フィールドにしない）: 最上位の式や static フィールドの初期化は読み込み時にだけ評価される static な変異になり、
  //   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に作れば、比較や message の変異を
  //   テストで検出できる（Issue #55）。上限の値そのもの（TODO_TITLE_MAX_LENGTH）は最上位の定数なので、todo.test.ts が値と
  //   境界（100 は通し 101 は弾く）で固定する。
  // WHY branded 型（TodoTitle）にしない: Todo のコンストラクタは private で、どの口（create / reconstruct / rename /
  //   changeCompletion）もコンストラクタの検証（todoPropsSchema）を通る。Todo 型そのものが「不変条件を満たす値」で
  //   あることを表しているので、title だけに brand を付けても守れるものが増えない。
  // WHY title のスキーマを別の関数に切り出さない: 読むのはここ（todoPropsSchema の title）だけで、切り出すと規則が
  //   2 か所に分かれて見える（Issue #159）。口ごとに一部の項目だけを検証すると、どの口を通ったかで守られる規則が変わる
  //   （Issue #94 で撤回した分け方）ので、規則はいつも全体で当てる。
  private todoPropsSchema() {
    const fields = z.object({
      id: z.uuid(KeyedIssue.of("todo.id.invalid")),
      // タイトルの不変条件: 前後の空白を除いて 1〜TODO_TITLE_MAX_LENGTH 文字。Todo の規則は todoPropsSchema 1 か所に宣言する（Issue #88）。
      //   presentation は同じ規則を同じキーで重ねてよいが、これより厳しくしない（Issue #144。.claude/rules/backend.md）。
      // WHY trim してから数え、trim した値を保持する: 空白だけのタイトルを「空」とみなし、
      //   前後の空白の有無だけが違う Todo が混ざらないようにする。z.string().trim() は値を置き換える（後の refine も parse の結果も
      //   trim 後の値）。
      // WHY 文字数を Array.from で数える（zod の .min / .max を使わない）: .min / .max は String#length（UTF-16 のコード単位の数）で
      //   数え、絵文字（サロゲートペア）を 2 と数える。利用者の感覚の「文字数」に近いコードポイント数で数える。
      // WHY refine を 2 つに分ける: 空と長すぎでキーを変える（どちらも API の Problem Details の key として画面が翻訳する契約）。
      //   zod は同じスキーマの refine をすべて実行するが、同じ値で両方が失敗することは無い（0 文字と 101 文字以上は両立しない）。
      // WHY 文字列でないときのキーも付ける: todoPropsSchema の「zod の既定の文言を domain の外に出さない」に
      //   そろえる。この経路を通るのは型を as で偽ったときだけ（presentation は z.string で弾き、DB の列は NOT NULL text）。
      title: z
        .string(KeyedIssue.of("todo.title.invalid"))
        .trim()
        .refine(
          (title) => Array.from(title).length >= 1,
          KeyedIssue.of("todo.title.empty"),
        )
        .refine(
          (title) => Array.from(title).length <= TODO_TITLE_MAX_LENGTH,
          // 画面の文言に上限の文字数を埋め込めるよう、params で渡す（上限を変えても画面の辞書を直さずに済む）。
          KeyedIssue.refine("todo.title.tooLong", {
            max: TODO_TITLE_MAX_LENGTH,
          }),
        ),
      completed: z.boolean(KeyedIssue.of("todo.completed.invalid")),
      createdAt: z.date(KeyedIssue.of("todo.createdAt.invalid")),
      // 完了の履歴（Issue #188）。完了状態が変わるたびに、変わった後の値と日時を末尾に足す（古い順）。
      //   項目どうしの規則（今の completed・作成日時との関係）は、下の refine（isConsistentHistory）が見る。
      // WHY readonly()（zod が parse の結果を Object.freeze する）: 履歴は Todo の値で、Todo は不変。配列や要素を書き換えられると、
      //   InMemory が保持中の値や、update が比べる origin の履歴が update の前に変わる。
      // WHY 要素の z.object にキーを付けない: 外側の z.object と同じ（値が型の上でオブジェクトなので、as で偽らない限り失敗しない）。
      statusChanges: z
        .array(
          z
            .object({
              completed: z.boolean(KeyedIssue.of("todo.statusChanges.invalid")),
              changedAt: z.date(KeyedIssue.of("todo.statusChanges.invalid")),
            })
            .readonly(),
          KeyedIssue.of("todo.statusChanges.invalid"),
        )
        .readonly(),
    });
    return fields.refine(
      (props) => this.isConsistentHistory(props),
      KeyedIssue.of("todo.statusChanges.invalid"),
    );
  }

  // 完了の履歴の不変条件: 1 件以上、日時は作成日時から昇順（同じ値は可）、最後の completed は今の completed と等しい。
  // WHY todoPropsSchema の全体の refine にする（statusChanges の中に書かない）: 今の completed・作成日時と比べるので、
  //   statusChanges の中だけでは書けない。zod は項目の issue が続行可能（title の refine など）なら、この refine も実行する
  //   （zod 4.6.5 で確認）ので、空の配列もここで弾く（at(-1) が undefined）。
  // WHY 1 件以上: create が「作成日時に未完了」の 1 件から始める。0 件の Todo は「いつ未完了になったか」が分からない。
  // WHY 昇順（同じ値は可）: 足した順が時刻の順。同じ値を許すのは、Clock.now() はミリ秒で、作成と完了が同じミリ秒になりうるため。
  // WHY 最初の日時は作成日時以上: 作られる前に状態が変わることは無い。
  // WHY 最後の completed が今の completed と等しい: 今の完了状態（todos.completed の列。一覧・詳細はこれだけを読む）と、
  //   履歴から導いた最新の状態がずれると、どちらが正しいか決まらない。
  private isConsistentHistory({
    completed,
    createdAt,
    statusChanges,
  }: {
    completed: boolean;
    createdAt: Date;
    statusChanges: readonly TodoStatusChange[];
  }): boolean {
    if (statusChanges.at(-1)?.completed !== completed) {
      return false;
    }
    let previous = createdAt;
    for (const { changedAt } of statusChanges) {
      if (changedAt < previous) {
        return false;
      }
      previous = changedAt;
    }
    return true;
  }
}

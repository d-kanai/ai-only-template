import { randomUUID } from "node:crypto";
import { DomainError } from "@/backend/shared/domain/domain-error";

// WHY 100 文字: 一覧で 1 行に収まる程度の上限。上限を設けないと巨大な文字列でメモリと画面が埋まる。
const MAX_TITLE_LENGTH = 100;

// Todo の Entity（集約ルート）。
// WHY 不変（immutable）にする: 変更系のメソッドは新しい Todo を返し、自分は変えない。
//   InMemory リポジトリは Todo をそのまま Map に保持するため、可変だと「取得した Todo を書き換えただけで
//   save 前にリポジトリの中身が変わる」ことが起きる。不変にすれば状態が変わるのは save したときだけになり、
//   DB に差し替えても同じ振る舞いになる。
// WHY コンストラクタを private にする: 生成を create に限定し、不変条件（タイトルの長さ）を
//   通らない Todo が作られないようにする。
export class Todo {
  private constructor(
    readonly id: string,
    readonly title: string,
    readonly completed: boolean,
    readonly createdAt: Date,
  ) {}

  // WHY createdAt を引数で受け取れるようにする: 一覧の並び順（作成日時の昇順）をテストで
  //   決まった時刻で検証するため。通常は省略して現在時刻を使う。
  static create(title: string, createdAt: Date = new Date()): Todo {
    return new Todo(randomUUID(), normalizeTitle(title), false, createdAt);
  }

  // 永続化した値から Todo を組み立て直す（Repository の実装が読み込みに使う）。
  // WHY create と分ける: create は新しい Todo を作る操作で、id と作成日時を自分で決め、未完了から始める。
  //   保存済みの Todo は id・完了状態・作成日時が決まっているので、それをそのまま受け取る口が要る
  //   （コンストラクタは private のため、Repository の実装から new できない）。
  // WHY タイトルの不変条件で検査しない: 値は保存するときに create / rename で検査済み。後から規則を厳しくした
  //   （上限の文字数を減らすなど）ときに、既存のデータを読んだだけで例外になり一覧が 500 になるのを避ける。
  //   そのため、利用者の入力から Todo を作るときには使わない（入力は create / rename を通す）。
  // WHY 引数をオブジェクトにする: 同じ型（string / boolean）の引数が並ぶので、順番の取り違えを防ぐ。
  static restore(values: {
    id: string;
    title: string;
    completed: boolean;
    createdAt: Date;
  }): Todo {
    return new Todo(
      values.id,
      values.title,
      values.completed,
      values.createdAt,
    );
  }

  rename(title: string): Todo {
    return new Todo(
      this.id,
      normalizeTitle(title),
      this.completed,
      this.createdAt,
    );
  }

  // WHY toggle（反転）ではなく値を受け取る: API は「完了にする / 未完了に戻す」を completed の値で指定する。
  //   反転だと同じリクエストを 2 回送ったときに結果が変わる（冪等でなくなる）。
  changeCompletion(completed: boolean): Todo {
    return new Todo(this.id, this.title, completed, this.createdAt);
  }
}

// タイトルの不変条件: 前後の空白を除いて 1〜100 文字。
// WHY trim してから数え、trim した値を保持する: 空白だけのタイトルを「空」とみなし、
//   前後の空白の有無だけが違う Todo が混ざらないようにする。
// WHY 文字数を Array.from で数える: String#length は UTF-16 のコード単位の数で、絵文字（サロゲートペア）を
//   2 と数える。利用者の感覚の「文字数」に近いコードポイント数で数える。
function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  const length = Array.from(trimmed).length;
  if (length === 0) {
    throw new DomainError("validation_error", "タイトルを入力してください");
  }
  if (length > MAX_TITLE_LENGTH) {
    throw new DomainError(
      "validation_error",
      `タイトルは ${MAX_TITLE_LENGTH} 文字以内で入力してください`,
    );
  }
  return trimmed;
}

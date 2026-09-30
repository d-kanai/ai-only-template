import type {
  CreateTodoRequest,
  CreateTodoResponse,
} from "@repo/backend/features/todo/presentation/create-todo.api";
import type { GetTodoResponse } from "@repo/backend/features/todo/presentation/get-todo.api";
import type { ListTodosResponse } from "@repo/backend/features/todo/presentation/list-todos.api";
import type {
  UpdateTodoRequest,
  UpdateTodoResponse,
} from "@repo/backend/features/todo/presentation/update-todo.api";
import type { Problem } from "@repo/backend/shared/presentation/problem";
import { commonMessages } from "@/shared/i18n/common.messages";
import { isMessageKey } from "@/shared/i18n/i18n";
import { ApiError } from "./api-error";

// /api/todos を呼ぶ薄いラッパー。画面側のデータ取得は必ず「hook → ここ → Route Handler」を通す（SSR を前提にしない構成）。
// リクエスト / レスポンスの型は backend の presentation 層の型を import type で参照するだけにする。
// 実装を import しないことでサーバ専用のコードが画面のバンドルに入らず、型を共有することで契約のずれを型チェックで検出できる。

// 画面側で backend を参照してよいのはこのファイル（features/<feature>/api/）だけにする。
// WHY: 画面とサーバの境界（契約の型）を 1 ファイルに集約し、契約が変わったときの影響をここ 1 か所で追えるようにする。
//   hook や components は、ここで re-export した型を使い、backend のパスを直接書かない。
export type {
  CreateTodoRequest,
  CreateTodoResponse,
  GetTodoResponse,
  ListTodosResponse,
  UpdateTodoRequest,
  UpdateTodoResponse,
};

// 画面が扱う「Todo 1 件」の型。
// WHY 一覧 API の契約から導出する: backend に共通の DTO 型の別名を持たせず、画面側の 1 か所（ここ）で決める（Issue #139）。
export type Todo = ListTodosResponse["todos"][number];

// 一覧・作成の URL。
// WHY 関数の中に置く（モジュールの最上位の定数にしない）: 最上位の式は読み込み時にだけ評価される static な変異になり、
//   mutation testing では数えない（stryker.config.mjs の ignoreStatic）。呼び出し時に評価すれば、変異をテストで検出できる（Issue #55）。
function todosPath(): string {
  return "/api/todos";
}

// id はユーザー入力由来の URL（/todo/[id]）から来るため、"/" や "?" を含んでも別のパスやクエリにならないようエンコードする。
function todoPath(id: string): string {
  return `${todosPath()}/${encodeURIComponent(id)}`;
}

// 本文を送るときだけ Content-Type を付ける。GET / DELETE には本文がないため不要。
function jsonInit(method: "POST" | "PUT", body: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// null を除くオブジェクトか（配列も含む）。プロパティを読んでも例外にならないことだけを確かめる。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 本文が backend の Problem Details（RFC 9457。apps/backend/shared/presentation/problem.ts）かを確かめる。
// 見るもの: 標準のメンバーの type（文字列）と status（数値）、拡張メンバーの key（共通の辞書のキー）と params（省略かオブジェクト）と
//   errors（省略か、項目ごとの誤りの配列。isProblemError）。
// WHY detail・title・instance を見ない: 画面はこれらを使わない（detail は開発者向けの英語で契約外、title は type と 1 対 1）。
//   使わない値の検査は、崩れていても画面が壊れないのに失敗を error.unknown に変えるだけになる。
// WHY type と status も確かめる: key だけだと、ほかの形の本文（以前の { error: { key } } の形は key が入れ子なので外れるが、
//   偶然 key を持つ JSON など）も Problem Details とみなしてしまう。RFC 9457 の標準のメンバーを持つことで backend の応答と見分ける。
//   type が "/problems/..." のどれかまでは確かめない（ApiError の type は文字列のまま持つ。api-error.ts）。
// WHY `"key" in value` で絞り込まない: 無いプロパティは undefined として読めるので、in の検査は判定の結果を変えない。
//   結果を変えない検査は mutation testing で消しても落ちない（等価な変異）ため、Record として読んで型だけで判定する（Issue #55）。
// WHY key が共通の辞書（shared/i18n/common.messages.ts）のキーかまで確かめる: 版の違う backend が辞書に無いキーを返すと、
//   翻訳できない（formatMessage が辞書を引けない）。その応答は Problem Details とみなさず、HTTP ステータスだけを伝える（toError）。
//   実行時に確かめられるのは「共通の辞書のキー」までで、ErrorKey（サーバのエラーのキー）かどうかは確かめない。error.unknown・
//   error.unexpected が返っても、その文言が出るだけで壊れない。画面ごとの辞書のキー（"delete" など）は共通の辞書に無いので通さない。
// WHY params は省略か、配列でないオブジェクト: 値の型（string / number）までは確かめない。置換は String() で文字列にするので壊れない。
//   配列は Object.hasOwn で名前を引けず {id} が置き換わらないまま画面に出るので、Problem Details とみなさない（reviewer 指摘、Issue #126）。
// WHY 型の述語を Problem にする: 上の検査は Problem のすべてのメンバーを確かめるわけではない（type は和のどれか、key は ErrorKey か
//   までは見ない）が、読むのは type・key・params だけで、読む値はどれも検査済みの形（文字列・辞書のキー・オブジェクト）。
// WHY errors（項目ごとの誤り）は省略か配列で、要素が 1 件でも崩れていれば本文全体を Problem Details とみなさない（Issue #144）:
//   崩れた要素だけを捨てると、捨てた誤り（本文全体の誤りなど）が画面に出ないまま、残りの誤りだけで「その項目だけを直せばよい」
//   ように見える。本文の key・params が崩れているときと同じく、HTTP ステータス（error.unknown）で失敗だけを確かに伝える。
//   画面と API は同じリポジトリで同時に変えるので、崩れた要素は版のずれか不具合で、通常の応答では起きない。
//   要素の detail は本文の detail と同じ理由で見ない。
function isProblem(value: unknown): value is Problem {
  return (
    isRecord(value) &&
    typeof value.type === "string" &&
    typeof value.status === "number" &&
    isTranslatableKey(value.key) &&
    isParams(value.params) &&
    (value.errors === undefined ||
      (Array.isArray(value.errors) && value.errors.every(isProblemError)))
  );
}

// errors の要素 1 件: pointer（文字列）、key（共通の辞書のキー）、params（省略かオブジェクト）。本文の key・params と同じ検査。
// WHY pointer の中身（"#" で始まるか）までは確かめない: 画面は "#/<項目名>" と完全一致で比べ、一致しない pointer は
//   フォーム全体の文言にする（api-error.ts の toErrorMessages）ので、形が違っても文言は失われない。
function isProblemError(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.pointer === "string" &&
    isTranslatableKey(value.key) &&
    isParams(value.params)
  );
}

// 共通の辞書（shared/i18n/common.messages.ts）のキーの文字列か（isProblem の key の WHY）。
function isTranslatableKey(value: unknown): boolean {
  return typeof value === "string" && isMessageKey(commonMessages, value);
}

// params は省略か、配列でないオブジェクト（isProblem の params の WHY）。
function isParams(value: unknown): boolean {
  return value === undefined || (isRecord(value) && !Array.isArray(value));
}

// backend は失敗時に Problem Details（key と params）を返す契約なので、それを ApiError に載せる。文言は画面が辞書で決める（api-error.ts）。
// ただしプロキシや Next 自体のエラーページなど、backend を通らないエラーは JSON でないことがある。
// その場合も「失敗した」ことは伝わるよう、HTTP ステータスを error.unknown（画面側だけのキー）の params にする。
// WHY ApiError の status は本文の status ではなく HTTP の応答のステータス: RFC 9457 の 3.1.2 節で本文の status は参考（advisory）
//   とされ、途中の中継（プロキシ・キャッシュ）がステータスを変えることがある。画面が実際に受け取った値を正とし、本文を読めない
//   失敗（error.unknown）と同じ取り方にそろえる。
// WHY Content-Type（application/problem+json）を判定に使わない: response.json() は Content-Type にかかわらず本文を JSON として
//   読む（Fetch の仕様）。backend の応答かは本文の形（isProblem）で決め、判定の根拠を 1 つにする。
async function toError(response: Response): Promise<ApiError> {
  // 本文が JSON として読めない場合は Problem Details ではないので、undefined（形の判定で必ず外れる値）として扱う。
  // WHY 例外を握りつぶすのを response.json() だけにする: 以前は形の判定まで try の中に入れていたため、
  //   判定の書き間違い（null のプロパティを読むなど）で投げた TypeError も「JSON でない」扱いになり、
  //   ステータスの表示に化けて気づけなかった（Issue #55 の mutation testing で、判定の変異が生き残って判明）。
  const body: unknown = await response.json().catch(() => undefined);
  return isProblem(body)
    ? new ApiError({
        status: response.status,
        type: body.type,
        key: body.key,
        params: body.params,
        errors: body.errors,
      })
    : new ApiError({
        status: response.status,
        key: "error.unknown",
        params: { status: response.status },
      });
}

async function requestJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    throw await toError(response);
  }
  return (await response.json()) as T;
}

export function listTodos(): Promise<ListTodosResponse> {
  return requestJson(todosPath(), { method: "GET" });
}

export function getTodo(id: string): Promise<GetTodoResponse> {
  return requestJson(todoPath(id), { method: "GET" });
}

export function createTodo(
  request: CreateTodoRequest,
): Promise<CreateTodoResponse> {
  return requestJson(todosPath(), jsonInit("POST", request));
}

export function updateTodo(
  id: string,
  request: UpdateTodoRequest,
): Promise<UpdateTodoResponse> {
  return requestJson(todoPath(id), jsonInit("PUT", request));
}

// DELETE は 204（本文なし）を返す契約なので、requestJson で本文を読むと JSON の解析に失敗する。本文は読まない。
export async function deleteTodo(id: string): Promise<void> {
  const response = await fetch(todoPath(id), { method: "DELETE" });
  if (!response.ok) {
    throw await toError(response);
  }
}

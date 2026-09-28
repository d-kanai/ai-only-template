import { InvalidRequestError } from "@/backend/shared/presentation/http-error";

// リクエスト本文を JSON のオブジェクトとして読む。
// WHY Record<string, unknown> で返す: 中身の型は信用できないので unknown のままにし、
//   各 API が項目ごとに型を確かめてから使う（as で決めつけない）。
// WHY オブジェクト以外（配列・null・文字列など）を弾く: Todo API の本文はすべてオブジェクトで、
//   ここで弾いておけば各 API は「項目の型」の検査だけに集中できる。
export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // request.json() は JSON として読めないと SyntaxError を投げる。クライアントの誤りなので 400 にする。
    throw new InvalidRequestError("リクエスト本文が JSON ではありません");
  }
  if (!isJsonObject(body)) {
    throw new InvalidRequestError(
      "リクエスト本文は JSON のオブジェクトで指定してください",
    );
  }
  return body;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

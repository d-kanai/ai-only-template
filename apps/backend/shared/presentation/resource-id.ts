import { z } from "zod";
import { DomainError } from "../domain/domain-error";
import type { ErrorKey, ErrorParamsArgs } from "../domain/error-key";

// 動的セグメント（/api/<resource>/:id）の id が uuid の形でなければ、無いリソースとして DomainError(not_found) を投げる。
// WHY 404 にする（400 にしない）: /api/todos/abc は「その id のリソースは無い」と同じ意味で、Repository が
//   uuid の形でない id を「無い」として扱う契約とそろえる。
// WHY presentation で確かめる: id は URL から来るリクエストの「形」で、リソースの id は randomUUID（v4）で作る。
//   形の違う id を query / command に渡さない。Postgres の Repository の isUuid は防御として持つ
//   （todo-repository.postgres.ts のコメント）。
// WHY z.uuid()（RFC 9562 の形）: id は randomUUID で作るのでこの形に必ず合う。Postgres の uuid 型はより広い形
//   （版の桁が 0 など）も受け付けるが、そうした id のリソースはこのアプリでは作られない。
// WHY キーと params（notFoundKey・params）を呼び出し側が渡す: 「何が見つからないか」（todo.notFound など）は feature ごとに違い、
//   query / command が投げる not_found のキーと params とそろえる必要があるため。この関数は feature を知らない。
//   params の形は DomainError と同じくキーごとに型で縛る（error-key.ts の ErrorParamsArgs）。
// WHY shared/presentation に置く（各 api ファイルに重ねて書かない）: .claude/rules/backend.md が各ファイルに重ねて
//   書いてよいとしているのは DTO の型だけで、処理は含まない。同じ処理を 3 つの api ファイルに複製すると
//   片方だけ直してずれる。feature をまたがない汎用の処理なので、parseJsonBody と同じく shared/presentation に置く。
// WHY 関数の中で z.uuid() を作る: 最上位の定数は static な変異になり mutation testing で数えない（json-body.ts のコメント）。
export function parseUuidParam<K extends ErrorKey>(
  id: string,
  notFoundKey: K,
  ...params: ErrorParamsArgs<K>
): string {
  if (!z.uuid().safeParse(id).success) {
    throw new DomainError("not_found", notFoundKey, ...params);
  }
  return id;
}

import { z } from "zod";
import { DomainError } from "../domain/domain-error";
import type { ErrorKey, ErrorParamsArgs } from "../domain/error-key";

// 動的セグメント（/api/<resource>/:id）の id が uuid の形でなければ、無いリソースとして DomainError(not_found) を投げる。
// 形が合えば同じ値を返す。
// WHY 404 にする（400 にしない）: /api/todos/abc は「その id のリソースは無い」と同じ意味（無い uuid の id と同じ応答）。
// WHY presentation で確かめる（ここが唯一の検査）: id は URL から来るリクエストの「形」で、リソースの id は randomUUID（v4）で
//   作る。形の違う id を query / command / Repository に渡さない。Repository は形を検査せず、uuid の形でない id は
//   Postgres のエラー（500）になる（todo-repository.postgres.ts のコメント）。
// WHY z.uuid()（RFC 9562 の形）: id は randomUUID で作るのでこの形に必ず合う。Postgres の uuid 型はより広い形
//   （版の桁が 0 など）も受け付けるが、そうした id のリソースはこのアプリでは作られない。
// WHY キーと params（notFoundKey・params）を呼び出し側が渡す: 「何が見つからないか」（todo.notFound など）は feature ごとに違い、
//   query / command が投げる not_found のキーと params とそろえる必要があるため。このメソッドは feature を知らない。
//   params の形は DomainError と同じくキーごとに型で縛る（error-key.ts の ErrorParamsArgs）。
// WHY shared/presentation に置く（各 api ファイルに重ねて書かない）: .claude/rules/code/backend.md が各ファイルに重ねて
//   書いてよいとしているのは DTO の型だけで、処理は含まない。同じ処理を 3 つの api ファイルに複製すると
//   片方だけ直してずれる。feature をまたがない汎用の処理なので、RequestBody.parse と同じく shared/presentation に置く。
// WHY メソッドの中で z.uuid() を作る: 最上位の定数・static フィールドは static な変異になり mutation testing で数えない（json-body.ts のコメント）。
// WHY クラスの static メソッドにする: backend の本番コードは単独の関数を export しない（ADR
//   docs/adr/architecture/20261002-class-based-backend.md）。状態を持たない検査なので static にする。
export class ResourceId {
  static parseUuid<K extends ErrorKey>(
    id: string,
    notFoundKey: K,
    ...params: ErrorParamsArgs<K>
  ): string {
    if (!z.uuid().safeParse(id).success) {
      throw new DomainError("not_found", notFoundKey, ...params);
    }
    return id;
  }
}

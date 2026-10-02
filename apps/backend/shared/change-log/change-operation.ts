// 変更履歴（change_logs の operation 列）の操作の種類。行を足した（insert）・変えた（update）・消した（delete）。
// WHY 定数の配列にする（型だけにしない）: Drizzle の列の宣言（shared/change-log/change-log.schema.ts の text の enum）が値の一覧を要し、
//   列の型（ChangeOperation）もここから作る。一覧を 1 か所に置き、列の宣言と Repository の書く値をずらさない。
// WHY shared/change-log に置く: 変更履歴の記録の一部で、どの feature の Repository も同じ 3 つの操作で記録し（feature をまたぐ）、値は永続化の方式に
//   よらない（InMemory も同じ値を積む）。
export const CHANGE_OPERATIONS = ["insert", "update", "delete"] as const;

export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

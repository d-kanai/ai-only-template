// ルール検査テストの step で、表で並べたケース（[ケース名, ...入力]）をまとめて検査するための補助（Issue #282）。
// WHY 表を 1 つの step で回す: ルール検査テストは .feature（`*` の step）と step の実装に分けている。Vitest の it.each のように
//   ケースごとにテストを分けると .feature にケースの数だけ step を書くことになり、仕様として読む .feature が入力の列挙で埋まる。
//   .feature には「何を違反なし・違反にするか」を 1 行で書き、ケースは step の実装の表に置く。
// WHY ケース名をキーにした object で比べる: `expect(casesByName(cases, 実際)).toEqual(casesByName(cases, 期待))` と
//   書けば、落ちたときの diff にケース名が出て、どのケースが落ちたかが分かる（1 件目で止まらず、落ちたケースがすべて出る）。
// WHY 関数にする（クラスにしない）: 規則 class-based（rule-tests/architecture.test.ts）の対象は apps/ の下で、rule-tests/ の補助は
//   rule-tests/feature-business-language.ts と同じく関数で書く（Biome の noStaticOnlyClass も rule-tests/ では効いている）。
// WHY テストファイル（*.test.ts）から export しない: rule-tests/feature-business-language.ts の冒頭と同じ（Vitest が import 先の
//   テストも登録する・Biome の noExportsInTest）。
// cases の各行（先頭がケース名）に toValue を当て、ケース名 → 値の object にする。
// 注意: 実際の値と期待値の両方をこの関数で作るので、この関数が壊れて（例: 常に {} を返す）も、使う側の比較は緑のまま通る。
//   この関数の振る舞いは rule-tests/rule-test-feature.test.ts の「ケースの表」の step が固定している（変えるときはそこも直す）。
// WHY 同じケース名を拒否する: object のキーが重なると後の行が前の行を黙って上書きし、そのケースを検査しなくなる。
export function casesByName<Row extends readonly [string, ...unknown[]], Value>(
  cases: readonly Row[],
  toValue: (row: Row) => Value,
): Record<string, Value> {
  const result: Record<string, Value> = {};
  for (const row of cases) {
    const [name] = row;
    if (Object.hasOwn(result, name)) {
      throw new Error(`ケース名が重なっている: ${name}`);
    }
    result[name] = toValue(row);
  }
  return result;
}

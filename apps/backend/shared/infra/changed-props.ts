// 読み込んだときの値（origin）と今の値（current）を、current に持たせた項目だけ比べ、違う項目を今の値で返す。
// Repository の実装が save で「変わった列だけを UPDATE する」ために使う（Issue #165）。
// WHY 差分を infra が origin と今の値の比較で求める（Entity の遷移メソッドに「何を変えたか」を記録させない）:
//   Entity は不変で、遷移メソッド（rename など）は新しい Entity を返すだけで何も記録しない。記録させる形にすると、
//   遷移メソッドを足すたびに記録を書く必要があり、書き忘れた列は保存されない（黙って消える）。比較なら、どの遷移
//   メソッドを通っても値が違えば差分に入り、記録漏れが起きない。
// WHY Entity に依存しない汎用の関数にする（shared/infra に置く）: 差分の求め方は Entity によらず同じで、feature ごとの
//   Repository が同じ規則（Date の比較など）で使えるようにする。どの項目を比べるか（= 更新してよい列）は、列を知っている
//   各 Repository が current に持たせる項目で決める（比べる key の一覧を別に渡さない。二重に書くとずれる）。
// WHY 返り値に同じ項目を含めない（undefined の値でも入れない）: 返り値をそのまま UPDATE の SET に渡すので、
//   含めた項目は（値が同じでも）書き込まれ、別の接続が同時に変えたその列を巻き戻す。
export function changedProps<Props extends object, K extends keyof Props>(
  origin: Readonly<Props>,
  current: Readonly<Pick<Props, K>>,
): Partial<Pick<Props, K>> {
  const changed: Partial<Pick<Props, K>> = {};
  // WHY as: Object.keys は string[] を返し、current の key の型（K）を持たない。current は Pick<Props, K> なので
  //   列挙される key は K だけ。
  for (const key of Object.keys(current) as K[]) {
    if (!isSameValue(origin[key], current[key])) {
      changed[key] = current[key];
    }
  }
  return changed;
}

// WHY Date は getTime() で比べる: Object.is は同じ時刻でも別のインスタンスの Date を別と見る。DB から読み直した値や
//   コピーした値は別のインスタンスなので、Object.is だけでは「変わっていない日時」を変わったと判定してしまう。
// WHY それ以外は Object.is（=== ではない）: NaN を NaN と同じと見る（=== だと常に「変わった」になる）。0 と -0 は
//   別と見るが、列の値として区別されうるので、変わったとして書き込む側に倒す（書き漏らすより安全）。
//   オブジェクト・配列は参照で比べる（中身は比べない）。今使う列（文字列・真偽値・日時）には現れない。
function isSameValue(origin: unknown, current: unknown): boolean {
  if (origin instanceof Date && current instanceof Date) {
    return origin.getTime() === current.getTime();
  }
  return Object.is(origin, current);
}

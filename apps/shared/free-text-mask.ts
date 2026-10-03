// 自由文の最後の網と、マスクした値（log-event.ts の LOG_EVENT_SCHEMAS の印が使う。Issue #216）。
// WHY log-event.ts から分けた（Issue #384）: 本番のコードは 1 ファイル 1 クラス（Biome の style/noExcessiveClassesPerFile）・
//   1 ファイル 300 行以内（style/noExcessiveLinesPerFile）にする。log-event.ts（種類の一覧とスキーマ）と同じく exports に
//   置かない内部のファイルで、apps/shared の中から相対パスで読む（.claude/rules/code/shared.md）。

// マスクした値。WHY 固定の *** にする（ハッシュ・HMAC にしない）: 突き合わせの用途が今は無く、ハッシュは仮名化で GDPR 上は
//   個人データのまま（Issue #216 の採用しなかった案）。要るようになったら LogFieldMarks.sensitive の置換をここで差し替える。
export const MASK = "***";

// 自由文の最後の網（LogFieldMarks.freeText が使う）。
// WHY クラスを LogFieldMarks と分ける: 正規表現・切り詰め・Luhn は「文字列を受けて文字列を返す」処理で zod に依存せず、仕様
//   （log-event.test.ts の FreeTextMask.mask）も文字列で固定する。印（スキーマを返すもの）と分けると、どちらを直すかが名前で分かる。
export class FreeTextMask {
  // 自由文の上限の文字数と、切ったときに付ける印。
  // WHY 定数をメソッドの中で作る（static フィールドにしない）: クラスの static フィールドの初期化は読み込み時に 1 回だけ評価され、
  //   最上位の値と同じく Stryker の ignoreStatic で検査から外れるおそれがある（未確認。ADR
  //   docs/adr/architecture/20261002-class-based-backend.md。.claude/rules/quality/testing.md の mutation testing）。
  static limit(): { maxLength: number; marker: string } {
    return { maxLength: 2000, marker: "...[truncated]" };
  }

  // 自由文から、メールアドレス・JWT・Bearer のトークン・Luhn に合う 13〜19 桁の番号を *** にする。長すぎる文は先に切る。
  // WHY この 4 つ: 例外の message やパスに紛れ込みやすく、形で見分けられ、誤検知が少ないもの（Issue #216 の調査。電話番号は
  //   桁と区切りの形がほかの数字（日付・id・件数）と重なり誤検知が多いので入れない）。
  // WHY どの正規表現も入れ子の量指定子を使わない（(a+)+ のような形を書かない）: 入れ子の量指定子は、一致しかけて外れる入力で
  //   バックトラックが指数的に増える（ReDoS。/^([a-zA-Z]+)*$/ は 31 文字で 60 秒。Issue #216 の実測）。logger は要求の処理の中で
  //   同期に動くので、1 行のログで要求が止まる。各パターンは 1 つの量指定子の連続と固定の文字だけにし、開始位置は後読み（(?<!...)）で
  //   連続の先頭に限る（連続の途中から始めて同じ文字を読み直さない）。時間の上限は log-event.test.ts が 10 万文字で測る。
  // WHY 置換の順（Bearer → JWT → メール → 番号）: Bearer の後のトークンが JWT のときに、トークンごと（Bearer を含めて）1 つの ***
  //   にする（先に JWT を置き換えると "Bearer ***" が残り、Bearer の正規表現が * に一致しない）。
  // WHY メソッドの中に正規表現を書く（最上位の定数・static フィールドにしない）: 最上位の値は Stryker の static な変異になり、
  //   ignoreStatic で検査から外れる（.claude/rules/quality/testing.md の mutation testing）。static フィールドも同じく外れるおそれがある（未確認）。
  // WHY 番号の前に英数字・_・- が無いことを求める（(?<![\w-])。数字だけを見ない）: uuid（/todos/c98fc6d4-3505-4704-9400-118b…）の
  //   途中の「数字 4 桁の組 3 つと続く数字」が区切りつきの番号の形に一致し、Luhn に偶然合うと id が *** になった（Issue #304。
  //   E2E の request-log が uuid しだいで落ちた）。uuid の途中の数字の組は必ず「16 進の文字か -」の後に来るので、前だけ見れば外せる。
  // WHY 後ろは数字だけを見る（(?!\d) のまま）: 後ろにハイフン・英字が続く形（4111…-12/25 のように有効期限が続く・4111…_）を
  //   見逃さないため（reviewer の指摘）。限界: 前に英字・- が付く形（cc-4111…・x4111…）はマスクしない（uuid の途中と見分けない）。
  static mask(text: string): string {
    return FreeTextMask.truncate(text)
      .replace(/\bBearer\s+[\w.~+/-]+=*/gi, MASK)
      .replace(/eyJ[\w.-]+/g, MASK)
      .replace(/(?<![\w.%+-])[\w.%+-]+@[\w-]+\.[\w.-]+/g, MASK)
      .replace(
        /(?<![\w-])(?:\d{13,19}|\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7})(?!\d)/g,
        (match) =>
          FreeTextMask.isCardNumber(match.replace(/[ -]/g, "")) ? MASK : match,
      );
  }

  // 上限を超える文を、上限以内の最後の空白までに切り、印を付ける。
  // WHY 先に切る: 正規表現の時間は文の長さに比例するので、上限で時間も決まる。ログの 1 行の大きさ（費用・読みやすさ）も抑える。
  // WHY 切った位置にかかった語を捨てる: 途中で切れたメールアドレスやトークン（"alice@exa"）は正規表現に一致せず、断片が
  //   そのまま出てしまう。空白の無い長い文は全体が 1 語なので、本文を出さず印だけにする。
  // WHY 空白を後ろから 1 文字ずつ探す（/\s\S*$/ にしない）: /\S*$/ は各位置から末尾まで読み直し、空白の無い長い文で 2 乗の時間になる。
  private static truncate(text: string): string {
    const { maxLength, marker } = FreeTextMask.limit();
    if (text.length <= maxLength) {
      return text;
    }
    const head = text.slice(0, maxLength);
    let end = head.length;
    while (end > 0 && !/\s/.test(head[end - 1])) {
      end -= 1;
    }
    return `${head.slice(0, end).trimEnd()}${marker}`;
  }

  // 数字の列が Luhn のチェックディジットに合うか（カード番号の形。ISO/IEC 7812）。
  // WHY Luhn で確かめる: 13〜19 桁の数字だけで置き換えると、件数・時刻（ミリ秒の 13 桁）・注文番号なども消える。Luhn に偶然
  //   合うのは 10 件に 1 件で、誤検知を減らせる。
  // WHY 桁数をここで確かめない: 呼び出し元（FreeTextMask.mask）の正規表現が 13〜19 桁の列だけを渡す（4 桁ずつ区切る形も 13〜19 桁）。
  private static isCardNumber(digits: string): boolean {
    let sum = 0;
    for (let i = 0; i < digits.length; i += 1) {
      const digit = Number(digits[digits.length - 1 - i]);
      const doubled = i % 2 === 1 ? digit * 2 : digit;
      sum += doubled > 9 ? doubled - 9 : doubled;
    }
    return sum % 10 === 0;
  }
}

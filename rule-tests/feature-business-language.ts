// .feature（Gherkin）に書かない技術の言葉の一覧と判定。API ジャーニー（rule-tests/api-journey.test.ts の
//   api-journey-business-language。Issue #217）と API 仕様（rule-tests/api-spec.test.ts の api-spec-business-language。Issue #219）が
//   同じ一覧を使う。WHY（業務の言葉に限る理由・3 桁の数の扱い）は rule-tests/api-journey.test.ts の冒頭、.claude/rules/quality/testing.md の
//   「API ジャーニーテスト」「API 仕様テスト（spec/api）」。
// WHY 1 か所に置く: 一覧を 2 つのテストにそれぞれ書くと、語を足したときに片方だけが変わり、同じ .feature の言葉の規則がずれる。
// WHY テストファイル（*.test.ts）から export せず、テストでないこのモジュールに置く（Issue #219 で実測）:
//   - Vitest はテストファイルを import すると、その中の describe / it も import した側のテストとして登録する（rule-tests/ に
//     it を 1 つ持つ a.test.ts と、それを import する b.test.ts を置き、b だけを実行すると a の it も b の下で実行された）。
//     api-journey.test.ts から import すると、そのテストがすべて api-spec.test.ts でもう一度走る。
//   - Biome の recommended の lint/suspicious/noExportsInTest がテストファイルからの export を止める（biome check でエラーになった）。
// このファイルはテストではない（Vitest の include は rule-tests/**/*.test.ts）。判定はこれを import するテストの must pass /
//   must reject が固定する。

// .feature に書かない言葉（大文字小文字は区別しない）。
// WHY 正規表現の配列: 語ごとに境界（\b）の要否が違う。英語の短い語（id・title・DB・API・HTTP のメソッド）は語の一部（idea・
//   subtitle・MongoDB）で止めないよう境界を付け、長い語・日本語は含まれるだけで止める（PostgreSQL の SQL・HTTPS の HTTP も技術の言葉）。
// 限界: 複数形（ids・APIs）・綴りの揺れ・全角の数字と英字（２０１・ＤＢ）・ここに無い技術の言葉は見ない。語を足すときは、使う側の
//   テストの must reject の例も足す。
export const FORBIDDEN_WORDS_IN_FEATURE: readonly RegExp[] = [
  /\bDB\b/i,
  /データベース/i,
  /SQL/i,
  /テーブル/i,
  /カラム/i,
  /返り値/i,
  /戻り値/i,
  /レスポンス/i,
  /ステータス/i,
  /状態\s*\d{3}/i,
  // HTTP の状態コード（3 桁の 1xx〜5xx）。後ろに業務の数の助数詞（文字・件・行）が続くものは除く。
  // WHY 助数詞で分ける: 状態コードは数だけで書かれ（「201 で」）、業務の数（「100 文字」「200 件」）には数えるものの単位が後ろに
  //   付く。許す助数詞は今の業務で使うものだけにし、要るようになったら足す（広く許すと「200 個」のように状態コードを紛れ込ませる
  //   余地が増える）。
  /\b[1-5]\d{2}\b(?!\s*(?:文字|件|行))/i,
  // WHY 区切りに _ と - も許す: `/problems/not-found`（Problem Details の type）・`not_found`（DomainError の code）の書き方も止める。
  /problem[\s_-]*details/i,
  /JSON/i,
  /null/i,
  /undefined/i,
  /\binsert\b/i,
  /\bupdate\b/i,
  /\bdelete\b/i,
  // 表名（apps/backend の schema.ts の pgTable）。
  /\btodos\b/i,
  /todo_status_changes/i,
  // 表名 change_logs と、その業務風の言い換え。WHY: 変更の記録は Writer（shared/infra/writer.ts）が文ごとに自動で残す技術の
  //   仕組みで、業務の仕様ではない（ユーザー指示 2026-10-01）。記録の内容は、同じ操作の結果を確かめる step の実装の中で確かめる。
  //   区切りに空白・_・- を許し、単数形（change log）も止める。
  /change[\s_-]*logs?/i,
  /変更の記録/i,
  /変更履歴/i,
  /\bid\b/i,
  /uuid/i,
  /not[\s_-]*found/i,
  // 業務の言葉は「タイトル」。
  /\btitle\b/i,
  /\bcompleted\b/i,
  /\bAPI\b/i,
  /HTTP/i,
  /\b(?:GET|POST|PUT|PATCH|DELETE)\b/i,
  /エンドポイント/i,
  /リクエスト/i,
  /レコード/i,
  /バリデーション/i,
  /状態コード/i,
];

// line（.feature の 1 行）に禁止語のどれかが含まれるか。どの行を見るか（コメント・見出しを除くか）は使う側が決める。
export function containsForbiddenWord(line: string): boolean {
  return FORBIDDEN_WORDS_IN_FEATURE.some((word) => word.test(line));
}

// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）。このテストはファイルの一覧とソースを文字列として読むだけで
//   DOM を使わないため、node 環境で動かす。
import {
  type Dirent,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, expect } from "vitest";
import { casesByName } from "./case-table";
import { containsForbiddenWord } from "./feature-business-language";
import {
  type FeatureSection,
  featureLines,
  isSkippedLine,
  lacksSectionDivider,
  nextSection,
} from "./feature-lines";

// API ジャーニーテスト（Issue #187 / #200。.claude/rules/testing.md の「API ジャーニーテスト」、ADR
//   docs/adr/quality/20260930-backend-journey-tests.md と docs/adr/quality/20260930-gherkin-journeys-with-vitest-cucumber.md）の
//   置き場所と形を、ファイルの一覧とソースで機械的に検査するテスト。
// API ジャーニーテスト = 実 Postgres の上で、複数の API の handler（XxxApi.handle）を業務ユースケースに沿って順に呼ぶテスト。
//   業務の流れは Gherkin の <name>.feature に書き、step の実装を <name>.api-journey.test.ts に書く（この対が唯一の形。Issue #200 で
//   TS だけのジャーニー（*.journey.test.ts）は廃止した）。
// 違反にするもの:
//   - api-journey-placement: apps/backend/spec/journey/ の下には、直下の *.api-journey.test.ts と *.feature だけを置く。
//     サブディレクトリの中のファイル・テスト以外のファイル（補助の .ts・.md・.feature.md も）・名前に .api-journey の無いテスト
//     （x.test.ts・廃止した TS だけのジャーニーの x.journey.test.ts）・.tsx は違反。apps/ の下のほかの場所（features/x/spec/journey/・
//     旧名の journeys/ など）に *.api-journey.test.* / *.journey.test.* / *.feature を置くのも違反。
//     WHY 置き場所を 1 か所にする: API ジャーニーは feature をまたぐ業務の流れを置く場所で、features/<f>/ の下では feature を
//       またげない。直下の API ジャーニーだけにすると、test-support/database の import の例外（rule-tests/test-doubles.test.ts の
//       db-tests-in-infra-only）もこの 1 か所に絞れる。共通の補助が要るようになったら apps/backend/test-support/ に置く
//       （spec/journey/ に置かない）。
//     WHY テスト以外のソースも止める（architecture.test.ts の backend-placement でも止まるが、ここでも見る）: .md など
//       ソースでないファイルは backend-placement の対象外で、spec/journey/ を別の用途の置き場所にさせないため。
//     WHY spec/journey/ の外の .feature も止める（reviewer の指摘、Issue #200）: .feature を実行するのは対の
//       *.api-journey.test.ts だけで、外に置いた .feature（features/<f>/・frontend など）は対の検査（api-journey-feature-pair）の
//       対象にならず、何も実行されないまま残る。
//     WHY *.journey.test.* も止める: 廃止した TS だけのジャーニーの名前。どこに置いても違反にし、.feature + step の対に寄せる。
//     例外: apps/backend/spec/api/ の下の .feature（API 仕様。Issue #219）はこの規則の対象外。置き場所と対は
//       rule-tests/api-spec.test.ts の api-spec-placement / api-spec-pair が見る（ここで止めると API 仕様を置けない）。
//     例外: apps/e2e/ の下の .feature（E2E。Issue #279）もこの規則の対象外。E2E は playwright-bdd で .feature を実行し、置き場所と
//       対（<name>.feature ⇔ <name>.steps.ts）・中身は rule-tests/e2e-feature.test.ts が見る。
//   - api-journey-feature-pair（Issue #200）: apps/backend/spec/journey/ の直下の <name>.feature には、同じ場所に
//     <name>.api-journey.test.ts（step の実装）が要り、<name>.api-journey.test.ts には <name>.feature が要る。片方だけ・
//     名前の違う組（a.feature と b.api-journey.test.ts）は、対の無いほうのファイルを違反にする。
//     WHY: .feature だけでは何も実行されず（Vitest の include は *.test.ts）、書いた流れが検査されないまま残る。step のファイルだけ
//       だと loadFeature が読むファイルが無い。対の名前にそろえると、どの .feature をどのテストが実行するかがファイル名で分かる。
//     限界: step のファイルが loadFeature に渡すパスが対の .feature かは見ない（別の .feature を読んでも通る）。.feature の中身
//       （シナリオの数・step の書き方）も見ない（step の不足は vitest-cucumber が読み込み時に失敗にする）。
//   以下は .feature（apps/backend/spec/journey/ の直下の *.feature）の中身の規則（Issue #217）:
//   - api-journey-business-language: `#` のコメント行（仕切りの行は除く）と空行を除くすべての行（Feature / Background / Scenario /
//     Rule などの見出し、step（Given / When / Then / And / But / `*`）、説明の行・表の行、仕切り `# ───── <見出し> ─────` も）に、
//     FORBIDDEN_WORDS_IN_FEATURE（rule-tests/feature-business-language.ts。API 仕様の api-spec-business-language と共有。
//     Issue #219）の禁止語のどれかが含まれると違反（1 行 1 件。行はその行）。大文字小文字は区別しない（`Db` も違反）。
//     WHY: .feature は業務の仕様として、開発者でない人（業務の担当者・利用者）も読むもの。「DB」「返り値」「状態 201」のような技術の
//       言葉が混ざると、読める人が絞られ、業務の流れがどこに書いてあるかも埋もれる。技術の検証（状態コード・応答の形・DB の行）は
//       step の実装（*.api-journey.test.ts）に閉じ、.feature には業務の言葉で「何が起きるか」だけを書く（ユーザー判断、Issue #217）。
//     WHY 見出しと step 以外の行（説明・表）も見る: 業務の言葉にしたいのは読者が読む行すべてで、見出しと step だけにすると、説明の
//       行や表（`| id | title |`）に書いた技術の言葉が素通りする。見ない（読者向けでない）のは、仕切りでない `#` のコメント行だけ。
//     WHY コメント行を見ない: ファイル冒頭の技術の説明（step の実装の場所・vitest-cucumber の制約）は開発者向けのメモで、Gherkin では
//       実行にも仕様にも含まれない。
//     WHY 仕切りの見出しは見る（reviewer の指摘、Issue #217）: 仕切りは `#` で始まるが、読者が拾い読みする業務の動作の見出し。見ないと
//       技術の言葉を見出しに移すだけで検査を逃れられる（`# ───── POST /api/todos で DB に insert ─────` が違反 0 件だった）。
//     WHY 3 桁の数（1xx〜5xx）を HTTP の状態コードとして止め、後ろに「文字」「件」「行」が続くものは許す: 状態コードは「201」「404」の
//       ように数だけで書かれ、`状態` などの前置きが無くても技術の言葉になる。一方で業務の数（「100 文字のタイトル」「200 件の一覧」
//       「300 行のメモ」）は 3 桁でもありうり、数えるものの単位（助数詞）が後ろに付く。状態コードの後ろに助数詞は付かないので、
//       助数詞の有無で分ける。許す助数詞は今の業務で使うものだけにし、要るようになったら FORBIDDEN_WORDS_IN_FEATURE の除外に足す
//       （「円」「個」などを最初から広く許すと、「200 個」のような書き方で状態コードを紛れ込ませる余地が増える）。
//     WHY 引用符の中（step の値。"牛乳を買う"）も見る: 値も読者が読む仕様の一部。技術の言葉を含む値が要るときは別の値を選ぶ。
//   - api-journey-section-divider: シナリオ（Scenario / Scenario Outline / Scenario Template / Example）の中の When の行の直前の
//     行（空行を挟まない）が、仕切り `# ───── <見出し> ─────`（字下げは任意。`#`・空白 1 つ・`─` 5 つ・空白 1 つ・空白と `─` で始まり
//     終わらない見出し・空白 1 つ・`─` 5 つで行が終わる）でなければ違反（行は When の行）。形の違うもの（`─` の数が違う・見出しが
//     空・`#` の後に空白が無い・`-` や `━`・後ろに文字や空白がある）も違反。Background の中の When は見ない。
//     WHY: API を呼ぶ step（When）の前に業務の動作の名前（「Todo を作る」「一覧を見る」）の仕切りを置くと、長いシナリオでも、どこで
//       何をしているかを見出しで拾い読みできる（ユーザー判断、Issue #217）。
//     WHY 形を 1 つに固定する: 形が揺れると見た目がそろわず拾い読みしにくい。検査も「仕切りかどうか」を 1 つの正規表現で決められる。
//     WHY Background の When は見ない: Background は各シナリオの前提（表を空にする）で、業務の動作の区切りではない（今は Background に
//       When は無い）。
//     限界: 仕切りを付けるのは When の直前だけで、仕切りが When 以外（Given・Then・Background の中）の前にあっても止めない。API を
//       呼ぶ step を When 以外（Given の準備・`*`・And）で書くと、仕切りは要求されない。キーワードは英語（`# language:` で日本語の
//       キーワードにすると When を見分けられない）。
//     限界（両方の規則）: 行ごとに見るので、docstring（`"""` で囲んだ複数行の値）の中も行の種類を区別しない（中の `#` の行は
//       コメントとして禁止語を見ず、`When` で始まる行は When として仕切りを求める）。全角の数字・英字（`２０１`・`ＤＢ`）は禁止語として
//       見ない（正規表現は半角だけ）。複数形（ids・APIs）・一覧に無い技術の言葉も見ない。
//   - api-journey-tag（Issue #219 の reviewer の指摘）: `@` で始まる行（タグ。字下げの後）は違反。
//     WHY: vitest-cucumber は既定の excludeTags（`@ignore` など）が付いた Scenario を skip にし、流れが黙って外れたまま緑になる
//       （reviewer の実測）。タグで流れを分ける場面は無いので、タグそのものを使わない。
//   行の区切りは \r\n・\r・\n（vitest-cucumber の readline と同じ。単独の \r で行を隠させない。Issue #219 の reviewer の指摘）。
//   以下は API ジャーニー（apps/backend/spec/journey/ の直下の *.api-journey.test.ts）の中身の規則:
//   - api-journey-no-in-memory: *.in-memory（InMemory の Repository）を import しない（`import type` も・`import()` も・`export … from` も）。
//     WHY: ジャーニーは本番と同じ部品（Postgres の Repository）で API のつながりを確かめる。InMemory で組むと単体テストと同じになる。
//     WHY import type も違反: 型だけでも InMemory で組み立てる形の入口になる。ジャーニーに InMemory の型が要る場面は無い。
//   - api-journey-no-vi: `vitest` から `vi`（と同じものの別名 `vitest`）を import しない。`vi as v` の別名・名前空間（`import * as x`）・
//     既定の import・dynamic `import("vitest")` も違反（名前空間・既定・dynamic は、取り出す名前によらず違反）。`import type` と
//     inline の `type` は通す（型だけでは vi を呼べない）。vitest の設定で globals は無効なので、import しなければ `vi` は使えない。
//     WHY: テストダブル（`vi.mock`・`vi.spyOn(...).mockResolvedValue`・`vi.useFakeTimers` / `vi.setSystemTime`・`vi.stubGlobal`）は
//       差し替えた部分のつながりを確かめなくする。以前の journey-no-mock は `vi.mock(` / `vi.doMock(` の呼び出しだけを見ていて、
//       ほかのメソッドや `vi?.mock` が通った（reviewer の指摘、Issue #187）。使い方の列挙は漏れるので、入口の import で止める。
//       時計も差し替えず、実時計のままで成り立つ流れを書く（作成順は todo-lifecycle.api-journey.test.ts の waitUntilAfter のように
//       実時計が進むのを待つ）。
//   - api-journey-handler-naming: `new XxxApi(`（名前が Api で終わるクラス）は `<名前> = ` か `<名前>: `（オブジェクトのキー）の直後にだけ
//     書き、名前は HTTP メソッドで始める（大文字小文字を区別しない前方一致。変更系は post / put / patch / delete、読み取りは get /
//     list）。名前の無い `new XxxApi(`（`await new XxxApi(c).handle(r)`）も違反。行は `new XxxApi(` の行。
//     WHY: 次の api-journey-asserts-db-after-mutation は、呼び出しの名前で変更系を見分ける。`renameTodo` のような名前だと変更系と
//       分からず、DB の検証が無くても通ってしまう。名前を規約に縛って、見分けの漏れを止める。
//   - api-journey-asserts-db-after-mutation: 変更系の handler の呼び出し（`await <名前>(`・`await <名前>.handle(`・
//     `await <x>.<名前>(`。<名前> が post / put / patch / delete で始まる）の後、次の変更系の呼び出し（無ければファイル末尾）までに、
//     DB の読み取り `db.select(`（`database.db.select(` など。`db` の前は識別子の文字でないこと、`.` と `(` の前後の空白・改行は可）
//     が無ければ違反。行は呼び出しの行。読み取り系（get / list）の後は見ない。
//     WHY: 応答が正しくても永続化がずれる誤り（差分 UPDATE の漏れ・where の欠落・削除の取り違え）は、次の API の応答だけでは
//       見逃しうる。API ジャーニーは実 DB を使う唯一の複数 API のテストなので、変更のたびに行を見る（ユーザー判断、Issue #187）。
//     WHY db. を必須にする: `.select(` だけでは、DB 以外の select（`repository.select(`）や別の接続（`tx.select(`）と区別できない。
//     WHY 文字列の中の db.select( を数えない（コメントと同じ）: 読み取りは「ある」ほうが違反を消すので、数えない側が安全側。
//       逆に変更系の呼び出しは、文字列の中の `await postX(` も数える（数える側が安全側）。
//   - api-journey-uses-multiple-apis: 異なる *.api モジュール（presentation の api ファイル）を 2 つ以上、値として import する。
//     WHY: 1 つの API だけなら presentation の単体テスト（*.api.test.ts）の範囲で、API ジャーニー（複数の API の流れ）ではない。
//     数え方: 参照先を解決したパス（拡張子なし）で数える（`./x.api` と `./x.api.ts` は 1 つ）。`import type` と、すべてに inline の
//       type が付いたもの（`{ type A }`）は数えない（handler を呼べない）。
//   - api-journey-uses-real-database: apps/backend/test-support/database（TestDatabase.create）を値として import する。
//     WHY: 実 DB で流れを確かめるのが API ジャーニーの目的。型だけの import（TestDatabase）では実 DB を用意しない。
//   - api-journey-no-skip（Issue #219 の reviewer の指摘）: `.skip` / `.only` / `.skipIf` / `.runIf`（`Scenario.skip(`・
//     `describeFeature.skip(`・`it.skipIf(` など。直前が `.` のスプレッドは除く。文字列の中は見ない）と、タグの絞り込み
//     includeTags / excludeTags の名前は、その行の違反。
//     WHY: skip した Scenario は skipped のまま Vitest が成功で終わり（reviewer の実測）、only はほかの Scenario を黙って止める。
//       Biome の noSkippedTests / noFocusedTests は `Scenario.skip(` / `Scenario.only(` を止めない（Issue #219 で実測）。
// コメントの扱い: 行コメントとブロックコメントの中は見ない（文字列は残す。architecture.test.ts の stripComments と同じ）。
//   コメントの中の import・呼び出し・`db.select(` は、違反にも必須にも数えない。
// 限界（文字列の一致と行の順序で推定する）:
//   - vi: require で読む・変数を渡す `import(x)`・文字列の名前の import（`import { "vi" as v }`）・vitest のサブパスや別のモジュールが
//     再公開した vi は見ない。
//   - 変更系の見分け: 名前の規約で推定する。handler を別の名前の変数に入れ直す（`const r = putTitle`）・`await` を付けずに呼ぶ・
//     Api のクラスを別名で import する（`import { CreateTodoApi as C }`）と見分けられない。
//     名前の HTTP メソッドと Api の実際のメソッドが合っているかは見ない（変更系の Api を `getRenamed` のように get / list で始まる
//     名前に入れると DB の読み取りの検査を素通りする。`listener` のように前方一致だけで通る名前も同じ）。
//     クラス名が Api で終わらない handler は命名の検査の対象外。
//   - DB の読み取り: `db.select(` があるかだけを見て、結果を検証しているか（`toStrictEqual` で行全体と比べているか）は見ない。
//     実行の順ではなくソースの順で見るので、変更系と次の変更系の間に置いた補助の関数の定義の中の `db.select(` も数える。
//   - 「業務ユースケースに沿っているか」「DB の行を期待の行全体と比べているか」は見ない（reviewer が見る）。
//   - .feature の step（*.api-journey.test.ts）: step の関数の中の呼び出しもソースの順で見る。変更系の step（When）の後に、
//     DB を読む step（Then / And）をソースで後ろに書けば通る。step の関数を .feature と違う順に書くと、実行の順（.feature の順）と
//     検査の順（ソースの順）がずれる。
// WHY 文字列で判定する（AST にしない）: 見るのはパスと import の参照先と名前・呼び出しの形だけで、正規表現で足りる
//   （rule-tests/test-doubles.test.ts と同じ）。
// .feature（api-journey.feature）と step の実装（このファイル）に分けた（Issue #282）。

type ApiJourneyRuleId =
  | "api-journey-placement"
  | "api-journey-feature-pair"
  | "api-journey-business-language"
  | "api-journey-section-divider"
  | "api-journey-no-in-memory"
  | "api-journey-no-vi"
  | "api-journey-handler-naming"
  | "api-journey-asserts-db-after-mutation"
  | "api-journey-uses-multiple-apis"
  | "api-journey-uses-real-database"
  | "api-journey-tag"
  | "api-journey-no-skip";

// line: ソースの中の位置で決まる違反だけ持つ（1 始まり）。ファイル全体で決まる違反（置き場所・必須の import）は持たない。
type ApiJourneyViolation = { rule: ApiJourneyRuleId; line?: number };

const API_JOURNEYS_DIR = "apps/backend/spec/journey/";

// API ジャーニー（step の実装）のファイルか（apps/backend/spec/journey/ の直下の *.api-journey.test.ts）。
function isApiJourneyFile(path: string): boolean {
  return /^apps\/backend\/spec\/journey\/[^/]+\.api-journey\.test\.ts$/.test(
    path,
  );
}

// Gherkin のファイルか（apps/backend/spec/journey/ の直下の *.feature。Issue #200）。
function isFeatureFile(path: string): boolean {
  return /^apps\/backend\/spec\/journey\/[^/]+\.feature$/.test(path);
}

// spec/journey/ の外で、置いてあれば置き場所の違反になる名前（api-journey-placement）。
// WHY 拡張子を広く取る: .tsx・.js などで spec/journey/ の外に置いても、置き場所の違反として見つける。
// WHY .journey.test.* も含める: 廃止した TS だけのジャーニーの名前（Issue #200）。
// WHY .feature も含める（reviewer の指摘、Issue #200）: 外の .feature は対の検査の対象にならず、何も実行されないまま残る。
const OUTSIDE_API_JOURNEY_FILE =
  /\.(?:api-)?journey\.test\.[cm]?[jt]sx?$|\.feature$/;

// API 仕様の置き場所（Issue #219）と E2E の置き場所（Issue #279）。この下の .feature はそれぞれのもので、api-journey-placement の
//   対象外（置き場所と対は rule-tests/api-spec.test.ts と rule-tests/e2e-feature.test.ts が見る）。
const OTHER_FEATURE_DIRS = ["apps/backend/spec/api/", "apps/e2e/"];

// spec/journey/ の外で、置き場所の違反として見るファイルか（API 仕様と E2E の .feature を除く）。
function isOutsideApiJourneyTarget(path: string): boolean {
  return (
    OUTSIDE_API_JOURNEY_FILE.test(path) &&
    !(
      OTHER_FEATURE_DIRS.some((dir) => path.startsWith(dir)) &&
      path.endsWith(".feature")
    )
  );
}

// path（リポジトリ相対、/ 区切り）が置き場所の規則に違反するか。
function isMisplacedApiJourneyFile(path: string): boolean {
  if (path.startsWith(API_JOURNEYS_DIR)) {
    return !isApiJourneyFile(path) && !isFeatureFile(path);
  }
  return isOutsideApiJourneyTarget(path);
}

// コメントを消す（文字列は残す。改行は残して行番号を変えない）。architecture.test.ts の stripComments と同じ正規表現。
// WHY 文字列を先に一致させる: 文字列の中の "//"（"http://localhost" など）をコメントの開始と誤認しない。
function stripComments(source: string): string {
  const stringOrComment =
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(stringOrComment, (match, literal?: string) =>
    literal === undefined ? match.replace(/[^\n]/g, " ") : literal,
  );
}

// import の種類。value: 値の名前を 1 つ以上取る静的な import（handler を呼べる）。type: `import type` か、すべてに inline の type。
//   dynamic: dynamic import()（モジュール全体を実行時に受け取る）。
//   other: 副作用だけの import・export … from（参照はするが、値の名前を手元に取らない）。
type ImportKind = "value" | "type" | "dynamic" | "other";

// clause: 静的な import / export の、import（export）と from の間（`{ a, b as c }`・`* as x`・`X, { y }`）。それ以外は ""。
type ImportRef = {
  specifier: string;
  kind: ImportKind;
  clause: string;
  line: number;
};

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// `{ type A, type B }` のように、名前の並びだけで、すべてに inline の type が付いているか（architecture.test.ts の isInlineTypeOnly と同じ）。
function isInlineTypeOnly(clause: string): boolean {
  const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
  if (braces === null) {
    return false;
  }
  const names = (braces[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return names.length > 0 && names.every((name) => /^type\s/.test(name));
}

// ソース（コメントを消したもの）の import / export … from / import "…" / import("…") の参照先。
// 正規表現の WHY（<句> の文字を限定する・文の先頭に限る）は architecture.test.ts の IMPORT_EXPORT_FROM のコメント。
function extractImports(code: string): ImportRef[] {
  const staticImports = [
    ...code.matchAll(
      /(?:^|;)\s*(import|export)\s+(type\s+)?((?:(?!^\s*(?:import|export)\b)[\w\s{},*$])*?)\s*\bfrom\s*(["'])([^"'\n]+)\4/gm,
    ),
  ].map((match): ImportRef => {
    const [whole, keyword, typeKeyword, clause, , specifier = ""] = match;
    const kind: ImportKind =
      keyword === "export"
        ? "other"
        : typeKeyword !== undefined || isInlineTypeOnly(clause ?? "")
          ? "type"
          : "value";
    return {
      specifier,
      kind,
      clause: clause ?? "",
      // WHY 参照先の位置で行を数える: 一致は前の空行（\s*）から始まることがあり、先頭の位置では import の行とずれる。
      line: lineAt(code, match.index + whole.lastIndexOf(specifier)),
    };
  });
  const otherImports = (pattern: RegExp, kind: ImportKind) =>
    [...code.matchAll(pattern)].map(
      (match): ImportRef => ({
        specifier: match[2] ?? "",
        kind,
        clause: "",
        line: lineAt(code, match.index),
      }),
    );
  return [
    ...staticImports,
    ...otherImports(/\bimport\s*(["'])([^"'\n]+)\1/g, "other"),
    ...otherImports(/\bimport\s*\(\s*(["'`])([^"'`$\n]+)\1\s*[,)]/g, "dynamic"),
  ];
}

// 参照先の最後の要素から拡張子を除いた名前（"../x/todo-repository.in-memory.ts" → "todo-repository.in-memory"）。
function moduleBaseName(specifier: string): string {
  return (specifier.split("/").pop() ?? "").replace(/\.[cm]?[jt]sx?$/, "");
}

// 参照先をリポジトリ相対のパス（拡張子なし）にする。自前のコードでない参照（パッケージ）は undefined。
// WHY 解決して比べる: `../../test-support/database` と `@repo/backend/test-support/database` は同じモジュール。書き方の文字列で
//   比べると、書き方を変えるだけで必須の import を満たせなくなり、同じ api を別の書き方で 2 回 import して 2 つと数えてしまう。
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const alias = "@repo/backend/";
  const resolved = specifier.startsWith(".")
    ? posix.join(posix.dirname(from), specifier)
    : specifier.startsWith(alias)
      ? posix.join("apps/backend", specifier.slice(alias.length))
      : undefined;
  return resolved?.replace(/\.[cm]?[jt]sx?$/, "");
}

// vitest の import が vi に届くか（api-journey-no-vi）。
// dynamic import() はモジュール全体を受け取るので届く。静的な import は、名前空間（`* as x`）・既定の名前（`X`）があれば届き、
//   `{ … }` の中は `vi` か `vitest`（vitest が vi と同じものを 2 つの名前で export している。vitest 5.0.1 の dist/index.d.ts）を
//   inline の type なしで取れば届く。`import type` 全体と副作用だけの import・export … from は届かない。
function reachesVi(ref: ImportRef): boolean {
  if (ref.kind === "dynamic") {
    return true;
  }
  if (ref.kind !== "value") {
    return false;
  }
  const braces = /\{([\s\S]*)\}/.exec(ref.clause);
  const outsideBraces = ref.clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "");
  const names = (braces?.[1] ?? "").split(",").map((name) => name.trim());
  return (
    outsideBraces.trim() !== "" ||
    names.some((name) => /^(?:vi|vitest)(?:\s+as\s+[\w$]+)?$/.test(name))
  );
}

// handler の名前の規約（api-journey-handler-naming）: HTTP メソッドで始まる（大文字小文字を区別しない前方一致）。
function isHandlerName(name: string): boolean {
  return /^(?:get|list|post|put|patch|delete)/i.test(name);
}

// 変更系の handler の名前か（api-journey-asserts-db-after-mutation）。読み取り系（get / list）は含めない。
function isMutationHandlerName(name: string): boolean {
  return /^(?:post|put|patch|delete)/i.test(name);
}

// 文字列の中身を空白にする（改行と長さは残し、位置と行番号を変えない）。stripComments の後に使う。
// WHY: 文字列の中の `db.select(` を DB の読み取りと数えない（読み取りを数えると違反が消えるので、数えない側が安全側）。
function blankStrings(code: string): string {
  return code.replace(
    /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    (literal) => literal.replace(/[^\n]/g, " "),
  );
}

// `new XxxApi(` の名前の違反（api-journey-handler-naming）。行は `new XxxApi(` の行。
function findHandlerNamingViolations(code: string): ApiJourneyViolation[] {
  return [...code.matchAll(/\bnew\s+[A-Z][\w$]*Api\s*\(/g)]
    .filter((match) => {
      const name = /([A-Za-z_$][\w$]*)\s*[=:]\s*$/.exec(
        code.slice(0, match.index),
      )?.[1];
      return name === undefined || !isHandlerName(name);
    })
    .map((match) => ({
      rule: "api-journey-handler-naming",
      line: lineAt(code, match.index),
    }));
}

// 変更系の呼び出しの後に DB の読み取りが無い違反（api-journey-asserts-db-after-mutation）。行は呼び出しの名前の行。
// 呼び出しの形: `await a(`・`await a.b(`（最後の名前）・`await a.handle(` / `await x.a.handle(`（handle の前の名前）。
function findMissingDbReadViolations(code: string): ApiJourneyViolation[] {
  const mutations = [
    ...code.matchAll(/\bawait\s+((?:[\w$]+\s*\.\s*)*[\w$]+)\s*\(/g),
  ].flatMap((match) => {
    const names = (match[1] ?? "").split(".").map((name) => name.trim());
    const handlerName =
      names.at(-1) === "handle" && names.length > 1
        ? names.at(-2)
        : names.at(-1);
    return handlerName !== undefined && isMutationHandlerName(handlerName)
      ? [
          {
            index: match.index + match[0].indexOf(handlerName, "await".length),
          },
        ]
      : [];
  });
  const reads = [
    ...blankStrings(code).matchAll(/(?<![\w$])db\s*\.\s*select\s*\(/g),
  ].map((match) => match.index);
  return mutations
    .filter((mutation, i) => {
      const end = mutations[i + 1]?.index ?? code.length;
      return !reads.some((read) => read > mutation.index && read < end);
    })
    .map((mutation) => ({
      rule: "api-journey-asserts-db-after-mutation",
      line: lineAt(code, mutation.index),
    }));
}

// skip の違反（api-journey-no-skip）。rule-tests/api-spec.test.ts の findSkipViolations と同じ判定（WHY もそちら）。
function findSkipViolations(code: string): ApiJourneyViolation[] {
  return [
    ...blankStrings(code).matchAll(
      /(?<!\.)\.\s*(?:skip|only|skipIf|runIf)\b|\b(?:includeTags|excludeTags)\b/g,
    ),
  ].map((match) => ({
    rule: "api-journey-no-skip",
    line: lineAt(code, match.index),
  }));
}

// 実 Postgres のテスト用の DB を用意するモジュール（リポジトリ相対、拡張子なし）。
const TEST_DATABASE_MODULE = "apps/backend/test-support/database";

// API ジャーニー（isApiJourneyFile のファイル）の中身の違反。行のあるものを行の順に、その後にファイル全体の違反を返す。
function findApiJourneyContentViolations(
  path: string,
  source: string,
): ApiJourneyViolation[] {
  const code = stripComments(source);
  const imports = extractImports(code);
  const inMemory = imports
    .filter((ref) => /\.in-memory$/.test(moduleBaseName(ref.specifier)))
    .map(
      (ref): ApiJourneyViolation => ({
        rule: "api-journey-no-in-memory",
        line: ref.line,
      }),
    );
  const vitestImports = imports
    .filter((ref) => ref.specifier === "vitest" && reachesVi(ref))
    .map(
      (ref): ApiJourneyViolation => ({
        rule: "api-journey-no-vi",
        line: ref.line,
      }),
    );
  const valueModules = imports
    .filter((ref) => ref.kind === "value")
    .map((ref) => resolveSpecifier(path, ref.specifier));
  const apis = new Set(
    valueModules.filter(
      (module) => module !== undefined && /\.api$/.test(posix.basename(module)),
    ),
  );
  const fileLevel: ApiJourneyViolation[] = [
    ...(apis.size >= 2
      ? []
      : [{ rule: "api-journey-uses-multiple-apis" as const }]),
    ...(valueModules.includes(TEST_DATABASE_MODULE)
      ? []
      : [{ rule: "api-journey-uses-real-database" as const }]),
  ];
  const lineLevel = [
    ...inMemory,
    ...vitestImports,
    ...findHandlerNamingViolations(code),
    ...findMissingDbReadViolations(code),
    ...findSkipViolations(code),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return [...lineLevel, ...fileLevel];
}

// .feature（isFeatureFile のファイル）の中身の違反（行の順。同じ行なら tag・business-language・section-divider の順）。
// 行の読み方（行の区切り・コメント・仕切りの形・区画）は rule-tests/feature-lines.ts（E2E の e2e-feature.test.ts と共有。Issue #279）。
function findFeatureContentViolations(source: string): ApiJourneyViolation[] {
  const lines = featureLines(source);
  // 今いる区画。シナリオの中の When だけが仕切りを要る。Feature / Rule の見出しでシナリオの外に戻る。
  let section: FeatureSection = "other";
  return lines.flatMap((line, index): ApiJourneyViolation[] => {
    const lineNumber = index + 1;
    if (isSkippedLine(line)) {
      return [];
    }
    section = nextSection(line, section);
    const tag: ApiJourneyViolation[] = /^\s*@/.test(line)
      ? [{ rule: "api-journey-tag", line: lineNumber }]
      : [];
    const wording: ApiJourneyViolation[] = containsForbiddenWord(line)
      ? [{ rule: "api-journey-business-language", line: lineNumber }]
      : [];
    const divider: ApiJourneyViolation[] = lacksSectionDivider(
      lines,
      index,
      section,
    )
      ? [{ rule: "api-journey-section-divider", line: lineNumber }]
      : [];
    return [...tag, ...wording, ...divider];
  });
}

// path の違反。置き場所が違えば置き場所の違反だけを返し（中身は見ない）、API ジャーニー・.feature なら中身を見る。
//   対象外のファイルは []。
function findApiJourneyViolations(
  path: string,
  source: string,
): ApiJourneyViolation[] {
  if (isMisplacedApiJourneyFile(path)) {
    return [{ rule: "api-journey-placement" }];
  }
  if (isApiJourneyFile(path)) {
    return findApiJourneyContentViolations(path, source);
  }
  return isFeatureFile(path) ? findFeatureContentViolations(source) : [];
}

// .feature と step の対の違反（api-journey-feature-pair）。files は同じ列挙（listApiJourneyTargets）の結果。
// <name>.feature には <name>.api-journey.test.ts が、<name>.api-journey.test.ts には <name>.feature が要る。
//   どちらでもないファイル（サブディレクトリの .feature など置き場所の違反）は見ない。
function findFeaturePairViolations(
  path: string,
  files: ReadonlySet<string>,
): ApiJourneyViolation[] {
  const featureSuffix = ".feature";
  const stepsSuffix = ".api-journey.test.ts";
  const pair = isFeatureFile(path)
    ? `${path.slice(0, -featureSuffix.length)}${stepsSuffix}`
    : isApiJourneyFile(path)
      ? `${path.slice(0, -stepsSuffix.length)}${featureSuffix}`
      : undefined;
  return pair === undefined || files.has(pair)
    ? []
    : [{ rule: "api-journey-feature-pair" }];
}

// root の下の dir を再帰的にたどり、ファイルのリポジトリ相対パス（/ 区切り）を返す。
// WHY node_modules と . で始まるディレクトリ（.next など）に入らない: 依存やビルド結果は検査の対象ではなく、たどると遅い
//   （rule-tests/test-doubles.test.ts の walk と同じ）。
function walk(root: string, dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name.startsWith(".")
        ? []
        : walk(root, path);
    }
    return entry.isFile() ? [path] : [];
  });
}

// 検査の対象: apps/ の下のファイルのうち、apps/backend/spec/journey/ の下にあるものと、外に置くと違反になる名前
//   （OUTSIDE_API_JOURNEY_FILE。apps/backend/spec/api/ の下の .feature を除く）のもの。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listApiJourneyTargets(root: string): string[] {
  return walk(root, "apps")
    .filter(
      (path) =>
        path.startsWith(API_JOURNEYS_DIR) || isOutsideApiJourneyTarget(path),
    )
    .sort();
}

// 違反を「<規則>: <パス>」か「<規則>: <パス>:<行>」で返す。
function collectApiJourneyViolations(root: string): string[] {
  const paths = listApiJourneyTargets(root);
  const files = new Set(paths);
  return paths.flatMap((path) =>
    [
      ...findApiJourneyViolations(path, readFileSync(join(root, path), "utf8")),
      ...findFeaturePairViolations(path, files),
    ].map(({ rule, line }) =>
      line === undefined ? `${rule}: ${path}` : `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const API_JOURNEY = "apps/backend/spec/journey/x.api-journey.test.ts";
const FEATURE = "apps/backend/spec/journey/x.feature";
const CREATE_API = "../../features/x/internal/presentation/create-x.api";
const LIST_API = "../../features/x/internal/presentation/list-x.api";
// API ジャーニーの必須の import（実 DB と 2 つの api）。must reject の例は、これに違反を 1 つ足すか、どれかを欠く。
const DATABASE_IMPORT =
  'import { createTestDatabase } from "../../test-support/database";';
const CREATE_API_IMPORT = `import { CreateXApi } from "${CREATE_API}";`;
const LIST_API_IMPORT = `import { ListXApi } from "${LIST_API}";`;
const REQUIRED_IMPORTS = [DATABASE_IMPORT, CREATE_API_IMPORT, LIST_API_IMPORT];
// 必須の import（1〜3 行目）と、HTTP メソッドで始まる名前の handler（4〜5 行目）。変更系・DB の読み取りの例はこの後の 6 行目から書く。
const JOURNEY_HEAD = [
  ...REQUIRED_IMPORTS,
  "const postX = new CreateXApi(command).handle;",
  "const listXs = new ListXApi(query).handle;",
];
const DB_READ =
  "expect(await database.db.select().from(xs)).toStrictEqual([]);";

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "api-journey-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const feature = await loadFeature("./api-journey.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario(
    "API ジャーニーの置き場所（isMisplacedApiJourneyFile）",
    ({ And }) => {
      And(
        "spec/journey/ の直下の API ジャーニーと .feature、層の下のテストとソース、名前の一部だけが同じファイル、spec/api/ の下の .feature は違反なし",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "apps/backend/spec/journey/ の直下の *.api-journey.test.ts（step の実装）",
              API_JOURNEY,
            ],
            [
              "apps/backend/spec/journey/ の直下の *.feature（Gherkin）",
              FEATURE,
            ],
            [
              "apps/backend/ の層の下の普通のテスト",
              "apps/backend/features/x/internal/presentation/x.api.test.ts",
            ],
            [
              "apps/backend/ のソース",
              "apps/backend/features/x/internal/domain/x.ts",
            ],
            [
              "名前に journey を含むが *.journey.test.* ではないファイル",
              "apps/backend/features/journey/internal/domain/journey.test.ts",
            ],
            [
              "名前に feature を含むが .feature で終わらないファイル（spec/journey/ の外）",
              "apps/backend/features/feature/internal/domain/x.feature.ts",
            ],
            // API 仕様の .feature は api-spec.test.ts が見る（Issue #219）。
            [
              "apps/backend/spec/api/ の下の .feature（API 仕様）",
              "apps/backend/spec/api/todo/create-todo.feature",
            ],
          ];

          // when
          const result = casesByName(cases, ([, path]) =>
            isMisplacedApiJourneyFile(path),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => false));
        },
      );

      And(
        "spec/journey/ の名前の違うテスト・テスト以外・サブディレクトリの中、spec/journey/ の外のジャーニーと .feature、spec/api/ の下の API ジャーニーは違反",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "spec/journey/ の .api-journey の無いテスト",
              "apps/backend/spec/journey/x.test.ts",
            ],
            [
              "spec/journey/ の廃止した TS だけのジャーニー（*.journey.test.ts）",
              "apps/backend/spec/journey/x.journey.test.ts",
            ],
            [
              "spec/journey/ の旧名の step（*.feature.journey.test.ts）",
              "apps/backend/spec/journey/x.feature.journey.test.ts",
            ],
            [
              "spec/journey/ のテスト以外のソース",
              "apps/backend/spec/journey/helper.ts",
            ],
            ["spec/journey/ の .md", "apps/backend/spec/journey/README.md"],
            [
              "spec/journey/ のサブディレクトリの中の API ジャーニー",
              "apps/backend/spec/journey/todo/x.api-journey.test.ts",
            ],
            [
              "spec/journey/ のサブディレクトリの中の .feature",
              "apps/backend/spec/journey/todo/x.feature",
            ],
            [
              "spec/journey/ の .feature の後ろに拡張子を足したもの（.feature.md）",
              "apps/backend/spec/journey/x.feature.md",
            ],
            [
              "spec/journey/ の .features",
              "apps/backend/spec/journey/x.features",
            ],
            [
              "spec/journey/ の大文字の .FEATURE",
              "apps/backend/spec/journey/x.FEATURE",
            ],
            [
              "spec/journey/ の .tsx の API ジャーニー",
              "apps/backend/spec/journey/x.api-journey.test.tsx",
            ],
            [
              "feature の下の spec/journey/ の API ジャーニー",
              "apps/backend/features/x/spec/journey/x.api-journey.test.ts",
            ],
            [
              "apps/backend/ の直下以外の spec/journey/（shared/spec/journey/）",
              "apps/backend/shared/spec/journey/x.api-journey.test.ts",
            ],
            [
              "旧名の journeys/ の API ジャーニー",
              "apps/backend/journeys/x.api-journey.test.ts",
            ],
            [
              "旧名の journeys/ の TS だけのジャーニー",
              "apps/backend/journeys/x.journey.test.ts",
            ],
            [
              "frontend の TS だけのジャーニー",
              "apps/frontend_customer/features/x/x.journey.test.tsx",
            ],
            [
              "frontend の API ジャーニー（.js）",
              "apps/frontend_customer/features/x/x.api-journey.test.js",
            ],
            // .feature は spec/journey/ の直下にだけ置く（reviewer の指摘、Issue #200）。
            [
              "backend の feature の下の .feature",
              "apps/backend/features/x/x.feature",
            ],
            ["旧名の journeys/ の .feature", "apps/backend/journeys/x.feature"],
            // E2E の例外は apps/e2e/ の下だけ（前方一致だけの別ディレクトリは違反）。
            [
              "e2e の前方一致だけの別ディレクトリの .feature",
              "apps/e2e-x/x.feature",
            ],
            ["frontend の直下の .feature", "apps/frontend_customer/x.feature"],
            // API 仕様の例外は .feature だけ（spec/api/ の下でも API ジャーニーの名前は違反）。
            [
              "apps/backend/spec/api/ の下の API ジャーニー",
              "apps/backend/spec/api/todo/x.api-journey.test.ts",
            ],
            [
              "spec/api の前方一致だけの別ディレクトリの .feature",
              "apps/backend/spec/api-x/todo/x.feature",
            ],
          ];

          // when
          const result = casesByName(cases, ([, path]) =>
            isMisplacedApiJourneyFile(path),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => true));
        },
      );
    },
  );

  Scenario(
    "API ジャーニーの中身（findApiJourneyViolations）: must pass",
    ({ And }) => {
      And(
        "実 DB と 2 つ以上の api を値で import し、InMemory と vi を使わない API ジャーニーは違反なし（複数行・type の混じった import・別の feature の api・Postgres の Repository・コメントの中・vi 以外の vitest の import など）",
        () => {
          // given
          const cases: [string, string][] = [
            ["実 DB と 2 つの api を値で import", source(...REQUIRED_IMPORTS)],
            [
              "複数行の import・type の混じった import・@repo/backend/ の書き方",
              source(
                "import {",
                "  createTestDatabase,",
                "  type TestDatabase,",
                '} from "@repo/backend/test-support/database";',
                "import {",
                "  CreateXApi,",
                "  type CreateXResponse,",
                `} from "${CREATE_API}";`,
                'import { ListXApi } from "@repo/backend/features/x/internal/presentation/list-x.api.ts";',
              ),
            ],
            [
              "別の feature の api を 1 つずつ（feature をまたぐ流れ）",
              source(
                DATABASE_IMPORT,
                'import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
                'import { CreateYApi } from "../../features/y/internal/presentation/create-y.api";',
              ),
            ],
            [
              "Postgres の Repository・command / query を import（InMemory ではない）",
              source(
                ...REQUIRED_IMPORTS,
                'import { PostgresXRepository } from "../../features/x/internal/infra/x-repository.postgres";',
                'import { CreateXCommand } from "../../features/x/internal/application/create-x.command";',
              ),
            ],
            [
              "コメントの中の vi.mock( / vi.doMock( / InMemory の import（行コメントとブロックコメント）",
              source(
                ...REQUIRED_IMPORTS,
                '// vi.mock("@repo/shared/now") は使わない。',
                '/* vi.doMock("./x"); import { InMemoryXRepository } from "../../features/x/internal/infra/x-repository.in-memory"; */',
                '// import { vi } from "vitest";',
                'const url = "http://localhost"; // import "../../features/x/internal/infra/x-repository.in-memory";',
              ),
            ],
            [
              "vitest から vi 以外（afterAll・expect・test）と、型だけ（import type・inline の type）を import",
              source(
                ...REQUIRED_IMPORTS,
                'import { afterAll, beforeAll, expect, test } from "vitest";',
                'import type { Mock } from "vitest";',
                'import type * as V from "vitest";',
                'import { type MockInstance, describe, type vi } from "vitest";',
              ),
            ],
            [
              "変更系の後ごとに db.select(（GET の後は無くてよい。複数行のメソッドチェーン・同じ行・.handle 経由も可）",
              source(
                ...JOURNEY_HEAD,
                "const getX = new GetXApi(query).handle;",
                "await postX(request);",
                DB_READ,
                "await listXs(request);",
                "await getX(request);",
                "await postX.handle(request); const rows = await database.db",
                "  .select()",
                "  .from(xs);",
                "await getX(request);",
              ),
            ],
            [
              "handler の名前が HTTP メソッド（get・list・post・put・patch・delete）で始まる（大文字小文字を区別しない・オブジェクトのキー・複数行）",
              source(
                ...REQUIRED_IMPORTS,
                "const PostX = new CreateXApi(command).handle;",
                "let getX;",
                "getX = new GetXApi(query);",
                "const handlers = {",
                "  listXs: new ListXApi(query).handle,",
                "  putName: new RenameXApi(command).handle,",
                "  PATCHX: new PatchXApi(command).handle,",
                "  deleteX: new DeleteXApi(command).handle,",
                "};",
                "const getY =",
                "  new GetYApi(query).handle;",
                "const repository = new PostgresXRepository(database.db);",
                "const client = new XApiClient();",
              ),
            ],
            [
              "名前の一部だけが in-memory のモジュール（in-memory-x・x.in-memory-y）",
              source(
                ...REQUIRED_IMPORTS,
                'import { a } from "./in-memory-x";',
                'import { b } from "./x.in-memory-y";',
              ),
            ],
          ];

          // when
          const result = casesByName(cases, ([, text]) =>
            findApiJourneyViolations(API_JOURNEY, text),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => []));
        },
      );

      And(
        "API ジャーニーでないファイル（層の下のテスト）は中身を見ない",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const violations = findApiJourneyViolations(
            "apps/backend/features/x/internal/presentation/x.api.test.ts",
            source(
              'import { vi } from "vitest";',
              "const renameX = new RenameXApi(command).handle;",
            ),
          );

          // then
          expect(violations).toEqual([]);
        },
      );
    },
  );

  Scenario(
    "API ジャーニーの中身（findApiJourneyViolations）: must reject",
    ({ And }) => {
      And(
        "InMemory の import・vi の import・実 DB や 2 つ以上の api の欠け・変更系の API の後に DB を読まないことは、規則と行で違反になる",
        () => {
          // given
          const cases: [string, string, ApiJourneyViolation[]][] = [
            [
              "InMemory の Repository を値で import",
              source(
                ...REQUIRED_IMPORTS,
                'import { InMemoryXRepository } from "../../features/x/internal/infra/x-repository.in-memory";',
              ),
              [{ rule: "api-journey-no-in-memory", line: 4 }],
            ],
            [
              "InMemory を import type で（型だけでも違反）",
              source(
                ...REQUIRED_IMPORTS,
                'import type { InMemoryXRepository } from "../../features/x/internal/infra/x-repository.in-memory";',
              ),
              [{ rule: "api-journey-no-in-memory", line: 4 }],
            ],
            [
              "InMemory を inline の type・拡張子付き・@repo/backend/ で",
              source(
                ...REQUIRED_IMPORTS,
                'import { type InMemoryXRepository } from "@repo/backend/features/x/internal/infra/x-repository.in-memory.ts";',
              ),
              [{ rule: "api-journey-no-in-memory", line: 4 }],
            ],
            [
              "InMemory を dynamic import()・副作用の import・export … from（複数行）",
              source(
                ...REQUIRED_IMPORTS,
                'const m = await import("../../features/x/internal/infra/x-repository.in-memory");',
                'import "../../features/x/internal/infra/x-repository.in-memory";',
                "export {",
                "  InMemoryXRepository,",
                '} from "../../features/x/internal/infra/x-repository.in-memory";',
              ),
              [
                { rule: "api-journey-no-in-memory", line: 4 },
                { rule: "api-journey-no-in-memory", line: 5 },
                { rule: "api-journey-no-in-memory", line: 8 },
              ],
            ],
            [
              "vitest から vi を import（vi.mock・vi.spyOn(...).mockResolvedValue・vi.fn も。使い方によらず import で止める）",
              source(
                ...REQUIRED_IMPORTS,
                'import { expect, vi } from "vitest";',
                'vi.mock("@repo/shared/now", { spy: true });',
                'vi.spyOn(console, "error").mockResolvedValue(undefined);',
                "const f = vi.fn();",
              ),
              [{ rule: "api-journey-no-vi", line: 4 }],
            ],
            [
              "vi の別名（vi as v）と vitest（vi と同じもの）を複数行の import で（行は参照先の行）",
              source(
                ...REQUIRED_IMPORTS,
                "import {",
                "  expect,",
                "  vi as v,",
                "  vitest,",
                "} from 'vitest';",
                "v.useFakeTimers();",
                "vitest.setSystemTime(0);",
              ),
              [{ rule: "api-journey-no-vi", line: 8 }],
            ],
            [
              "vi と同じものの別名 vitest を単独で import（vitest.spyOn などが使える）",
              source(
                ...REQUIRED_IMPORTS,
                'import { vitest } from "vitest";',
                'vitest.spyOn(console, "error");',
              ),
              [{ rule: "api-journey-no-vi", line: 4 }],
            ],
            [
              "vitest の名前空間・既定の import（名前空間経由で vi に届く）",
              source(
                ...REQUIRED_IMPORTS,
                'import * as vt from "vitest";',
                'vt.vi.stubGlobal("fetch", undefined);',
                'import V, { expect } from "vitest";',
              ),
              [
                { rule: "api-journey-no-vi", line: 4 },
                { rule: "api-journey-no-vi", line: 6 },
              ],
            ],
            [
              'dynamic import("vitest")（vi?.mock も）',
              source(
                ...REQUIRED_IMPORTS,
                'const { vi } = await import("vitest");',
                'vi?.mock("./x");',
              ),
              [{ rule: "api-journey-no-vi", line: 4 }],
            ],
            [
              "handler の名前が HTTP メソッドで始まらない（改名・作成の名前、オブジェクトのキー、読み取りも、名前の無い new XxxApi(）",
              source(
                ...REQUIRED_IMPORTS,
                "const renameX = new RenameXApi(command).handle;",
                "const handlers = { createX: new CreateXApi(command).handle };",
                "const api = new ListXApi(query);",
                "await new CreateXApi(command).handle(request);",
                "const fetchX =",
                "  new GetXApi(query).handle;",
                "const completeX = new CompleteXApi (command).handle;",
              ),
              [
                { rule: "api-journey-handler-naming", line: 4 },
                { rule: "api-journey-handler-naming", line: 5 },
                { rule: "api-journey-handler-naming", line: 6 },
                { rule: "api-journey-handler-naming", line: 7 },
                { rule: "api-journey-handler-naming", line: 9 },
                { rule: "api-journey-handler-naming", line: 10 },
              ],
            ],
            [
              "変更系が 2 回続き、db.select( がその後に 1 回だけ（1 回目の後に無い）",
              source(
                ...JOURNEY_HEAD,
                "await postX(request);",
                "await postX(request);",
                DB_READ,
              ),
              [{ rule: "api-journey-asserts-db-after-mutation", line: 6 }],
            ],
            [
              "末尾の変更系の後に db.select( が無い（GET の後にも無い）",
              source(
                ...JOURNEY_HEAD,
                "await postX(request);",
                DB_READ,
                "await postX(request);",
                "await listXs(request);",
              ),
              [{ rule: "api-journey-asserts-db-after-mutation", line: 8 }],
            ],
            [
              "db.select( が変更系より前にだけある",
              source(...JOURNEY_HEAD, DB_READ, "await postX(request);"),
              [{ rule: "api-journey-asserts-db-after-mutation", line: 7 }],
            ],
            [
              ".select( だけ（db. でない・名前の一部が db）",
              source(
                ...JOURNEY_HEAD,
                "await postX(request);",
                "await repository.select();",
                "await tx.select().from(xs);",
                "await mydb.select().from(xs);",
              ),
              [{ rule: "api-journey-asserts-db-after-mutation", line: 6 }],
            ],
            [
              "コメント・文字列の中の db.select(",
              source(
                ...JOURNEY_HEAD,
                "await postX(request); // database.db.select().from(xs)",
                "/* database.db.select() */",
                'const s = "database.db.select()";',
                "const t = `db.select(`;",
              ),
              [{ rule: "api-journey-asserts-db-after-mutation", line: 6 }],
            ],
            [
              "put・patch・delete も変更系（大文字小文字を区別しない・オブジェクトのメンバー・.handle 経由・複数行の引数の中）",
              source(
                ...REQUIRED_IMPORTS,
                "const handlers = {",
                "  PutName: new RenameXApi(command),",
                "  patchX: new PatchXApi(command).handle,",
                "  DELETEX: new DeleteXApi(command).handle,",
                "};",
                "await handlers.PutName.handle(request);",
                "await handlers.patchX(request);",
                "await expectProblem(",
                "  await handlers.DELETEX(request),",
                "  problem,",
                ");",
              ),
              [
                { rule: "api-journey-asserts-db-after-mutation", line: 9 },
                { rule: "api-journey-asserts-db-after-mutation", line: 10 },
                { rule: "api-journey-asserts-db-after-mutation", line: 12 },
              ],
            ],
            [
              "api を 1 つだけ import",
              source(DATABASE_IMPORT, CREATE_API_IMPORT),
              [{ rule: "api-journey-uses-multiple-apis" }],
            ],
            [
              "同じ api を書き方を変えて 2 回（相対・拡張子付き・@repo/backend/）",
              source(
                DATABASE_IMPORT,
                `import { CreateXApi } from "${CREATE_API}";`,
                `import { CreateXApi as ApiWithExtension } from "${CREATE_API}.ts";`,
                'import { CreateXApi as Api } from "@repo/backend/features/x/internal/presentation/create-x.api";',
              ),
              [{ rule: "api-journey-uses-multiple-apis" }],
            ],
            [
              "2 つ目の api が import type・inline の type だけ",
              source(
                DATABASE_IMPORT,
                CREATE_API_IMPORT,
                `import type { ListXResponse } from "${LIST_API}";`,
                'import { type GetXResponse } from "../../features/x/internal/presentation/get-x.api";',
              ),
              [{ rule: "api-journey-uses-multiple-apis" }],
            ],
            [
              "2 つ目の api が副作用の import・dynamic import()・export … from",
              source(
                DATABASE_IMPORT,
                CREATE_API_IMPORT,
                `import "${LIST_API}";`,
                `const m = await import("${LIST_API}");`,
                `export { ListXApi } from "${LIST_API}";`,
              ),
              [{ rule: "api-journey-uses-multiple-apis" }],
            ],
            [
              "api の単体テストや名前の一部だけが api のモジュール（x.api.test・x.api-helper・api）",
              source(
                DATABASE_IMPORT,
                CREATE_API_IMPORT,
                'import { a } from "../../features/x/internal/presentation/list-x.api.test";',
                'import { b } from "../../features/x/internal/presentation/x.api-helper";',
                'import { c } from "../../features/x/internal/presentation/api";',
              ),
              [{ rule: "api-journey-uses-multiple-apis" }],
            ],
            [
              "api をコメントの中でだけ import",
              source(
                DATABASE_IMPORT,
                CREATE_API_IMPORT,
                `// import { ListXApi } from "${LIST_API}";`,
              ),
              [{ rule: "api-journey-uses-multiple-apis" }],
            ],
            [
              "test-support/database を import しない",
              source(CREATE_API_IMPORT, LIST_API_IMPORT),
              [{ rule: "api-journey-uses-real-database" }],
            ],
            [
              "test-support/database を import type だけ",
              source(
                'import type { TestDatabase } from "../../test-support/database";',
                CREATE_API_IMPORT,
                LIST_API_IMPORT,
              ),
              [{ rule: "api-journey-uses-real-database" }],
            ],
            [
              "名前・場所の一部だけが同じ別のモジュール（shared/infra/database・database-x・別の場所の test-support/database）",
              source(
                'import { AppDatabase } from "../../shared/infra/database";',
                'import { a } from "../../test-support/database-x";',
                'import { b } from "./test-support/database";',
                CREATE_API_IMPORT,
                LIST_API_IMPORT,
              ),
              [{ rule: "api-journey-uses-real-database" }],
            ],
            [
              "空のファイル（すべての必須を欠く）",
              "",
              [
                { rule: "api-journey-uses-multiple-apis" },
                { rule: "api-journey-uses-real-database" },
              ],
            ],
            [
              "違反が重なる（行のある違反を行の順に、その後にファイル全体の違反）",
              source(
                'import { vi } from "vitest";',
                'import { InMemoryXRepository } from "../../features/x/internal/infra/x-repository.in-memory";',
                CREATE_API_IMPORT,
                "const createX = new CreateXApi(command).handle;",
                "await createX(request);",
                "const postX = new CreateXApi(command).handle;",
                "await postX(request);",
              ),
              [
                { rule: "api-journey-no-vi", line: 1 },
                { rule: "api-journey-no-in-memory", line: 2 },
                { rule: "api-journey-handler-naming", line: 4 },
                { rule: "api-journey-asserts-db-after-mutation", line: 7 },
                { rule: "api-journey-uses-multiple-apis" },
                { rule: "api-journey-uses-real-database" },
              ],
            ],
          ];

          // when
          const result = casesByName(cases, ([, text]) =>
            findApiJourneyViolations(API_JOURNEY, text),
          );

          // then
          expect(result).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );

      And("置き場所が違えば置き場所の違反だけを返す（中身は見ない）", () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const violations = findApiJourneyViolations(
          "apps/backend/spec/journey/x.test.ts",
          'import { vi } from "vitest";',
        );

        // then
        expect(violations).toEqual([{ rule: "api-journey-placement" }]);
      });
    },
  );

  Scenario(
    "Gherkin の .feature と step の対（findFeaturePairViolations）",
    ({ And }) => {
      // files: 同じディレクトリにあるファイルの一覧（listApiJourneyTargets の結果に当たる）。
      And(
        ".feature と同じ名前の step があるもの・対象外のファイルは違反なし",
        () => {
          // given
          const cases: [string, string, string[]][] = [
            [
              ".feature と同じ名前の step（.api-journey.test.ts）がある",
              FEATURE,
              [FEATURE, API_JOURNEY],
            ],
            [
              ".api-journey.test.ts と同じ名前の .feature がある",
              API_JOURNEY,
              [FEATURE, API_JOURNEY],
            ],
            [
              "対象外のファイル（置き場所の違反は api-journey-placement が見る）",
              "apps/backend/spec/journey/nested/x.feature",
              ["apps/backend/spec/journey/nested/x.feature"],
            ],
          ];

          // when
          const result = casesByName(cases, ([, path, files]) =>
            findFeaturePairViolations(path, new Set(files)),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => []));
        },
      );

      And(
        ".feature か step の片方だけ・名前の違い・旧名の step・サブディレクトリの対は違反",
        () => {
          // given
          const cases: [string, string, string[]][] = [
            [".feature だけで step が無い", FEATURE, [FEATURE]],
            [
              ".api-journey.test.ts だけで .feature が無い（TS だけのジャーニーは廃止）",
              API_JOURNEY,
              [API_JOURNEY],
            ],
            [
              ".feature の名前と step の名前が違う（.feature 側）",
              FEATURE,
              [FEATURE, "apps/backend/spec/journey/y.api-journey.test.ts"],
            ],
            [
              ".feature の名前と step の名前が違う（step 側）",
              API_JOURNEY,
              ["apps/backend/spec/journey/y.feature", API_JOURNEY],
            ],
            [
              "step が旧名（x.feature.journey.test.ts・x.journey.test.ts）",
              FEATURE,
              [
                FEATURE,
                "apps/backend/spec/journey/x.feature.journey.test.ts",
                "apps/backend/spec/journey/x.journey.test.ts",
              ],
            ],
            [
              "対の .feature がサブディレクトリにある",
              API_JOURNEY,
              ["apps/backend/spec/journey/nested/x.feature", API_JOURNEY],
            ],
          ];

          // when
          const result = casesByName(cases, ([, path, files]) => {
            const existing = new Set(files);
            return findFeaturePairViolations(path, existing);
          });

          // then
          expect(result).toEqual(
            casesByName(cases, () => [{ rule: "api-journey-feature-pair" }]),
          );
        },
      );
    },
  );

  // .feature の例の部品。仕切り（api-journey-section-divider の形）と、業務の言葉だけの Background。
  const DIVIDER = "    # ───── Todo を作る ─────";
  const FEATURE_HEAD = [
    "Feature: Todo のライフサイクル",
    "",
    "  Background: 空の Todo 一覧",
    "    Given Todo が 1 件も無い",
    "",
    "  Scenario: 作成から削除まで",
  ];

  Scenario(
    ".feature の業務の言葉と仕切り（findApiJourneyViolations）: must pass",
    ({ And }) => {
      And(
        "業務の言葉だけで、API を呼ぶ step の直前ごとに仕切りのある .feature は違反なし（コメント行と空行・語の一部・仕切りの後の空行とコメントなど）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "業務の言葉だけで、API を呼ぶ step（When）の直前ごとに仕切りがある",
              source(
                ...FEATURE_HEAD,
                DIVIDER,
                '    When Todo "牛乳を買う" を作る',
                '    Then 未完了の Todo "牛乳を買う" が作られる',
                '    And Todo は "牛乳を買う" の 1 件だけになる',
                "    # ───── 一覧を見る ─────",
                "    When Todo の一覧を見る",
                "    Then 一覧に 1 件が並ぶ",
                "",
                "  Scenario: 不正な入力は保存されない",
                '    Given Todo "牛乳を買う" が作られている',
                "    # ───── 空のタイトルで Todo を作る ─────",
                "    When タイトルが空の Todo を作る",
                "    Then タイトルが空という理由で拒否される",
              ),
            ],
            [
              "# のコメント行（字下げも）と空行は禁止語があっても見ない",
              source(
                "# step の実装は DB の todos を SQL で読み、状態 201 と Problem Details の JSON を確かめる。",
                ...FEATURE_HEAD,
                "      # API の返り値の id・title・completed は step の実装が見る（not found・uuid・null・undefined）。",
                "",
                DIVIDER,
                '    When Todo "牛乳を買う" を作る',
              ),
            ],
            [
              "3 桁の数の後ろが「文字」「件」「行」（空白の有無によらない）・3 桁でない数・1xx〜5xx でない 3 桁の数",
              source(
                ...FEATURE_HEAD,
                DIVIDER,
                '    When 100 文字のタイトルの Todo "牛乳を買う" を作る',
                "    Then 200件が並ぶ",
                "    And メモは 300 行まで書ける",
                "    And 2 件目・10 件目・1000 円・600 円・099 番は業務の数",
              ),
            ],
            [
              "禁止語を語の一部に含むだけの言葉（Todo・MongoDB・idea・subtitle・APIs でない API 風の語・completely）",
              source(
                ...FEATURE_HEAD,
                DIVIDER,
                '    When Todo "idea を MongoDB に書く subtitle" を作る',
                "    Then completely な Todo と APIary の Todo が並ぶ",
              ),
            ],
            [
              "Background の中の When（仕切りは要らない）・When 以外の step（Given / Then / And / But / *）",
              source(
                "Feature: x",
                "  Background: y",
                "    When Todo を 1 件も持たない",
                "  Scenario: z",
                "    Given Todo が 1 件ある",
                "    Then 1 件が並ぶ",
                "    And 1 件目が見える",
                "    But 2 件目は見えない",
                "    * 何もしない",
              ),
            ],
            [
              "仕切りの字下げが When と違う・見出しの中に空白や ─ がある（Scenario Outline・Example・Rule の中でも）",
              source(
                "Feature: x",
                "  Rule: r",
                "    Scenario Outline: y",
                "# ───── Todo を作る ─────",
                '      When Todo "牛乳を買う" を作る',
                "    Example: z",
                "        # ───── 一覧 を 見る（─ の入った見出し） ─────",
                "    When Todo の一覧を見る",
              ),
            ],
            ["When の無い .feature（Feature だけ）", "Feature: x\n"],
            [
              "改行が CRLF（Windows の改行。仕切りの行末の \\r を形の違いにしない）",
              [
                ...FEATURE_HEAD,
                DIVIDER,
                '    When Todo "牛乳を買う" を作る',
                '    Then 未完了の Todo "牛乳を買う" が作られる',
                "",
              ].join("\r\n"),
            ],
          ];

          // when
          const result = casesByName(cases, ([, text]) =>
            findApiJourneyViolations(FEATURE, text),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => []));
        },
      );

      And(
        "spec/journey/ の外の .feature は置き場所の違反だけを返す（中身は見ない）",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const violations = findApiJourneyViolations(
            "apps/frontend_customer/x.feature",
            source("Feature: DB", "  Scenario: y", "    When 状態 201 を返す"),
          );

          // then
          expect(violations).toEqual([{ rule: "api-journey-placement" }]);
        },
      );
    },
  );

  Scenario(
    ".feature の業務の言葉（api-journey-business-language）: must reject",
    ({ And }) => {
      // 禁止語を 1 つだけ含む step（When の直前には仕切りを置き、仕切りの違反と混ざらないようにする）。行は 9 行目の Then。
      And(
        "step（Then）に DB・SQL・表名・API や HTTP の言葉（返り値・状態コード・Problem Details・JSON など）があれば違反",
        () => {
          // given
          const cases: [string, string][] = [
            ["DB（語の境界）", "Then DB の Todo は 1 件になる"],
            [
              "DB の大文字小文字違い（Db・db）",
              "Then Db と db の Todo は 1 件になる",
            ],
            ["データベース", "Then データベースに 1 件ある"],
            ["SQL（PostgreSQL の中も）", "Then PostgreSQL に 1 件ある"],
            ["テーブル", "Then テーブルに 1 件ある"],
            ["カラム", "Then カラムが 1 つ変わる"],
            ["返り値", "Then 返り値は Todo になる"],
            ["戻り値", "Then 戻り値は Todo になる"],
            ["レスポンス", "Then レスポンスに Todo がある"],
            ["ステータス", "Then ステータスは成功になる"],
            ["状態 \\d{3}（空白なし）", "Then 状態201 で作られる"],
            ["HTTP の状態コード（3 桁の 1xx〜5xx）", "Then 201 で作られる"],
            [
              "HTTP の状態コード（行末・後ろが「文字」「件」「行」以外）",
              "Then 作られた Todo が 404",
            ],
            [
              "Problem Details（空白なし・大文字小文字違い）",
              "Then problemdetails が届く",
            ],
            ["JSON", "Then Json の Todo が届く"],
            ["null", "Then 期限は NULL になる"],
            ["undefined", "Then 期限は undefined になる"],
            ["insert", "Then Todo の Insert が 1 件になる"],
            ["update", "Then Todo の update が 1 件になる"],
            ["delete", "Then Todo の delete が 1 件になる"],
            ["表名 todos", "Then todos は 1 件になる"],
            [
              "表名 todo_status_changes",
              "Then todo_status_changes は 1 件になる",
            ],
            ["表名 change_logs", "Then change_logs は 2 件になる"],
            [
              "change log（空白区切り・単数形）",
              "Then Change log が 1 件足される",
            ],
            [
              "変更の記録（Writer が自動で残す技術の仕組み）",
              "Then 変更の記録が 1 件足される",
            ],
            ["変更履歴", "Then 変更履歴は 2 件になる"],
            ["id", "Then その ID の Todo は無い"],
            ["uuid", "Then UUID の Todo は無い"],
            ["not found（空白なし）", "Then NotFound と伝えられる"],
            ["title（業務の言葉はタイトル）", "Then Title が空と伝えられる"],
            ["completed", "Then completed が真になる"],
            ["API", "Then Api が Todo を返す"],
            ["HTTP（HTTPS も）", "Then HTTPS で Todo が届く"],
            ["HTTP のメソッド（GET）", "Then get で Todo を読む"],
            [
              "HTTP のメソッド（POST・PUT・PATCH）",
              "Then Post と Put と Patch で送る",
            ],
            ["エンドポイント", "Then エンドポイントが Todo を返す"],
            ["リクエスト", "Then リクエストが拒否される"],
            ["レコード", "Then レコードが 1 件ある"],
            ["バリデーション", "Then バリデーションで拒否される"],
            ["状態コード", "Then 状態コードで成功が分かる"],
            [
              "not found（- 区切り。/problems/not-found）",
              "Then /problems/not-found と伝えられる",
            ],
            ["not found（_ 区切り）", "Then not_found と伝えられる"],
            ["Problem Details（- 区切り）", "Then problem-details が届く"],
            ["Problem Details（_ 区切り）", "Then problem_details が届く"],
          ];

          // when
          const result = casesByName(cases, ([, step]) =>
            findApiJourneyViolations(
              FEATURE,
              source(
                ...FEATURE_HEAD,
                DIVIDER,
                "    When Todo を作る",
                `    ${step}`,
              ),
            ),
          );

          // then
          expect(result).toEqual(
            casesByName(cases, () => [
              { rule: "api-journey-business-language", line: 9 },
            ]),
          );
        },
      );

      And(
        "見出し（Feature / Background / Scenario / Rule / Scenario Outline / Example）と各 step（Given / When / And / But / 星印）・説明の行・表の行も見る（1 行 1 件、行番号付き）",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const violations = findApiJourneyViolations(
            FEATURE,
            source(
              "Feature: Todo の API",
              "  Todo の DB を説明する行",
              "  Background: 空の todos",
              "    Given DB が空",
              "  Rule: 状態 404 の扱い",
              "  Scenario: 作成の JSON",
              "    # ───── Todo を作る ─────",
              "    When POST で Todo を作る",
              "    And Todo の id を控える",
              "    But title は空でない",
              "    * uuid が振られる",
              "      | id | title |",
              "  Scenario Outline: 改名の update",
              "  Example: 削除の delete",
            ),
          );

          // then
          expect(violations).toEqual(
            [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14].map((line) => ({
              rule: "api-journey-business-language",
              line,
            })),
          );
        },
      );

      // 仕切りは `#` で始まるが、読者が拾い読みする見出しなので禁止語を見る（reviewer の指摘、Issue #217）。
      //   仕切りの形は正しいので、仕切りの違反（section-divider）は出さない。
      And("仕切りの見出しに禁止語があれば、仕切りの行を違反にする", () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const violations = findApiJourneyViolations(
          FEATURE,
          source(
            ...FEATURE_HEAD,
            "    # ───── POST /api/todos で DB に insert ─────",
            "    When Todo を作る",
            "    Then 1 件になる",
            "    # ───── Db を見る ─────",
            "    When Todo の一覧を見る",
          ),
        );

        // then
        expect(violations).toEqual([
          { rule: "api-journey-business-language", line: 7 },
          { rule: "api-journey-business-language", line: 10 },
        ]);
      });

      And(
        "禁止語と仕切りの違反が同じ When の行にあれば、両方を行の順に返す",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const violations = findApiJourneyViolations(
            FEATURE,
            source(...FEATURE_HEAD, "    When DB に Todo を入れる"),
          );

          // then
          expect(violations).toEqual([
            { rule: "api-journey-business-language", line: 7 },
            { rule: "api-journey-section-divider", line: 7 },
          ]);
        },
      );
    },
  );

  Scenario(
    ".feature の仕切り（api-journey-section-divider）: must reject",
    ({ And }) => {
      // 7 行目に仕切りの候補（または別の行）、8 行目に When を置く。違反の行は When の行（8 行目）。
      And(
        "When の直前の行が仕切りの形でなければ違反（仕切りが無い・普通のコメント・罫線の数・見出しの空・空白の数・罫線の文字・後ろの文字・別のコメントの書き方）",
        () => {
          // given
          const cases: [string, string][] = [
            ["直前が Then（仕切りが無い）", "    Then 1 件になる"],
            ["直前が普通のコメント", "    # Todo を作る"],
            ["─ が 4 つ（左）", "    # ──── Todo を作る ─────"],
            ["─ が 6 つ（左）", "    # ────── Todo を作る ─────"],
            ["─ が 4 つ（右）", "    # ───── Todo を作る ────"],
            ["─ が 6 つ（右）", "    # ───── Todo を作る ──────"],
            ["見出しが空（空白 1 つ）", "    # ───── ─────"],
            ["見出しが空白だけ", "    # ─────   ─────"],
            ["# の後に空白が無い", "    #───── Todo を作る ─────"],
            ["# の後の空白が 2 つ", "    #  ───── Todo を作る ─────"],
            ["─ と見出しの間に空白が無い", "    # ─────Todo を作る─────"],
            ["─ と見出しの間の空白が 2 つ", "    # ─────  Todo を作る  ─────"],
            ["─ でなく - を使う", "    # ----- Todo を作る -----"],
            ["─ でなく太い ━ を使う", "    # ━━━━━ Todo を作る ━━━━━"],
            ["右の ─ の後ろに文字がある", "    # ───── Todo を作る ───── 作成"],
            ["右の ─ の後ろに空白がある", "    # ───── Todo を作る ───── "],
            ["# でなく // のコメント風", "    // ───── Todo を作る ─────"],
          ];

          // when
          const result = casesByName(cases, ([, previous]) =>
            findApiJourneyViolations(
              FEATURE,
              source(...FEATURE_HEAD, previous, "    When Todo を作る"),
            ),
          );

          // then
          expect(result).toEqual(
            casesByName(cases, () => [
              { rule: "api-journey-section-divider", line: 8 },
            ]),
          );
        },
      );

      And(
        "仕切りと When の間に空行・コメント行がある、シナリオの見出しの直後の When、Background の後・2 つ目のシナリオ・Rule の中の When も見る",
        () => {
          // given: 前提なし（入力は when の呼び出しに直接書く）
          // when
          const violations = findApiJourneyViolations(
            FEATURE,
            source(
              ...FEATURE_HEAD,
              DIVIDER,
              "",
              "    When Todo を作る",
              DIVIDER,
              "    # 作る",
              "    When Todo を作る",
              "  Scenario: 2 つ目",
              "    When Todo を作る",
              "  Rule: r",
              "  Background: b",
              "    When Todo を持たない",
              "  Example: e",
              DIVIDER,
              "    When Todo を作る",
              "    When 続けて Todo を作る",
            ),
          );

          // then
          expect(violations).toEqual([
            { rule: "api-journey-section-divider", line: 9 },
            { rule: "api-journey-section-divider", line: 12 },
            { rule: "api-journey-section-divider", line: 14 },
            { rule: "api-journey-section-divider", line: 21 },
          ]);
        },
      );
    },
  );

  Scenario(
    "タグ・skip・行の区切り（api-journey-tag / api-journey-no-skip。Issue #219 の reviewer の指摘）",
    ({ And }) => {
      And(
        "行の途中の @・単独の CR の改行・コメントや文字列の中の skip と only・名前の一部は違反なし",
        () => {
          // given
          const cases: [string, string, string][] = [
            [
              ".feature の改行が CR だけ（単独の \\r も行の区切り）",
              FEATURE,
              [
                ...FEATURE_HEAD,
                DIVIDER,
                '    When Todo "牛乳を買う" を作る',
              ].join("\r"),
            ],
            [
              ".feature の行の途中の @",
              FEATURE,
              source(
                ...FEATURE_HEAD,
                DIVIDER,
                "    When 宛先の @ の後ろに Todo を作る",
              ),
            ],
            [
              "step のコメント・文字列の中の .skip( / .only(・スプレッド（...only）・名前の一部（skipped・.skipper）",
              API_JOURNEY,
              source(
                ...JOURNEY_HEAD,
                '// Scenario.skip("a", () => {});',
                'const note = "Scenario.only( と excludeTags は使わない";',
                "const skipped = { ...only, ...todo, s: list.skipper() };",
              ),
            ],
          ];

          // when
          const result = casesByName(cases, ([, path, text]) =>
            findApiJourneyViolations(path, text),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => []));
        },
      );

      And(
        ".feature のタグの行と、step の skip・only・skipIf・runIf は、規則と行で違反になる（単独の CR で区切った行も 1 行ずつ見る）",
        () => {
          // given
          const cases: [string, string, string, ApiJourneyViolation[]][] = [
            [
              ".feature の単独の CR で区切った行も 1 行ずつ見る",
              FEATURE,
              ["Feature: x", "  Scenario: y", "    When 状態 201 を返す"].join(
                "\r",
              ),
              [
                { rule: "api-journey-business-language", line: 3 },
                { rule: "api-journey-section-divider", line: 3 },
              ],
            ],
            [
              ".feature の @ のタグの行（@ignore・字下げ・複数のタグ・Feature の前）",
              FEATURE,
              source(
                "@ignore",
                "Feature: x",
                "  @skip @wip",
                "  Scenario: y",
                "    Given Todo が 1 件ある",
              ),
              [
                { rule: "api-journey-tag", line: 1 },
                { rule: "api-journey-tag", line: 3 },
              ],
            ],
            [
              "step の skip・only・skipIf・runIf（Scenario・Background・describeFeature・it・空白・?.）とタグの絞り込み",
              API_JOURNEY,
              source(
                ...JOURNEY_HEAD,
                'Scenario.skip("a", () => {});',
                'Scenario.only("a", () => {});',
                "Background . skip(() => {});",
                "describeFeature.skip(feature, () => {});",
                'it.skipIf(true)("a", () => {});',
                'it.runIf(false)("a", () => {});',
                'Scenario?.skip("a", () => {});',
                'describeFeature(feature, () => {}, { excludeTags: ["x"] });',
                'describeFeature(feature, () => {}, { includeTags: ["x"] });',
              ),
              [6, 7, 8, 9, 10, 11, 12, 13, 14].map((line) => ({
                rule: "api-journey-no-skip",
                line,
              })),
            ],
          ];

          // when
          const result = casesByName(cases, ([, path, text]) =>
            findApiJourneyViolations(path, text),
          );

          // then
          expect(result).toEqual(
            casesByName(cases, ([, , , expected]) => expected),
          );
        },
      );
    },
  );

  // --- 列挙 → 読み取り → 判定を通した fixture テスト ---
  // WHY: 判定が正しくても、対象の列挙（spec/journey/ の下と、外に置くと違反になる名前の見つけ方）が漏れれば見逃す。一時ディレクトリに
  //   架空のツリーを置き、本番と同じ collectApiJourneyViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
  Scenario("API ジャーニーの列挙と検査（fixture）", ({ And }) => {
    And(
      "spec/journey/ の下と、外に置くと違反になる名前（.api-journey.test.・.journey.test. を含む名前と .feature）を対象にし、違反を「規則: パス(:行)」で返す",
      () => {
        // given
        const root = fixture({
          // 対になった .feature と step（違反なし）。
          [FEATURE]: "Feature: x\n",
          [API_JOURNEY]: source(...REQUIRED_IMPORTS),
          // 対になっているが、中身の規則に違反する step。
          "apps/backend/spec/journey/mock.feature": "Feature: mock\n",
          "apps/backend/spec/journey/mock.api-journey.test.ts": source(
            ...REQUIRED_IMPORTS,
            'import { vi } from "vitest";',
            'vi.mock("@repo/shared/now");',
            'Scenario.only("a", () => {});',
          ),
          "apps/backend/spec/journey/no-db-check.feature":
            "Feature: no-check\n",
          "apps/backend/spec/journey/no-db-check.api-journey.test.ts": source(
            ...JOURNEY_HEAD,
            "const renameX = new RenameXApi(command).handle;",
            "await postX(request);",
            DB_READ,
            "await renameX(request);",
            "await postX(request);",
          ),
          "apps/backend/spec/journey/single-api.feature": "Feature: single\n",
          // 対になっているが、.feature が業務の言葉と仕切りの規則に違反する（step の実装は違反なし）。
          "apps/backend/spec/journey/wording.feature": source(
            "Feature: wording",
            "  Scenario: w",
            "    # ───── Todo を作る ─────",
            "    When Todo を作る",
            "    Then 状態 201 で返る",
            "    When Todo の一覧を見る",
            "  @ignore",
          ),
          "apps/backend/spec/journey/wording.api-journey.test.ts": source(
            ...REQUIRED_IMPORTS,
          ),
          "apps/backend/spec/journey/single-api.api-journey.test.ts": source(
            DATABASE_IMPORT,
            CREATE_API_IMPORT,
            'import { InMemoryXRepository } from "../../features/x/internal/infra/x-repository.in-memory";',
          ),
          // 置き場所の違反: 名前に .api-journey の無いテスト、補助の .ts、廃止した TS だけのジャーニー。
          "apps/backend/spec/journey/x.test.ts": source(...REQUIRED_IMPORTS),
          "apps/backend/spec/journey/helper.ts": "export const a = 1;\n",
          "apps/backend/spec/journey/old.journey.test.ts": source(
            ...REQUIRED_IMPORTS,
          ),
          // 対の違反: 片方だけ、名前の違う対。
          "apps/backend/spec/journey/only-feature.feature": "Feature: y\n",
          "apps/backend/spec/journey/only-steps.api-journey.test.ts": source(
            ...REQUIRED_IMPORTS,
          ),
          "apps/backend/spec/journey/a.feature": "Feature: a\n",
          "apps/backend/spec/journey/b.api-journey.test.ts": source(
            ...REQUIRED_IMPORTS,
          ),
          // 置き場所の違反: サブディレクトリの中、spec/journey/ の外（旧名の journeys/・feature の下・frontend）。
          "apps/backend/spec/journey/nested/z.feature": "Feature: z\n",
          "apps/backend/spec/journey/nested/y.api-journey.test.ts": source(
            ...REQUIRED_IMPORTS,
          ),
          "apps/backend/journeys/x.journey.test.ts": source(
            ...REQUIRED_IMPORTS,
          ),
          "apps/backend/features/x/spec/journey/x.api-journey.test.ts": source(
            ...REQUIRED_IMPORTS,
          ),
          "apps/backend/features/todo/out.feature": "Feature: out\n",
          // 置き場所の違反の .feature は中身を見ない（DB があっても置き場所の違反だけ）。
          "apps/frontend_customer/x.feature": "Feature: front の DB\n",
          // 対象外: 層の下のテスト（vi.mock があっても API ジャーニーではない）、名前に feature を含むだけのソース、
          //   node_modules と . で始まるディレクトリの中。
          "apps/backend/features/x/internal/presentation/x.api.test.ts": source(
            'import { vi } from "vitest";',
            "await renameX(request);",
          ),
          "apps/backend/features/x/internal/domain/x.feature.ts":
            "export const a = 1;\n",
          // API 仕様の .feature は対象外（中身に DB があっても見ない。api-spec.test.ts が見る）。
          "apps/backend/spec/api/todo/create-todo.feature": "Feature: DB\n",
          // E2E の .feature も対象外（中身に DB があっても見ない。e2e-feature.test.ts が見る。Issue #279）。
          "apps/e2e/out.feature": "Feature: e2e の DB\n",
          "apps/backend/spec/api/todo/x.api-journey.test.ts": source(
            ...REQUIRED_IMPORTS,
          ),
          "apps/backend/node_modules/x/x.api-journey.test.ts": "",
          "apps/backend/node_modules/x/x.feature": "",
          "apps/frontend_customer/.next/x.feature": "",
        });

        // when
        const result = {
          files: listApiJourneyTargets(root),
          violations: collectApiJourneyViolations(root),
        };

        // then
        expect(result).toEqual({
          files: [
            "apps/backend/features/todo/out.feature",
            "apps/backend/features/x/spec/journey/x.api-journey.test.ts",
            "apps/backend/journeys/x.journey.test.ts",
            "apps/backend/spec/api/todo/x.api-journey.test.ts",
            "apps/backend/spec/journey/a.feature",
            "apps/backend/spec/journey/b.api-journey.test.ts",
            "apps/backend/spec/journey/helper.ts",
            "apps/backend/spec/journey/mock.api-journey.test.ts",
            "apps/backend/spec/journey/mock.feature",
            "apps/backend/spec/journey/nested/y.api-journey.test.ts",
            "apps/backend/spec/journey/nested/z.feature",
            "apps/backend/spec/journey/no-db-check.api-journey.test.ts",
            "apps/backend/spec/journey/no-db-check.feature",
            "apps/backend/spec/journey/old.journey.test.ts",
            "apps/backend/spec/journey/only-feature.feature",
            "apps/backend/spec/journey/only-steps.api-journey.test.ts",
            "apps/backend/spec/journey/single-api.api-journey.test.ts",
            "apps/backend/spec/journey/single-api.feature",
            "apps/backend/spec/journey/wording.api-journey.test.ts",
            "apps/backend/spec/journey/wording.feature",
            "apps/backend/spec/journey/x.api-journey.test.ts",
            "apps/backend/spec/journey/x.feature",
            "apps/backend/spec/journey/x.test.ts",
            "apps/frontend_customer/x.feature",
          ],
          violations: [
            "api-journey-placement: apps/backend/features/todo/out.feature",
            "api-journey-placement: apps/backend/features/x/spec/journey/x.api-journey.test.ts",
            "api-journey-placement: apps/backend/journeys/x.journey.test.ts",
            "api-journey-placement: apps/backend/spec/api/todo/x.api-journey.test.ts",
            "api-journey-feature-pair: apps/backend/spec/journey/a.feature",
            "api-journey-feature-pair: apps/backend/spec/journey/b.api-journey.test.ts",
            "api-journey-placement: apps/backend/spec/journey/helper.ts",
            "api-journey-no-vi: apps/backend/spec/journey/mock.api-journey.test.ts:4",
            "api-journey-no-skip: apps/backend/spec/journey/mock.api-journey.test.ts:6",
            "api-journey-placement: apps/backend/spec/journey/nested/y.api-journey.test.ts",
            "api-journey-placement: apps/backend/spec/journey/nested/z.feature",
            "api-journey-handler-naming: apps/backend/spec/journey/no-db-check.api-journey.test.ts:6",
            "api-journey-asserts-db-after-mutation: apps/backend/spec/journey/no-db-check.api-journey.test.ts:10",
            "api-journey-placement: apps/backend/spec/journey/old.journey.test.ts",
            "api-journey-feature-pair: apps/backend/spec/journey/only-feature.feature",
            "api-journey-feature-pair: apps/backend/spec/journey/only-steps.api-journey.test.ts",
            "api-journey-no-in-memory: apps/backend/spec/journey/single-api.api-journey.test.ts:3",
            "api-journey-uses-multiple-apis: apps/backend/spec/journey/single-api.api-journey.test.ts",
            "api-journey-business-language: apps/backend/spec/journey/wording.feature:5",
            "api-journey-section-divider: apps/backend/spec/journey/wording.feature:6",
            "api-journey-tag: apps/backend/spec/journey/wording.feature:7",
            "api-journey-placement: apps/backend/spec/journey/x.test.ts",
            "api-journey-placement: apps/frontend_customer/x.feature",
          ],
        });
      },
    );

    And("apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
      // given
      const root = fixture({ "README.md": "# x\n" });

      // when
      const result = {
        files: listApiJourneyTargets(root),
        violations: collectApiJourneyViolations(root),
      };

      // then
      expect(result).toEqual({ files: [], violations: [] });
    });
  });

  Scenario("API ジャーニー（実ファイル）", ({ And }) => {
    And(
      "apps/backend/spec/journey/ には対になった .feature と .api-journey.test.ts だけがあり、.feature は業務の言葉だけで API を呼ぶ step の前に仕切りがあり、各 API ジャーニーは InMemory と vi を使わず、実 DB と 2 つ以上の API を使い、変更系の API の後に DB を読む",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const apiJourneyTargets = listApiJourneyTargets(repoRoot);
        const violations = collectApiJourneyViolations(repoRoot);

        // then
        // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
        expect(apiJourneyTargets).toEqual(
          expect.arrayContaining([
            "apps/backend/spec/journey/todo-lifecycle.feature",
            "apps/backend/spec/journey/todo-lifecycle.api-journey.test.ts",
          ]),
        );
        expect(violations).toEqual([]);
      },
    );
  });
});

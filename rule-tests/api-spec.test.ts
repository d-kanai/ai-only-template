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
import { afterAll, describe, expect, it } from "vitest";
import { containsForbiddenWord } from "./feature-business-language";

// API 仕様テスト（Issue #219。.claude/rules/testing.md の「API 仕様テスト（api-specs）」、ADR
//   docs/adr/quality/20260930-api-spec-in-feature.md）の置き場所と形を、ファイルの一覧とソースで機械的に検査するテスト。
// API 仕様テスト = API 1 つ（apps/backend/features/<feature>/internal/presentation/<api>.api.ts）の振る舞いを、人が読む仕様として
//   Gherkin の <api>.feature に業務の言葉で書き、step の実装（<api>.api-spec.test.ts）が実 Postgres の上で本番の組み立てを通して
//   確かめるテスト。`*` の 1 行 = 1 つの振る舞い = 1 つのテスト（vitest-cucumber は step 1 つを Vitest の test 1 つにする）。
// 違反にするもの:
//   - api-spec-placement: apps/backend/api-specs/ の下には、<feature>/ の直下の <api>.feature・<api>.api-spec.test.ts・support.ts
//     （補助。名前は固定）だけを置く。api-specs/ の直下のファイル・<feature>/ の下のサブディレクトリの中のファイル・ほかの名前
//     （helper.ts・README.md・x.test.ts・.tsx・support.test.ts）は違反。apps/ の下のほかの場所（features/<f>/・api-journeys/・
//     frontend など）に *.api-spec.test.* を置くのも違反。
//     WHY 置き場所を 1 か所にする: 人が読む API 仕様を feature ごとに 1 つのディレクトリで一覧でき、test-support/database（実 DB）の
//       import の例外（rule-tests/test-doubles.test.ts の db-tests-in-infra-only）もこの 1 か所に絞れる。
//     WHY 補助は support.ts の 1 つに固定する: step の実装が共有する組み立て・DB の読み出しの置き場所を決め、api-specs/ を別の用途の
//       置き場所にさせない（Issue #219 の判断。test-support/ はテストダブル・DB 基盤・テストデータビルダー（Issue #240）の置き場所で、API 仕様だけの補助は置かない）。
//     WHY api-specs/ の外の .feature はここで見ない: rule-tests/api-journey.test.ts の api-journey-placement が止める（api-specs/ の下の
//       .feature だけを例外にしている）。
//   - api-spec-pair: apps/backend/features/<feature>/internal/presentation/<api>.api.ts の 1 つごとに、
//     apps/backend/api-specs/<feature>/<api>.feature と <api>.api-spec.test.ts の両方が要る（無いほうを api ファイルの違反にする）。
//     api-specs/ の <api>.feature・<api>.api-spec.test.ts に対の api ファイルが無ければ、そのファイルを違反にする（feature の
//     ディレクトリ名の違い・api の名前の違いも）。置き場所の違反のファイルは見ない。
//     WHY: 人が読む仕様を API ごとに漏れなく持つ（Issue #219。API を足したら仕様も足す）。.feature だけでは何も実行されず、step の
//       ファイルだけでは読む仕様が無い。api の無い仕様は、消した・改名した API の仕様が残ったもの。
//     step のファイルが対の .feature を読むことは api-spec-load-feature が見る。
//     限界: presentation の下のサブディレクトリの api ファイルと、
//       apps/backend/shared/presentation/ の api ファイルは対の対象外（今は無い）。
//   以下は .feature（api-specs/<feature>/ の直下の *.feature）の中身の規則。行ごとに見る（行は 1 始まり。行の区切りは \r\n・\r・\n。
//   vitest-cucumber は readline で読み、単独の \r でも行を分けるので同じにする。reviewer の指摘）:
//   - api-spec-scenario-heading: `Scenario:` の見出し（`:` の後ろの前後の空白を除いた文字）が SCENARIO_HEADINGS（作成 / 更新 /
//     削除 / レスポンス / ソート / 検索 / 記録 / 副作用 / 異常系）のどれでもなければ違反。同じ見出しの 2 つ目以降も違反（1 つの
//     .feature に 1 回）。
//     WHY: API ごとに同じ観点の見出しで振る舞いを分けると、読む人がどの API でも同じ場所を拾い読みでき、観点の抜けも見出しで分かる。
//       見出しは読み取り（レスポンス / ソート / 検索 / 異常系）と書き込み（作成・更新・削除のどれか 1 つ / レスポンス / 記録 / 副作用 /
//       異常系）の観点（ユーザー判断、2026-09-30 の work-logs。作成・更新・削除は Issue #249）。該当の無い見出しは書かずに省く。
//   - api-spec-scenario-order（Issue #249）: 見出しが SCENARIO_HEADINGS の順に並んでいなければ、前の見出しより一覧で前に来る見出しの
//     行を違反にする（一覧に無い見出しと同じ見出しの 2 つ目は数えない。api-spec-scenario-heading の違反なので）。
//     WHY: どの API の仕様も同じ順で読める（書き込みならメインの変更 → レスポンス → 記録 → 副作用 → 異常系）。
//   - api-spec-write-heading（Issue #249）: メインの変更の見出し（作成 / 更新 / 削除）が 2 つ以上なら 2 つ目以降の行、記録か副作用が
//     あるのにメインの変更の見出しが無ければ最初の記録・副作用の行を違反にする。
//     WHY: 書き込みの API の仕様で、対象の Todo 自身に起こること（メインの変更）と返る内容（レスポンス）を別の見出しに分ける
//       （ユーザー判断 2026-10-01。以前は create の「レスポンス」に「未完了の Todo が作られて返る」「前後の空白は除かれる」が混ざって
//       いた）。書き込みの API かどうかは記録・副作用の見出しで推定する（記録も副作用も無い書き込みの API はメインの変更が無くても
//       通る。今の 4 つの書き込みの API はどれも記録を持つ）。メインの変更が 1 つの API に 2 つあるのは、1 つの操作の仕様として誤り。
//   - api-spec-keyword: `Scenario Outline:` / `Scenario Template:` / `Rule:` / `Background:` / `Example:` / `Examples:` /
//     `Scenarios:` の行と、`# language:` の行は違反。
//     WHY: 形を「Feature の下に固定の見出しの Scenario と `*` の step」の 1 通りにし、見出しの一覧の検査を逃れる書き方（Example は
//       Scenario の別名）を止める。Background（共通の前提）と Outline（例の表）は、`*` の 1 行で前提から確かめまで完結させる形と
//       合わない。
//     WHY `# language:` も止める: vitest-cucumber 8.0.0 の parser は `#` の行を読み飛ばし、言語は loadFeature の第 2 引数
//       （`{ language }`）と setVitestCucumberConfiguration で決まる（reviewer の実測、Issue #219。言語を変える口は api-spec-load-feature で
//       止める）。この行自体は実行に効かないが、Gherkin の慣習では言語の指定なので、別の言語のキーワードで書く意図を持ち込ませない。
//   - api-spec-tag: `@` で始まる行（タグ。字下げの後）は違反。
//     WHY: vitest-cucumber は既定の excludeTags（`@ignore` など）が付いた Scenario を skip にし、仕様が黙って外れたまま緑になる
//       （reviewer の実測、Issue #219）。タグで振る舞いを分ける場面は無い（見出しの一覧で分ける）ので、タグそのものを使わない。
//   - api-spec-step-star: step が `*` 以外のキーワード（`Given` / `When` / `Then` / `And` / `But` で始まる行）なら違反。`*` の行が
//     1 つも無い Scenario も違反（行は Scenario の行）。
//     WHY: `*` の 1 行 = 1 つの振る舞い = 1 つのテストにし、Given / When / Then は step の実装の中で完結させる（ユーザー判断）。
//       step ごとに前提から確かめまで閉じるので、step の順に依存しない（Stryker の test ごとの絞り込みとも噛み合う見込み。
//       ADR docs/adr/quality/20260930-api-spec-in-feature.md）。`*` の無い Scenario は何も確かめない。
//   - api-spec-business-language: `#` のコメント行・空行・`Feature:` と `Scenario:` の見出しの行を除くすべての行（`*` の step・
//     説明の行・表の行・ほかのキーワードの行）に、FORBIDDEN_WORDS_IN_FEATURE（rule-tests/feature-business-language.ts。API ジャーニーの
//     api-journey-business-language と共有）の禁止語のどれかが含まれると違反（1 行 1 件）。3 桁の数（1xx〜5xx）の扱いも共有する。
//     WHY: .feature は業務の仕様として開発者でない人も読む（API ジャーニーと同じ。Issue #217）。
//     WHY Scenario の見出しを見ない: 見出しは固定の一覧（api-spec-scenario-heading）で、一覧の「レスポンス」が禁止語に当たる。
//     WHY Feature の見出しを見ない: Issue #219 の指定（対象は Feature / Scenario の見出し以外）。
//   以下は step の実装（api-specs/<feature>/ の直下の <api>.api-spec.test.ts）の中身の規則:
//   - api-spec-no-vi: `vitest` から `vi`（と同じものの別名 `vitest`）を import しない。別名・名前空間・既定の import・dynamic
//     `import("vitest")` も違反。`import type` と inline の `type` は通す（api-journey-no-vi と同じ判定）。
//     WHY: 仕様は本番と同じ部品のつながりで確かめる。テストダブル（vi.mock・spyOn・fake timers）は差し替えた部分を確かめなくする。
//   - api-spec-no-in-memory: *.in-memory（InMemory の Repository）を import しない（`import type`・`import()`・`export … from` も）。
//     WHY: 実 DB で本番の組み立てを通すのが API 仕様の目的（Issue #219。InMemory は presentation の単体テストの道具）。
//   - api-spec-uses-real-database: apps/backend/test-support/database（createTestDatabase）を値として import する。
//     WHY: 実 Postgres の上で確かめる。型だけの import（TestDatabase）では DB を用意しない。
//   - api-spec-uses-own-api: 対の api（apps/backend/features/<feature>/internal/presentation/<api>.api。ファイルの置き場所の <feature> と
//     名前の <api>）を静的な import で参照する（`import type`・inline の type だけでもよい。dynamic `import()`・`export … from` は数えない）。
//     ほかの api を型だけで足して import するのは可（値の import は api-spec-own-api-only が止める）。
//     WHY: step のファイルと仕様の対象の API の対応を import で確かめる。組み立ては support.ts に任せてよい（Issue #219 の判断）ので、
//       型（応答の型）だけの参照も認める。本番の組み立てを通すことは、api-spec-uses-real-database・api-spec-no-in-memory と、次の
//       api-spec-support-assembles-apis で担保する。
//   - api-spec-own-api-only（Issue #240）: 自分の仕様の対象の API 以外の handler を手に入れる import をしない。その行の違反:
//     (1) support.ts（どの feature のものも）から、名前が `Api` で終わるもののうち、同じディレクトリの support.ts の対の組み立て
//     （<api> の camelCase + `Api`。rename-todo → renameTodoApi）以外を値で import する（別名の import は元の名前で見る。`import type`・
//     inline の type は通す）。support.ts を名前空間（`* as`）・既定の import・dynamic `import()` で読むのも違反（どの組み立てでも
//     取り出せる）。(2) 対でない presentation の api ファイル（どの feature のものも）を値で import する（dynamic `import()` も。型だけは
//     通す）。
//     WHY: 前提の Todo はテストデータビルダー（apps/backend/test-support/<feature>/*-builder.ts）で表に直接入れ、step が呼ぶ API は
//       仕様の対象の 1 つだけにする（ユーザー判断 2026-10-01、Issue #240）。前提を対象でない API で作ると、表が増えたときに前提の
//       用意が API の組み合わせに依存し、対象と関係の無い API の変更で仕様が落ちる。前提の記録（change_logs）も混ざり、期待値が
//       「対象の操作が残す記録」だけにならない。handler は support.ts の組み立てか api のクラスからしか手に入らないので、その 2 つの
//       入口を import の名前で止める。
//   - api-spec-load-feature: `loadFeature("./<api>.feature")`（対の .feature を第 2 引数なしで読む。引用符は " か '。名前空間の
//     `x.loadFeature(` も同じ）の呼び出しが 1 つ以上要る（無ければファイル全体の違反）。それ以外の形の loadFeature の呼び出し
//     （第 2 引数・別のパス・テンプレートリテラル・変数）、`loadFeature as` の別名の import、setVitestCucumberConfiguration・
//     loadFeatureFromText・defineFeature の名前（import も呼び出しも）は、その行の違反。
//     WHY: step のファイルが対の .feature を実行することを、名前の対（api-spec-pair）だけでなく読み込みの形で確かめる。言語は
//       loadFeature の第 2 引数と setVitestCucumberConfiguration で変わり（`language: "ja"` と `機能:` / `シナリオ:` / `前提` で
//       見出し・キーワード・step の 3 規則を同時にすり抜けることを reviewer が実測）、loadFeatureFromText・defineFeature は .feature の
//       ファイルを読まない。
//   - api-spec-no-skip: `.skip` / `.only` / `.skipIf` / `.runIf`（`Scenario.skip(`・`describeFeature.skip(`・`it.skipIf(` など。直前が `.`
//     のスプレッドは除く）と、タグの絞り込み includeTags / excludeTags の名前は、その行の違反。
//     WHY: skip した Scenario は skipped のまま Vitest が成功で終わり（reviewer の実測）、only はほかの Scenario を黙って止める。
//       タグの絞り込みも Scenario を外しうる（未実測）。Biome の noSkippedTests / noFocusedTests は `Scenario.skip(` / `Scenario.only(`
//       を止めない（Issue #219 で biome lint を実測。it / describe / test の名前だけを見る）。
//   以下は補助（api-specs/<feature>/ の直下の support.ts）の中身の規則:
//   - api-spec-no-vi は support.ts にも当てる（step が組み立てを任せる先で vi を使わせない。reviewer の任意の指摘）。
//   - api-spec-support-no-api-call（Issue #240）: support.ts の中で handler を呼ばない。`.handle(`（`?.handle(`・`.handle.call(` /
//     `.apply(` / `.bind(`・空白を挟むものも）と、名前が `Api` で終わる関数・メソッドの呼び出し（`createTodoApi(db)`・`createTodoApi<T>(db)`・
//     `createTodoApi?.(db)`・`x.postTodoApi(`。`new <名前>Api(` と
//     `function <名前>Api(` の宣言は除く）は、その行の違反。
//     WHY: 前提を API で作る口（以前の createTodo・changeCompletion）を support.ts に置かせない。step の api-spec-own-api-only は
//       import の名前しか見ないので、support.ts の関数が中でほかの API を呼ぶと素通りする。
//   - api-spec-support-assembler-per-api（Issue #240）: `new <名前>Api(` は、その Api だけを組み立てる関数 `function <名前の先頭を小文字>Api(`
//     （CreateTodoApi → createTodoApi）の中に 1 つだけ置く。囲む関数（その位置より前で最後の `function <名前>(` の宣言）が無い・名前が
//     違う・同じ関数の 2 つ目以降は、その行の違反。
//     WHY: すべての handler をまとめて返す関数（以前の todoApis）があると、step は `Api` で終わらない名前で import して、どの API も
//       呼べる（api-spec-own-api-only を素通りする）。組み立て関数を Api ごとに分け、名前を Api のクラスから決めると、step の
//       import の名前と組み立てる Api が 1 対 1 になる（api ファイルの名前とクラス名は .claude/rules/backend.md の「命名」で対になる）。
//   - api-spec-support-assembles-apis: 自 feature の api（apps/backend/features/<feature>/internal/presentation/<名前>.api）を少なくとも
//     1 つ値として import する（`import type`・inline の type だけ・dynamic `import()`・`export … from` は数えない）。
//     WHY: step のファイルは組み立てを support.ts に任せ、api を型だけで参照してよい。support.ts が本番の api ファイル（Api のクラス）を
//       値で使わなければ、仕様が本番の組み立てを通さない（Api のクラスを通さず command を直接呼ぶ）形でも通ってしまう。
// コメントの扱い: .ts は行コメントとブロックコメントの中を見ない（文字列は残す。architecture.test.ts の stripComments と同じ）。
//   loadFeature・skip の検査は文字列の中も見ない（blankStrings。loadFeature の引数の文字列だけは対の形かを読む）。
// 限界（字句の推定。rule-tests/api-journey.test.ts と同じ方式）:
//   - .feature: 行ごとに見るので、docstring（`"""`）の中も行の種類を区別しない（中の `#` の行はコメント、`Given` で始まる行は
//     step として扱う）。Feature の見出しの有無・Scenario の数（0 でも通る）・`*` の文が振る舞い 1 つかは見ない。禁止語は一覧の語だけ
//     （複数形・全角の英数字・一覧に無い技術の言葉は見ない）。
//   - step の実装: vi の import を require・変数を渡す `import(x)`・vitest のサブパスや別のモジュールの再公開で行うのは見ない。
//     loadFeature・skip は名前で見るので、`x["skip"](`・変数に入れ直した関数（`const s = Scenario.skip`）・vitest-cucumber の
//     関数を別のモジュールで包んで呼ぶ書き方は見ない（逆に、同じ名前の別の関数・プロパティ `.only` も違反にする）。
//     `*` の step ごとに前提から確かめまで完結しているか・DB の行を確かめているかは見ない（reviewer が見る）。
//   - support.ts は api の値の import・vi の import・Api の組み立ての置き場所・handler と組み立て関数の呼び出しだけを見る（InMemory の
//     import は見ない）。値で import した api のクラスを実際に組み立てに使っているかは見ない。step のファイルの api の import は型だけでも
//     通るので、step が対の api を実際に呼んでいるかは見ない（reviewer が見る）。step のファイルが support.ts 経由で
//     test-support/database を使っても、step のファイル自身に値の import が無ければ違反になる（直接 import する）。
//   - 対象の API だけ（api-spec-own-api-only・api-spec-support-no-api-call・api-spec-support-assembler-per-api。Issue #240）: 名前で見るので、
//     support.ts が組み立て関数を `Api` で終わらない名前で再公開する（`export { createTodoApi as post }`・`export const post = createTodoApi`）、
//     組み立て関数の中で handler を変数に入れ直して呼ぶ（`const h = new XApi(…).handle; await h(req)`）、文字列のキーで呼ぶ
//     （`x["handle"](`）、組み立て関数を support.ts の中で別名にして呼ぶ（`const post = createXApi; post(db)(req)`）、型引数の
//     入れ子（`createXApi<Array<T>>(db)`。`<[^<>()]*>` が入れ子を読めない）、step の `require("./support")`、
//     command / query を直接 new して呼ぶ（handler を通らずに前提を作る）、step が support.ts を経ずに
//     Postgres の Repository などで前提を書く書き方は見ない（reviewer が見る）。囲む関数は直前の `function` の宣言で推定するので、
//     ネストした関数・アロー関数・クラスのメソッドの中の `new <名前>Api(` は外側の関数で数える（名前が合わなければ違反になる側に倒れる）。
// WHY 文字列で判定する（AST にしない）: 見るのはパス・行の先頭のキーワード・import の参照先だけで、正規表現で足りる
//   （rule-tests/api-journey.test.ts と同じ）。

type ApiSpecRuleId =
  | "api-spec-placement"
  | "api-spec-pair"
  | "api-spec-scenario-heading"
  | "api-spec-scenario-order"
  | "api-spec-write-heading"
  | "api-spec-keyword"
  | "api-spec-tag"
  | "api-spec-step-star"
  | "api-spec-business-language"
  | "api-spec-no-vi"
  | "api-spec-no-in-memory"
  | "api-spec-uses-real-database"
  | "api-spec-uses-own-api"
  | "api-spec-own-api-only"
  | "api-spec-support-assembles-apis"
  | "api-spec-support-no-api-call"
  | "api-spec-support-assembler-per-api"
  | "api-spec-load-feature"
  | "api-spec-no-skip";

// line: ソースの中の位置で決まる違反だけ持つ（1 始まり）。note: 対の違反で、無いファイル（対の相手）を示す。
type ApiSpecViolation = { rule: ApiSpecRuleId; line?: number; note?: string };

const API_SPECS_DIR = "apps/backend/api-specs/";

// Scenario の見出しの固定の一覧（api-spec-scenario-heading）。並びは .feature に書く順（api-spec-scenario-order）。WHY は冒頭の説明。
const SCENARIO_HEADINGS: readonly string[] = [
  "作成",
  "更新",
  "削除",
  "レスポンス",
  "ソート",
  "検索",
  "記録",
  "副作用",
  "異常系",
];

// API 仕様の .feature か（api-specs/<feature>/ の直下の *.feature）。
function isSpecFeatureFile(path: string): boolean {
  return /^apps\/backend\/api-specs\/[^/]+\/[^/]+\.feature$/.test(path);
}

// API 仕様の step の実装か（api-specs/<feature>/ の直下の *.api-spec.test.ts）。
function isSpecStepFile(path: string): boolean {
  return /^apps\/backend\/api-specs\/[^/]+\/[^/]+\.api-spec\.test\.ts$/.test(
    path,
  );
}

// API 仕様の補助か（api-specs/<feature>/ の直下の support.ts）。
function isSpecSupportFile(path: string): boolean {
  return /^apps\/backend\/api-specs\/[^/]+\/support\.ts$/.test(path);
}

// api-specs/ の外で、置いてあれば置き場所の違反になる名前。WHY 拡張子を広く取る: .tsx・.js で外に置いても見つける。
const OUTSIDE_API_SPEC_FILE = /\.api-spec\.test\.[cm]?[jt]sx?$/;

// path（リポジトリ相対、/ 区切り）が置き場所の規則に違反するか。
function isMisplacedApiSpecFile(path: string): boolean {
  if (path.startsWith(API_SPECS_DIR)) {
    return (
      !isSpecFeatureFile(path) &&
      !isSpecStepFile(path) &&
      !isSpecSupportFile(path)
    );
  }
  return OUTSIDE_API_SPEC_FILE.test(path);
}

// 仕様を要る api ファイル（features/<feature>/internal/presentation/ の直下の <api>.api.ts）。1: feature、2: api の名前。
const API_FILE =
  /^apps\/backend\/features\/([^/]+)\/internal\/presentation\/([^/]+)\.api\.ts$/;

// 対の違反（api-spec-pair）。files は同じ列挙（listApiSpecTargets）の結果。
// api ファイルには .feature と step の両方が要り、api-specs/ の .feature・step には api ファイルが要る。
function findPairViolations(
  path: string,
  files: ReadonlySet<string>,
): ApiSpecViolation[] {
  const api = API_FILE.exec(path);
  if (api !== null) {
    const base = `${API_SPECS_DIR}${api[1]}/${api[2]}`;
    return [`${base}.feature`, `${base}.api-spec.test.ts`]
      .filter((spec) => !files.has(spec))
      .map((spec) => ({ rule: "api-spec-pair", note: `${spec} が無い` }));
  }
  const spec =
    /^apps\/backend\/api-specs\/([^/]+)\/([^/]+?)(?:\.feature|\.api-spec\.test\.ts)$/.exec(
      path,
    );
  if (spec === null || !(isSpecFeatureFile(path) || isSpecStepFile(path))) {
    return [];
  }
  const apiPath = `apps/backend/features/${spec[1]}/internal/presentation/${spec[2]}.api.ts`;
  return files.has(apiPath)
    ? []
    : [{ rule: "api-spec-pair", note: `対の ${apiPath} が無い` }];
}

// .feature の 1 行の種類。skip: コメント・空行・Feature の見出し（どの規則も見ない）。language: `# language:` の行。
//   scenario: `Scenario:` の見出し。keyword: 使わないキーワード（Outline・Rule・Background など）。keyword-step: `*` 以外の step。
//   tag: `@` で始まるタグの行。star: `*` の step。text: それ以外（説明の行・表の行・docstring）。
type FeatureLineKind =
  | "skip"
  | "language"
  | "tag"
  | "scenario"
  | "keyword"
  | "keyword-step"
  | "star"
  | "text";

function featureLineKind(line: string): FeatureLineKind {
  // WHY 行頭（字下げの後）の # だけをコメントにする: Gherkin のコメントは行全体だけで、行の途中の # は文の一部。
  if (/^\s*#\s*language\s*:/i.test(line)) {
    return "language";
  }
  if (/^\s*(?:#|$)/.test(line) || /^\s*Feature\s*:/.test(line)) {
    return "skip";
  }
  if (/^\s*@/.test(line)) {
    return "tag";
  }
  if (/^\s*Scenario\s*:/.test(line)) {
    return "scenario";
  }
  if (
    /^\s*(?:Scenario Outline|Scenario Template|Rule|Background|Examples?|Scenarios)\s*:/.test(
      line,
    )
  ) {
    return "keyword";
  }
  if (/^\s*(?:Given|When|Then|And|But)(?:\s|$)/.test(line)) {
    return "keyword-step";
  }
  return /^\s*\*(?:\s|$)/.test(line) ? "star" : "text";
}

// 1 行の種類ごとの違反（`*` の数えと Scenario の区切りは呼び出し側）。
const RULE_OF_LINE_KIND: Partial<Record<FeatureLineKind, ApiSpecRuleId>> = {
  language: "api-spec-keyword",
  tag: "api-spec-tag",
  keyword: "api-spec-keyword",
  "keyword-step": "api-spec-step-star",
};

// 禁止語を見ない行の種類（api-spec-business-language）。
const LINE_KINDS_WITHOUT_WORDING: ReadonlySet<FeatureLineKind> = new Set([
  "skip",
  "language",
  "scenario",
]);

// メインの変更（書き込みの API が対象の Todo 自身に起こすこと）の見出し（api-spec-write-heading）。WHY は冒頭の説明。
const MUTATION_HEADINGS: ReadonlySet<string> = new Set([
  "作成",
  "更新",
  "削除",
]);

// 書き込みの API だけが持つ見出し。あればメインの変更の見出しが要る（api-spec-write-heading）。
const WRITE_ONLY_HEADINGS: ReadonlySet<string> = new Set(["記録", "副作用"]);

// .feature の中の見出しの並び（行と名前）。一覧の順・メインの変更の数を、ファイルの見出しを読み終えてから見るために集める。
type ScenarioHeading = { line: number; name: string };

// `Scenario:` の見出しの違反（api-spec-scenario-heading）。seen に見出しを足す（同じ見出しの 2 つ目以降を違反にするため）。
function headingViolations(
  heading: ScenarioHeading,
  seen: Set<string>,
): ApiSpecViolation[] {
  const violates =
    !SCENARIO_HEADINGS.includes(heading.name) || seen.has(heading.name);
  seen.add(heading.name);
  return violates
    ? [{ rule: "api-spec-scenario-heading", line: heading.line }]
    : [];
}

// 見出しの並びの違反（api-spec-scenario-order・api-spec-write-heading）。
// WHY 一覧に無い見出しと同じ見出しの 2 つ目を除く: api-spec-scenario-heading で違反になるので、ほかの規則で重ねて数えない。
function headingSequenceViolations(
  headings: readonly ScenarioHeading[],
): ApiSpecViolation[] {
  const seen = new Set<string>();
  const firsts = headings.filter((heading) => {
    const counted =
      SCENARIO_HEADINGS.includes(heading.name) && !seen.has(heading.name);
    seen.add(heading.name);
    return counted;
  });
  const violations: ApiSpecViolation[] = [];
  let furthest = -1;
  for (const heading of firsts) {
    const position = SCENARIO_HEADINGS.indexOf(heading.name);
    if (position < furthest) {
      violations.push({ rule: "api-spec-scenario-order", line: heading.line });
    }
    furthest = Math.max(furthest, position);
  }
  const mutations = firsts.filter((h) => MUTATION_HEADINGS.has(h.name));
  for (const extra of mutations.slice(1)) {
    violations.push({ rule: "api-spec-write-heading", line: extra.line });
  }
  const writeOnly = firsts.find((h) => WRITE_ONLY_HEADINGS.has(h.name));
  if (mutations.length === 0 && writeOnly !== undefined) {
    violations.push({ rule: "api-spec-write-heading", line: writeOnly.line });
  }
  return violations;
}

// .feature の中身の違反（行の順。同じ行なら見出し・キーワード・step・言葉・見出しの並び（順・メインの変更）の順）。
function findFeatureContentViolations(source: string): ApiSpecViolation[] {
  // WHY \r\n・\r・\n のどれでも分ける: vitest-cucumber は readline で読み、単独の \r でも行を分ける（reviewer の指摘、Issue #219）。
  //   \n だけで分けると、\r で区切った行が 1 行に隠れて（Feature の行の後ろに続けると丸ごと見ない）検査を逃れる。CRLF の行末に \r が
  //   残ると見出しが一覧と一致しなくなる。
  const lines = source.split(/\r\n|\r|\n/);
  const violations: ApiSpecViolation[] = [];
  const seenHeadings = new Set<string>();
  const headings: ScenarioHeading[] = [];
  // 今いる Scenario（行と `*` の数）。Scenario の外（Feature の直下・Background などの後）は undefined。
  let scenario: { line: number; stars: number } | undefined;
  const closeScenario = () => {
    if (scenario !== undefined && scenario.stars === 0) {
      violations.push({ rule: "api-spec-step-star", line: scenario.line });
    }
    scenario = undefined;
  };
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const kind = featureLineKind(line);
    if (kind === "scenario" || kind === "keyword") {
      closeScenario();
    }
    const rule = RULE_OF_LINE_KIND[kind];
    if (rule !== undefined) {
      violations.push({ rule, line: lineNumber });
    }
    if (kind === "scenario") {
      scenario = { line: lineNumber, stars: 0 };
      const heading = {
        line: lineNumber,
        name: line.slice(line.indexOf(":") + 1).trim(),
      };
      headings.push(heading);
      violations.push(...headingViolations(heading, seenHeadings));
    }
    if (kind === "star" && scenario !== undefined) {
      scenario.stars += 1;
    }
    // WHY Scenario の見出し・language の行を見ない: 見出しは固定の一覧（レスポンスが禁止語に当たる）、language はコメント。
    if (!LINE_KINDS_WITHOUT_WORDING.has(kind) && containsForbiddenWord(line)) {
      violations.push({ rule: "api-spec-business-language", line: lineNumber });
    }
  });
  closeScenario();
  violations.push(...headingSequenceViolations(headings));
  // WHY 並べ直す: `*` の無い Scenario の違反は、次の Scenario（かファイル末尾）で分かるので後から積まれる。見出しの並びの違反も、
  //   見出しを読み終えてから積む。
  return violations.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
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

// import の種類（api-journey.test.ts と同じ）。value: 値の名前を 1 つ以上取る静的な import。type: `import type` か、すべてに
//   inline の type。dynamic: dynamic import()。other: 副作用だけの import・export … from。
type ImportKind = "value" | "type" | "dynamic" | "other";

type ImportRef = {
  specifier: string;
  kind: ImportKind;
  clause: string;
  line: number;
};

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// `{ type A, type B }` のように、すべてに inline の type が付いているか（architecture.test.ts の isInlineTypeOnly と同じ）。
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

// ソース（コメントを消したもの）の import / export … from / import "…" / import("…") の参照先（api-journey.test.ts と同じ）。
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
// WHY 解決して比べる: `../../test-support/database` と `@repo/backend/test-support/database` は同じモジュール。
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const alias = "@repo/backend/";
  const resolved = specifier.startsWith(".")
    ? posix.join(posix.dirname(from), specifier)
    : specifier.startsWith(alias)
      ? posix.join("apps/backend", specifier.slice(alias.length))
      : undefined;
  return resolved?.replace(/\.[cm]?[jt]sx?$/, "");
}

// vitest の import が vi に届くか（api-journey.test.ts の reachesVi と同じ。WHY もそちら）。
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

// 実 Postgres のテスト用の DB を用意するモジュール（リポジトリ相対、拡張子なし）。
const TEST_DATABASE_MODULE = "apps/backend/test-support/database";

// 文字列の中身を空白にする（改行と長さは残し、位置と行番号を変えない）。stripComments の後に使う（api-journey.test.ts と同じ）。
// WHY: 文字列の中の `.skip(`・`loadFeature(`・`setVitestCucumberConfiguration` を呼び出しと数えない。
function blankStrings(code: string): string {
  return code.replace(
    /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    (literal) => literal.replace(/[^\n]/g, " "),
  );
}

// loadFeature の違反（api-spec-load-feature）。code はコメントを消したもの、paired は対の .feature の相対パス（"./<api>.feature"）。
// lines: 対の形でない loadFeature の呼び出し・別名の import・ほかの読み込み口と設定の行。hasPairedCall: 対の形の呼び出しがあるか。
// 対の形 = `loadFeature("./<api>.feature")`（引用符は " か '、第 2 引数なし。名前空間の `x.loadFeature(` も同じに見る）。
function findLoadFeatureViolations(
  code: string,
  paired: string,
): { lines: ApiSpecViolation[]; hasPairedCall: boolean } {
  const blanked = blankStrings(code);
  const calls = [...blanked.matchAll(/\bloadFeature\s*\(/g)].map((match) => {
    const args = /^loadFeature\s*\(\s*(["'])([^"'\n]*)\1\s*\)/.exec(
      code.slice(match.index),
    );
    return { index: match.index, paired: args?.[2] === paired };
  });
  // WHY 別名の import・ほかの口・設定を止める: 別名で呼ぶと上の形の検査を逃れ、loadFeatureFromText・defineFeature は .feature の
  //   ファイルを読まず、setVitestCucumberConfiguration は言語（language）とタグの絞り込みを全体で変える。
  const others = [
    ...blanked.matchAll(
      /\bloadFeature\s+as\b|\b(?:setVitestCucumberConfiguration|loadFeatureFromText|defineFeature)\b/g,
    ),
  ].map((match) => match.index);
  return {
    lines: [
      ...calls.filter((call) => !call.paired).map((call) => call.index),
      ...others,
    ].map((index) => ({
      rule: "api-spec-load-feature",
      line: lineAt(code, index),
    })),
    hasPairedCall: calls.some((call) => call.paired),
  };
}

// skip の違反（api-spec-no-skip）。`.skip` / `.only` / `.skipIf` / `.runIf`（vitest-cucumber の Scenario・Background・
//   describeFeature と、vitest の it・test のどちらも）と、タグの絞り込み（includeTags / excludeTags）の位置ごとに 1 件。
// WHY 直前が . のもの（スプレッドの `...only`）を除く: `{ ...todo }` のようなスプレッドを呼び出しと取り違えない。
// WHY .todo を入れない: 既にある振る舞いを外さない（新しい保留のテストを足すだけ）うえ、`response.todo` のような Todo の
//   プロパティと見分けられない。
function findSkipViolations(code: string): ApiSpecViolation[] {
  return [
    ...blankStrings(code).matchAll(
      /(?<!\.)\.\s*(?:skip|only|skipIf|runIf)\b|\b(?:includeTags|excludeTags)\b/g,
    ),
  ].map((match) => ({
    rule: "api-spec-no-skip",
    line: lineAt(code, match.index),
  }));
}

// support.ts（どの feature のものも。拡張子なしのリポジトリ相対）か。
function isSupportModule(module: string | undefined): boolean {
  return (
    module !== undefined &&
    /^apps\/backend\/api-specs\/[^/]+\/support$/.test(module)
  );
}

// presentation の api ファイル（どの feature のものも。拡張子なしのリポジトリ相対）か。
function isApiModule(module: string | undefined): boolean {
  return (
    module !== undefined &&
    /^apps\/backend\/features\/[^/]+\/internal\/presentation\/.+\.api$/.test(
      module,
    )
  );
}

// api ファイルの名前（kebab-case）から、support.ts の組み立て関数の名前を作る（"change-todo-completion" → "changeTodoCompletionApi"）。
// WHY クラス名の先頭を小文字にしたものと同じになる: api ファイルとクラスは `<verb>-<noun>.api.ts` と `<Verb><Noun>Api` で対になる
//   （.claude/rules/backend.md の「命名」）。support.ts の側は api-spec-support-assembler-per-api がクラス名から同じ名前を求める。
function assemblerNameOf(api: string): string {
  return `${api.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase())}Api`;
}

// 静的な import の句（`{ a, type B, c as d }`・`X, { a }`・`* as s`）のうち、値として取り出す名前（別名の前の元の名前）。
//   whole: 既定の import か名前空間（`* as s`）で、モジュールの何でも取り出せる。
function valueNamesOf(clause: string): { names: string[]; whole: boolean } {
  const braces = /\{([\s\S]*)\}/.exec(clause);
  const names = (braces?.[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "" && !/^type\s/.test(name))
    .map((name) => name.split(/\s+as\s+/)[0] ?? name);
  const outsideBraces = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, "");
  return { names, whole: outsideBraces.trim() !== "" };
}

// step の実装が自分の仕様の対象の API 以外の handler を手に入れる import の行（api-spec-own-api-only）。
//   - support.ts（どの feature のものも）から、Api で終わる名前のうち対の組み立て（同じディレクトリの support.ts の
//     assemblerNameOf(api)）以外を値で import する。ほかの feature の support.ts からは Api で終わる名前をどれも取らない。
//     名前空間・既定の import・dynamic import() はどの組み立てでも取り出せるので違反。
//   - 対でない presentation の api ファイル（どの feature のものも）を値で import する（dynamic import() も）。型だけは通す。
// WHY は冒頭の説明。
function findOwnApiOnlyViolations(
  path: string,
  api: string,
  imports: readonly ImportRef[],
): ApiSpecViolation[] {
  const ownApi = `apps/backend/features/${path.split("/")[3]}/internal/presentation/${api}.api`;
  const ownSupport = posix.join(posix.dirname(path), "support");
  const ownAssembler = assemblerNameOf(api);
  return imports
    .filter((ref) => {
      const module = resolveSpecifier(path, ref.specifier);
      if (ref.kind !== "value" && ref.kind !== "dynamic") {
        return false;
      }
      if (isSupportModule(module)) {
        const { names, whole } = valueNamesOf(ref.clause);
        return (
          ref.kind === "dynamic" ||
          whole ||
          names.some(
            (name) =>
              /Api$/.test(name) &&
              (module !== ownSupport || name !== ownAssembler),
          )
        );
      }
      return isApiModule(module) && module !== ownApi;
    })
    .map((ref) => ({ rule: "api-spec-own-api-only", line: ref.line }));
}

// step の実装（isSpecStepFile のファイル）の中身の違反。行のあるものを行の順に、その後にファイル全体の違反を返す。
function findStepContentViolations(
  path: string,
  source: string,
): ApiSpecViolation[] {
  const code = stripComments(source);
  const imports = extractImports(code);
  const [, feature, api] =
    /^apps\/backend\/api-specs\/([^/]+)\/([^/]+)\.api-spec\.test\.ts$/.exec(
      path,
    ) ?? [];
  const loadFeature = findLoadFeatureViolations(code, `./${api}.feature`);
  const lineLevel = [
    ...imports.flatMap((ref): ApiSpecViolation[] => [
      ...(/\.in-memory$/.test(moduleBaseName(ref.specifier))
        ? [{ rule: "api-spec-no-in-memory" as const, line: ref.line }]
        : []),
      ...(ref.specifier === "vitest" && reachesVi(ref)
        ? [{ rule: "api-spec-no-vi" as const, line: ref.line }]
        : []),
    ]),
    ...findOwnApiOnlyViolations(path, api ?? "", imports),
    ...loadFeature.lines,
    ...findSkipViolations(code),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  const valueModules = imports
    .filter((ref) => ref.kind === "value")
    .map((ref) => resolveSpecifier(path, ref.specifier));
  const ownApi = `apps/backend/features/${feature}/internal/presentation/${api}.api`;
  // WHY 型だけの import も数える: 対の API との対応を見る規則で、組み立ては support.ts に任せてよい（冒頭の説明）。
  const staticModules = imports
    .filter((ref) => ref.kind === "value" || ref.kind === "type")
    .map((ref) => resolveSpecifier(path, ref.specifier));
  return [
    ...lineLevel,
    ...(valueModules.includes(TEST_DATABASE_MODULE)
      ? []
      : [{ rule: "api-spec-uses-real-database" as const }]),
    ...(staticModules.includes(ownApi)
      ? []
      : [{ rule: "api-spec-uses-own-api" as const }]),
    ...(loadFeature.hasPairedCall
      ? []
      : [{ rule: "api-spec-load-feature" as const }]),
  ];
}

// support.ts が handler を呼ぶ・組み立て関数（Api で終わる名前）を呼ぶ行（api-spec-support-no-api-call）。code はコメントを消したもの。
// `.handle(`（`?.handle(`・`.handle.call(` / `.apply(` / `.bind(`・空白を挟むものも）と、`<名前>Api(`（型引数 `<...>` を挟むもの・
//   optional call の `<名前>Api?.(`・メソッドの `x.<名前>Api(` も）のうち `new <名前>Api(`（組み立て）と `function <名前>Api(`（組み立て関数の
//   宣言）以外。文字列の中は見ない（blankStrings）。
function findSupportApiCallViolations(code: string): ApiSpecViolation[] {
  const blanked = blankStrings(code);
  return [
    ...blanked.matchAll(/\.\s*handle\s*(?:\.\s*(?:call|apply|bind)\s*)?\(/g),
    ...blanked.matchAll(
      /(?<!\bnew\s+)(?<!\bfunction\s+)(?<![\w$])[A-Za-z_$][\w$]*Api\s*(?:<[^<>()]*>)?\s*(?:\?\.)?\s*\(/g,
    ),
  ].map((match) => ({
    rule: "api-spec-support-no-api-call",
    line: lineAt(code, match.index),
  }));
}

// support.ts の `new <名前>Api(` のうち、API ごとの組み立て関数の中に 1 つだけ置かれていないもの（api-spec-support-assembler-per-api）。
// 囲む関数は、その位置より前で最後の `function <名前>(` の宣言と推定する（字句。ネストやアロー関数は見分けない）。違反は、
//   囲む関数が無い（最上位・最初の function より前）、名前が「Api のクラス名の先頭を小文字にしたもの」でない、同じ関数の 2 つ目以降。
function findSupportAssemblerViolations(code: string): ApiSpecViolation[] {
  const blanked = blankStrings(code);
  const declarations = [...blanked.matchAll(/\bfunction\s+([\w$]+)/g)];
  const assembledIn = new Set<number>();
  return [...blanked.matchAll(/\bnew\s+([A-Za-z_$][\w$]*Api)\s*\(/g)].flatMap(
    (match): ApiSpecViolation[] => {
      const enclosing = declarations
        .filter((declaration) => declaration.index < match.index)
        .at(-1);
      const className = match[1] ?? "";
      const expected = `${className.charAt(0).toLowerCase()}${className.slice(1)}`;
      const ok =
        enclosing !== undefined &&
        enclosing[1] === expected &&
        !assembledIn.has(enclosing.index);
      if (enclosing !== undefined) {
        assembledIn.add(enclosing.index);
      }
      return ok
        ? []
        : [
            {
              rule: "api-spec-support-assembler-per-api",
              line: lineAt(code, match.index),
            },
          ];
    },
  );
}

// 補助（isSpecSupportFile のファイル）の中身の違反。vi の import・組み立ての形・呼び出し（行の順。同じ行は vi・組み立て・呼び出しの順）と、
//   自 feature の api を 1 つも値で import しない（ファイル全体）。
function findSupportContentViolations(
  path: string,
  source: string,
): ApiSpecViolation[] {
  const presentation = `apps/backend/features/${path.split("/")[3]}/internal/presentation/`;
  // WHY 前方一致と残りの名前で見る（feature の名前を正規表現に埋め込まない）: 名前の中の文字を正規表現として解釈させない。
  const isOwnApi = (module: string | undefined) =>
    module?.startsWith(presentation) === true &&
    /^[^/]+\.api$/.test(module.slice(presentation.length));
  const code = stripComments(source);
  const imports = extractImports(code);
  const assembles = imports
    .filter((ref) => ref.kind === "value")
    .some((ref) => isOwnApi(resolveSpecifier(path, ref.specifier)));
  // WHY support.ts にも no-vi を当てる（reviewer の任意の指摘、Issue #219）: step は組み立てを support.ts に任せるので、ここで vi を
  //   使うと step の no-vi を素通りしてテストダブルが入る。
  const vi = imports
    .filter((ref) => ref.specifier === "vitest" && reachesVi(ref))
    .map(
      (ref): ApiSpecViolation => ({ rule: "api-spec-no-vi", line: ref.line }),
    );
  // WHY sort は安定（同じ行は積んだ順のまま）: 同じ行の違反を vi・組み立て・呼び出しの順で返す。
  const lineLevel = [
    ...vi,
    ...findSupportAssemblerViolations(code),
    ...findSupportApiCallViolations(code),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return assembles
    ? lineLevel
    : [...lineLevel, { rule: "api-spec-support-assembles-apis" }];
}

// path の違反。置き場所が違えば置き場所の違反だけを返し（中身は見ない）、.feature・step・support.ts なら中身を見る。ほかは []。
function findApiSpecViolations(
  path: string,
  source: string,
): ApiSpecViolation[] {
  if (isMisplacedApiSpecFile(path)) {
    return [{ rule: "api-spec-placement" }];
  }
  if (isSpecFeatureFile(path)) {
    return findFeatureContentViolations(source);
  }
  if (isSpecSupportFile(path)) {
    return findSupportContentViolations(path, source);
  }
  return isSpecStepFile(path) ? findStepContentViolations(path, source) : [];
}

// root の下の dir を再帰的にたどり、ファイルのリポジトリ相対パス（/ 区切り）を返す。
// WHY node_modules と . で始まるディレクトリ（.next など）に入らない: 依存やビルド結果は検査の対象ではなく、たどると遅い
//   （rule-tests/api-journey.test.ts の walk と同じ）。
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

// 検査の対象: apps/ の下のファイルのうち、apps/backend/api-specs/ の下のもの、外に置くと違反になる名前（OUTSIDE_API_SPEC_FILE）の
//   もの、仕様を要る api ファイル（API_FILE）。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listApiSpecTargets(root: string): string[] {
  return walk(root, "apps")
    .filter(
      (path) =>
        path.startsWith(API_SPECS_DIR) ||
        OUTSIDE_API_SPEC_FILE.test(path) ||
        API_FILE.test(path),
    )
    .sort();
}

// 違反を「<規則>: <パス>」「<規則>: <パス>:<行>」「<規則>: <パス>（<無いファイル>）」で返す。
function collectApiSpecViolations(root: string): string[] {
  const paths = listApiSpecTargets(root);
  const files = new Set(paths);
  return paths.flatMap((path) =>
    [
      ...findApiSpecViolations(path, readFileSync(join(root, path), "utf8")),
      ...findPairViolations(path, files),
    ].map(({ rule, line, note }) =>
      line !== undefined
        ? `${rule}: ${path}:${line}`
        : note !== undefined
          ? `${rule}: ${path}（${note}）`
          : `${rule}: ${path}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const FEATURE = "apps/backend/api-specs/x/create-x.feature";
const STEPS = "apps/backend/api-specs/x/create-x.api-spec.test.ts";
const SUPPORT = "apps/backend/api-specs/x/support.ts";
const API = "apps/backend/features/x/internal/presentation/create-x.api.ts";
// step の実装の必須の import（実 DB と対の api）。must reject の例は、これに違反を 1 つ足すか、どれかを欠く。
const DATABASE_IMPORT =
  'import { createTestDatabase } from "../../test-support/database";';
const OWN_API_IMPORT =
  'import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";';
const REQUIRED_IMPORTS = [DATABASE_IMPORT, OWN_API_IMPORT];
// step の実装の必須の loadFeature（対の .feature を第 2 引数なしで読む）。中身の例は末尾にこれを足して判定する（行番号を変えない）。
const LOAD_FEATURE = 'const feature = await loadFeature("./create-x.feature");';

describe("API 仕様の置き場所（isMisplacedApiSpecFile）", () => {
  it.each([
    ["api-specs/<feature>/ の直下の <api>.feature", FEATURE],
    ["api-specs/<feature>/ の直下の <api>.api-spec.test.ts", STEPS],
    ["api-specs/<feature>/ の直下の support.ts", SUPPORT],
    ["presentation の api ファイル", API],
    [
      "presentation の単体テスト",
      "apps/backend/features/x/internal/presentation/create-x.api.test.ts",
    ],
    [
      "API ジャーニー（api-spec の名前でない）",
      "apps/backend/api-journeys/x.api-journey.test.ts",
    ],
    [
      "名前に api-spec を含むがテストでないファイル（api-specs/ の外）",
      "apps/backend/features/x/internal/domain/x.api-spec.ts",
    ],
  ])("%s は違反なし", (_name, path) => {
    expect(isMisplacedApiSpecFile(path)).toBe(false);
  });

  it.each([
    ["api-specs/ の直下の .feature", "apps/backend/api-specs/x.feature"],
    ["api-specs/ の直下の step", "apps/backend/api-specs/x.api-spec.test.ts"],
    ["api-specs/ の直下の support.ts", "apps/backend/api-specs/support.ts"],
    [
      "<feature>/ の下のサブディレクトリの .feature",
      "apps/backend/api-specs/x/nested/create-x.feature",
    ],
    [
      "<feature>/ の下のサブディレクトリの step",
      "apps/backend/api-specs/x/nested/create-x.api-spec.test.ts",
    ],
    [
      "<feature>/ の下のサブディレクトリの support.ts",
      "apps/backend/api-specs/x/nested/support.ts",
    ],
    ["support.ts 以外の補助の .ts", "apps/backend/api-specs/x/helper.ts"],
    ["名前の違う補助（Support.ts）", "apps/backend/api-specs/x/Support.ts"],
    ["support の .tsx", "apps/backend/api-specs/x/support.tsx"],
    ["support のテスト", "apps/backend/api-specs/x/support.test.ts"],
    ["api-specs/ の .md", "apps/backend/api-specs/x/README.md"],
    [".api-spec の無いテスト", "apps/backend/api-specs/x/create-x.test.ts"],
    [".tsx の step", "apps/backend/api-specs/x/create-x.api-spec.test.tsx"],
    [
      ".feature の後ろに拡張子を足したもの（.feature.md）",
      "apps/backend/api-specs/x/create-x.feature.md",
    ],
    [
      "api-specs/ の下の API ジャーニー",
      "apps/backend/api-specs/x/x.api-journey.test.ts",
    ],
    [
      "presentation の隣の step",
      "apps/backend/features/x/internal/presentation/create-x.api-spec.test.ts",
    ],
    [
      "api-journeys/ の step",
      "apps/backend/api-journeys/create-x.api-spec.test.ts",
    ],
    [
      "api-specs の前方一致だけの別ディレクトリの step",
      "apps/backend/api-specs-x/x/create-x.api-spec.test.ts",
    ],
    [
      "frontend の step（.tsx）",
      "apps/frontend_customer/features/x/x.api-spec.test.tsx",
    ],
    ["E2E の step（.js）", "apps/e2e/x.api-spec.test.js"],
  ])("%s は違反", (_name, path) => {
    expect(isMisplacedApiSpecFile(path)).toBe(true);
  });
});

describe("api ファイルと API 仕様の対（findPairViolations）", () => {
  const files = (...paths: string[]) => new Set(paths);

  it.each([
    [
      "api と .feature と step の 3 つがそろう（api）",
      API,
      files(API, FEATURE, STEPS),
    ],
    [
      "api と .feature と step の 3 つがそろう（.feature）",
      FEATURE,
      files(API, FEATURE, STEPS),
    ],
    [
      "api と .feature と step の 3 つがそろう（step）",
      STEPS,
      files(API, FEATURE, STEPS),
    ],
    ["support.ts は対を要らない", SUPPORT, files(SUPPORT)],
    [
      "presentation の単体テストは api ファイルではない",
      "apps/backend/features/x/internal/presentation/create-x.api.test.ts",
      files(),
    ],
    [
      "presentation の外の .api.ts（shared/presentation）は対の対象外",
      "apps/backend/shared/presentation/x.api.ts",
      files(),
    ],
    [
      "置き場所の違反の .feature は見ない",
      "apps/backend/api-specs/x/nested/create-x.feature",
      files(),
    ],
  ])("%s は違反なし", (_name, path, set) => {
    expect(findPairViolations(path, set)).toEqual([]);
  });

  it.each([
    [
      "api に .feature と step の両方が無い（2 件）",
      API,
      files(API),
      [
        { rule: "api-spec-pair", note: `${FEATURE} が無い` },
        { rule: "api-spec-pair", note: `${STEPS} が無い` },
      ],
    ],
    [
      "api に step が無い（.feature だけ）",
      API,
      files(API, FEATURE),
      [{ rule: "api-spec-pair", note: `${STEPS} が無い` }],
    ],
    [
      "api に .feature が無い（step だけ）",
      API,
      files(API, STEPS),
      [{ rule: "api-spec-pair", note: `${FEATURE} が無い` }],
    ],
    [
      "api の無い .feature",
      FEATURE,
      files(FEATURE, STEPS),
      [{ rule: "api-spec-pair", note: `対の ${API} が無い` }],
    ],
    [
      "api の無い step",
      STEPS,
      files(FEATURE, STEPS),
      [{ rule: "api-spec-pair", note: `対の ${API} が無い` }],
    ],
    [
      "別の feature のディレクトリに置いた .feature（api は features/x）",
      "apps/backend/api-specs/y/create-x.feature",
      files(API, "apps/backend/api-specs/y/create-x.feature"),
      [
        {
          rule: "api-spec-pair",
          note: "対の apps/backend/features/y/internal/presentation/create-x.api.ts が無い",
        },
      ],
    ],
    [
      "api と名前の違う step（create-xs）",
      "apps/backend/api-specs/x/create-xs.api-spec.test.ts",
      files(API, "apps/backend/api-specs/x/create-xs.api-spec.test.ts"),
      [
        {
          rule: "api-spec-pair",
          note: "対の apps/backend/features/x/internal/presentation/create-xs.api.ts が無い",
        },
      ],
    ],
  ])("%s は違反", (_name, path, set, expected) => {
    expect(findPairViolations(path, set)).toEqual(expected);
  });
});

describe(".feature の中身（findApiSpecViolations）: must pass", () => {
  it.each([
    [
      "固定の見出しを一覧の順に並べた Scenario と `*` の step（見出しの レスポンス は禁止語でも可）",
      source(
        "Feature: Todo を作る",
        "",
        "  Scenario: 作成",
        "    * タイトルを渡すと、未完了の Todo が作られる",
        "  Scenario: レスポンス",
        '    * タイトル "牛乳を買う" で作ると、未完了の Todo が作られる',
        "",
        "  Scenario: ソート",
        "    * 作った順に並ぶ",
        "  Scenario: 検索",
        "    * 完了したものだけを選べる",
        "  Scenario: 記録",
        "    * 作ったことが履歴に残る",
        "    * 作った人が履歴に残る",
        "  Scenario: 副作用",
        "    * ほかの Todo は変わらない",
        "  Scenario: 異常系",
        "    * タイトルが空なら、空という理由で拒否される",
      ),
    ],
    [
      "# のコメント行（字下げも）・空行・Feature の見出しは禁止語があっても見ない",
      source(
        "# step の実装は DB の todos を SQL で読み、状態 201 と Problem Details の JSON を確かめる。",
        "Feature: POST /api/todos の API 仕様",
        "  Scenario: レスポンス",
        "    # 返り値の id・title・completed は step の実装が見る。",
        "",
        "    * Todo が作られる",
      ),
    ],
    [
      "3 桁の数の後ろが「文字」「件」「行」・Scenario の見出しの前後の空白・`*` の直後の改行",
      source(
        "Feature: x",
        "  Scenario:   異常系   ",
        "    * 101 文字のタイトルは長すぎると伝えられる",
        "    * 200件まで並ぶ",
        "    *",
      ),
    ],
    [
      "説明の行・表の行（禁止語なし）",
      source(
        "Feature: x",
        "  Todo を作る。",
        "  Scenario: レスポンス",
        "    Todo の作り方の説明。",
        "    * Todo が作られる",
        "      | タイトル |",
        "      | 牛乳を買う |",
      ),
    ],
    ["Scenario の無い .feature（Feature だけ）", "Feature: x\n"],
    [
      "改行が CR だけ（単独の \\r も行の区切り。vitest-cucumber の readline と同じ）",
      ["Feature: x", "  Scenario: レスポンス", "    * Todo が作られる"].join(
        "\r",
      ),
    ],
    [
      "行の途中の @（タグの行ではない）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "    * 宛先の @ の後ろが届く",
      ),
    ],
    [
      "改行が CRLF（見出しの行末の \\r を一覧との違いにしない）",
      [
        "Feature: x",
        "  Scenario: レスポンス",
        "    * Todo が作られる",
        "",
      ].join("\r\n"),
    ],
    [
      "書き込みの形（更新 / レスポンス / 記録 / 副作用 / 異常系）",
      source(
        "Feature: x",
        "  Scenario: 更新",
        "    * a",
        "  Scenario: レスポンス",
        "    * b",
        "  Scenario: 記録",
        "    * c",
        "  Scenario: 副作用",
        "    * d",
        "  Scenario: 異常系",
        "    * e",
      ),
    ],
    [
      "記録・副作用の無い書き込み（削除だけ）と、見出しを省いた順（削除 → 異常系）",
      source(
        "Feature: x",
        "  Scenario: 削除",
        "    * a",
        "  Scenario: 異常系",
        "    * b",
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findApiSpecViolations(FEATURE, text)).toEqual([]);
  });
});

describe(".feature の中身（findApiSpecViolations）: must reject", () => {
  it.each([
    [
      "一覧に無い見出し（一覧）・一覧の語に文字を足した見出し・空の見出し",
      source(
        "Feature: x",
        "  Scenario: 一覧",
        "    * a",
        "  Scenario: レスポンス（一覧）",
        "    * b",
        "  Scenario:",
        "    * c",
      ),
      [
        { rule: "api-spec-scenario-heading", line: 2 },
        { rule: "api-spec-scenario-heading", line: 4 },
        { rule: "api-spec-scenario-heading", line: 6 },
      ],
    ],
    [
      "同じ見出しの 2 つ目",
      source(
        "Feature: x",
        "  Scenario: 異常系",
        "    * a",
        "  Scenario: 異常系",
        "    * b",
      ),
      [{ rule: "api-spec-scenario-heading", line: 4 }],
    ],
    [
      "Scenario Outline / Scenario Template / Rule / Background / Example / Examples / Scenarios と # language:",
      source(
        "# language: ja",
        "Feature: x",
        "  Background: 前提",
        "  Rule: 規則",
        "  Scenario Outline: 例",
        "    Examples: 表",
        "  Scenario Template: 例",
        "    Scenarios: 表",
        "  Example: 例",
      ),
      [
        { rule: "api-spec-keyword", line: 1 },
        { rule: "api-spec-keyword", line: 3 },
        { rule: "api-spec-keyword", line: 4 },
        { rule: "api-spec-keyword", line: 5 },
        { rule: "api-spec-keyword", line: 6 },
        { rule: "api-spec-keyword", line: 7 },
        { rule: "api-spec-keyword", line: 8 },
        { rule: "api-spec-keyword", line: 9 },
      ],
    ],
    [
      "Given / When / Then / And / But の step（`*` と並べても、字下げが無くても）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "    * a",
        "    Given b",
        "    When c",
        "Then d",
        "    And e",
        "    But f",
      ),
      [
        { rule: "api-spec-step-star", line: 4 },
        { rule: "api-spec-step-star", line: 5 },
        { rule: "api-spec-step-star", line: 6 },
        { rule: "api-spec-step-star", line: 7 },
        { rule: "api-spec-step-star", line: 8 },
      ],
    ],
    [
      "`*` の無い Scenario（コメント・説明だけ、Given だけ、ファイル末尾の Scenario）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "    # * コメントの中の *",
        "    説明だけ",
        "  Scenario: ソート",
        "    Given a",
        "  Scenario: 異常系",
      ),
      [
        { rule: "api-spec-step-star", line: 2 },
        { rule: "api-spec-step-star", line: 5 },
        { rule: "api-spec-step-star", line: 6 },
        { rule: "api-spec-step-star", line: 7 },
      ],
    ],
    [
      "Scenario の外の `*` は Scenario の `*` に数えない（Background の後の `*`）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "  Background: 前提",
        "    * a",
      ),
      [
        { rule: "api-spec-step-star", line: 2 },
        { rule: "api-spec-keyword", line: 3 },
      ],
    ],
    [
      "`*` の step・説明の行・表の行の禁止語（DB・状態コードの 3 桁・id。大文字小文字を区別しない）",
      source(
        "Feature: x",
        "  Todo を Db に書く。",
        "  Scenario: レスポンス",
        "    * 201 で返る",
        "      | id |",
        "    * 状態 404 になる",
      ),
      [
        { rule: "api-spec-business-language", line: 2 },
        { rule: "api-spec-business-language", line: 4 },
        { rule: "api-spec-business-language", line: 5 },
        { rule: "api-spec-business-language", line: 6 },
      ],
    ],
    [
      "`*` の step の変更の記録（Writer が自動で残す技術の仕組み。変更の記録・変更履歴・change log の区切りと単数形）",
      source(
        "Feature: x",
        "  Scenario: 異常系",
        "    * 変更の記録に作成が残る",
        "    * 変更履歴は増えない",
        "    * change-log が 1 件足される",
        "    * Change Logs は残る",
      ),
      [
        { rule: "api-spec-business-language", line: 3 },
        { rule: "api-spec-business-language", line: 4 },
        { rule: "api-spec-business-language", line: 5 },
        { rule: "api-spec-business-language", line: 6 },
      ],
    ],
    [
      "見出し以外のキーワードの行・Given の行も禁止語を見る（同じ行なら規則の順）",
      source(
        "Feature: x",
        "  Rule: レスポンス",
        "  Scenario: 異常系",
        "    * a",
        "    Given DB が空",
      ),
      [
        { rule: "api-spec-keyword", line: 2 },
        { rule: "api-spec-business-language", line: 2 },
        { rule: "api-spec-step-star", line: 5 },
        { rule: "api-spec-business-language", line: 5 },
      ],
    ],
    [
      "単独の CR で区切った行も 1 行ずつ見る（見出し・step・禁止語）",
      ["Feature: x", "  Scenario: 一覧", "    Given DB が空"].join("\r"),
      [
        { rule: "api-spec-scenario-heading", line: 2 },
        { rule: "api-spec-step-star", line: 2 },
        { rule: "api-spec-step-star", line: 3 },
        { rule: "api-spec-business-language", line: 3 },
      ],
    ],
    [
      "@ のタグの行（@ignore・字下げ・複数のタグ・Feature の前）",
      source(
        "@ignore",
        "Feature: x",
        "  @skip @wip",
        "  Scenario: レスポンス",
        "    * a",
        "    @only",
      ),
      [
        { rule: "api-spec-tag", line: 1 },
        { rule: "api-spec-tag", line: 3 },
        { rule: "api-spec-tag", line: 6 },
      ],
    ],
    [
      "メインの変更（作成 / 更新 / 削除）の見出しが無いのに、記録・副作用がある（最初の 1 つの行）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "    * a",
        "  Scenario: 記録",
        "    * b",
        "  Scenario: 副作用",
        "    * c",
      ),
      [{ rule: "api-spec-write-heading", line: 4 }],
    ],
    [
      "副作用だけがあり、メインの変更の見出しが無い",
      source("Feature: x", "  Scenario: 副作用", "    * a"),
      [{ rule: "api-spec-write-heading", line: 2 }],
    ],
    [
      "メインの変更の見出しが 2 つ以上（作成と更新と削除。2 つ目と 3 つ目の行）",
      source(
        "Feature: x",
        "  Scenario: 作成",
        "    * a",
        "  Scenario: 更新",
        "    * b",
        "  Scenario: 削除",
        "    * c",
      ),
      [
        { rule: "api-spec-write-heading", line: 4 },
        { rule: "api-spec-write-heading", line: 6 },
      ],
    ],
    [
      "一覧の順に並んでいない見出し（レスポンスの後の作成・異常系の後の記録）",
      source(
        "Feature: x",
        "  Scenario: レスポンス",
        "    * a",
        "  Scenario: 作成",
        "    * b",
        "  Scenario: 異常系",
        "    * c",
        "  Scenario: 記録",
        "    * d",
      ),
      [
        { rule: "api-spec-scenario-order", line: 4 },
        { rule: "api-spec-scenario-order", line: 8 },
      ],
    ],
    [
      "同じ見出しの 2 つ目は見出しの違反だけ（順・メインの変更の違反にしない）",
      source(
        "Feature: x",
        "  Scenario: 更新",
        "    * a",
        "  Scenario: 更新",
        "    * b",
      ),
      [{ rule: "api-spec-scenario-heading", line: 4 }],
    ],
    [
      "同じ見出しの 2 つ目が一覧で前でも、順の違反にしない（更新 → レスポンス → 更新）",
      source(
        "Feature: x",
        "  Scenario: 更新",
        "    * a",
        "  Scenario: レスポンス",
        "    * b",
        "  Scenario: 更新",
        "    * c",
      ),
      [{ rule: "api-spec-scenario-heading", line: 6 }],
    ],
    [
      "一覧に無い見出しは順に数えない（異常系 → 一覧）",
      source(
        "Feature: x",
        "  Scenario: 異常系",
        "    * a",
        "  Scenario: 一覧",
        "    * b",
      ),
      [{ rule: "api-spec-scenario-heading", line: 4 }],
    ],
    [
      "順は直前の見出しだけでなく、それまでで一覧の最も後ろの見出しと比べる（異常系 → 作成 → レスポンス）",
      source(
        "Feature: x",
        "  Scenario: 異常系",
        "    * a",
        "  Scenario: 作成",
        "    * b",
        "  Scenario: レスポンス",
        "    * c",
      ),
      [
        { rule: "api-spec-scenario-order", line: 4 },
        { rule: "api-spec-scenario-order", line: 6 },
      ],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findApiSpecViolations(FEATURE, text)).toEqual(expected);
  });
});

describe("step の実装の中身（findApiSpecViolations）: must pass", () => {
  it.each([
    ["実 DB と対の api を値で import", source(...REQUIRED_IMPORTS)],
    [
      "複数行の import・type の混じった import・@repo/backend/ の書き方・拡張子付き",
      source(
        "import {",
        "  createTestDatabase,",
        "  type TestDatabase,",
        '} from "@repo/backend/test-support/database";',
        "import {",
        "  CreateXApi,",
        "  type CreateXResponse,",
        '} from "@repo/backend/features/x/internal/presentation/create-x.api.ts";',
      ),
    ],
    [
      "ほかの api（型だけ）・Postgres の Repository・support.ts の対の組み立て・vitest-cucumber を足して import",
      source(
        ...REQUIRED_IMPORTS,
        'import type { ListXResponse } from "../../features/x/internal/presentation/list-x.api";',
        'import { PostgresXRepository } from "../../features/x/internal/infra/x-repository.postgres";',
        'import { createXApi } from "./support";',
        'import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";',
      ),
    ],
    [
      "vitest から vi 以外と、型だけ（import type・inline の type）を import",
      source(
        ...REQUIRED_IMPORTS,
        'import { afterAll, beforeAll, expect } from "vitest";',
        'import type { Mock } from "vitest";',
        'import type * as V from "vitest";',
        'import { type MockInstance, type vi } from "vitest";',
      ),
    ],
    [
      "コメントの中の vi・InMemory の import",
      source(
        ...REQUIRED_IMPORTS,
        '// import { vi } from "vitest";',
        '/* import { InMemoryXRepository } from "../../test-support/x/x-repository.in-memory"; */',
      ),
    ],
    [
      "対の api を型だけで import（import type・inline の type だけ。組み立ては support.ts）",
      source(
        DATABASE_IMPORT,
        'import type { CreateXResponse } from "../../features/x/internal/presentation/create-x.api";',
      ),
    ],
    [
      "対の api を inline の type だけで import（@repo/backend/ の書き方）",
      source(
        DATABASE_IMPORT,
        'import { type CreateXResponse } from "@repo/backend/features/x/internal/presentation/create-x.api";',
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
  ])("%s は違反なし", (_name, text) => {
    expect(findApiSpecViolations(STEPS, source(text, LOAD_FEATURE))).toEqual(
      [],
    );
  });

  it("api ファイルは中身を見ない", () => {
    expect(
      findApiSpecViolations(API, source('import { vi } from "vitest";')),
    ).toEqual([]);
  });
});

describe("step の実装の中身（findApiSpecViolations）: must reject", () => {
  it.each([
    [
      "vitest から vi・vi の別名・vitest（vi の別名）・名前空間・既定の import・dynamic import()",
      source(
        ...REQUIRED_IMPORTS,
        'import { expect, vi } from "vitest";',
        'import { vi as v } from "vitest";',
        'import { vitest } from "vitest";',
        'import * as V from "vitest";',
        'import V2 from "vitest";',
        'const m = await import("vitest");',
      ),
      [3, 4, 5, 6, 7, 8].map((line) => ({ rule: "api-spec-no-vi", line })),
    ],
    [
      "*.in-memory の値の import・import type・dynamic import()・export … from・拡張子付き",
      source(
        ...REQUIRED_IMPORTS,
        'import { InMemoryXRepository } from "../../test-support/x/x-repository.in-memory";',
        'import type { InMemoryXRepository as T } from "../../test-support/x/x-repository.in-memory";',
        'const m = await import("../../test-support/x/x-repository.in-memory");',
        'export { InMemoryXRepository } from "../../test-support/x/x-repository.in-memory.ts";',
      ),
      [3, 4, 5, 6].map((line) => ({ rule: "api-spec-no-in-memory", line })),
    ],
    [
      "test-support/database の import が無い",
      source(OWN_API_IMPORT),
      [{ rule: "api-spec-uses-real-database" }],
    ],
    [
      "test-support/database を型だけで import（import type・inline の type だけ）",
      source(
        OWN_API_IMPORT,
        'import type { TestDatabase } from "../../test-support/database";',
        'import { type TestDatabase as D } from "../../test-support/database";',
      ),
      [{ rule: "api-spec-uses-real-database" }],
    ],
    [
      "名前・場所の一部だけが同じ別のモジュール（database-x・別の場所の test-support/database）",
      source(
        OWN_API_IMPORT,
        'import { a } from "../../test-support/database-x";',
        'import { b } from "./test-support/database";',
      ),
      [{ rule: "api-spec-uses-real-database" }],
    ],
    [
      "対の api の import が無い（ほかの api だけ）",
      source(
        DATABASE_IMPORT,
        'import type { ListXApi } from "../../features/x/internal/presentation/list-x.api";',
      ),
      [{ rule: "api-spec-uses-own-api" }],
    ],
    [
      "別の feature の同じ名前の api・api でない同じ名前のモジュール・dynamic import()・export … from・コメントの中の import",
      source(
        DATABASE_IMPORT,
        'import type { CreateXApi as Y } from "../../features/y/internal/presentation/create-x.api";',
        'import { a } from "../../features/x/internal/application/create-x.command";',
        'const m = await import("../../features/x/internal/presentation/create-x.api");',
        'export type { CreateXResponse } from "../../features/x/internal/presentation/create-x.api";',
        '// import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
      ),
      [{ rule: "api-spec-uses-own-api" }],
    ],
    [
      "import が何も無い（ファイル全体の違反 2 つ）",
      source("const a = 1;"),
      [
        { rule: "api-spec-uses-real-database" },
        { rule: "api-spec-uses-own-api" },
      ],
    ],
    [
      "vi と InMemory と必須の欠け（行の順、その後にファイル全体の違反）",
      source(
        'import { InMemoryXRepository } from "../../test-support/x/x-repository.in-memory";',
        'import { vi } from "vitest";',
      ),
      [
        { rule: "api-spec-no-in-memory", line: 1 },
        { rule: "api-spec-no-vi", line: 2 },
        { rule: "api-spec-uses-real-database" },
        { rule: "api-spec-uses-own-api" },
      ],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findApiSpecViolations(STEPS, source(text, LOAD_FEATURE))).toEqual(
      expected,
    );
  });

  it("置き場所が違えば置き場所の違反だけを返す（中身は見ない）", () => {
    expect(
      findApiSpecViolations(
        "apps/backend/api-specs/x/nested/create-x.feature",
        source("Feature: DB", "  Scenario: 一覧", "    Given 状態 201"),
      ),
    ).toEqual([{ rule: "api-spec-placement" }]);
  });
});

describe("step の実装が呼べる API（findApiSpecViolations の api-spec-own-api-only）", () => {
  it.each([
    [
      "support.ts から対の組み立て（create-x → createXApi）と補助を import（別名・拡張子付き・複数行も）",
      source(
        ...REQUIRED_IMPORTS,
        'import { createXApi, jsonRequest } from "./support";',
        'import { createXApi as post } from "./support.ts";',
        "import {",
        "  bodylessRequest,",
        "  createXApi,",
        "  todoRowOf,",
        '} from "./support";',
      ),
    ],
    [
      "support.ts から Api で終わらない名前・型だけの名前（import type・inline の type）を import",
      source(
        ...REQUIRED_IMPORTS,
        'import { todoResponseOf, xApis } from "./support";',
        'import type { ListXApi } from "./support";',
        'import { type GetXApi, createXApi } from "./support";',
      ),
    ],
    [
      "ほかの api（別の feature も）を型だけで import（import type・inline の type だけ）・副作用だけの import",
      source(
        ...REQUIRED_IMPORTS,
        'import type { ListXResponse } from "../../features/x/internal/presentation/list-x.api";',
        'import { type GetYResponse } from "../../features/y/internal/presentation/get-y.api";',
        'import "./support";',
      ),
    ],
    [
      "コメント・文字列の中の import と呼び出し",
      source(
        ...REQUIRED_IMPORTS,
        '// import { listXApi } from "./support";',
        '/* import { ListXApi } from "../../features/x/internal/presentation/list-x.api"; */',
        'const text = "import { listXApi } from ./support";',
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findApiSpecViolations(STEPS, source(text, LOAD_FEATURE))).toEqual(
      [],
    );
  });

  it.each([
    [
      "support.ts からほかの API の組み立てを import（対の組み立てと一緒・別名・複数行）",
      source(
        ...REQUIRED_IMPORTS,
        'import { listXApi } from "./support";',
        'import { createXApi, getXApi as get } from "./support";',
        "import {",
        "  jsonRequest,",
        "  deleteXApi,",
        '} from "./support";',
      ),
      [3, 4, 8],
    ],
    [
      "support.ts を名前空間・既定の import・dynamic import() で読む（どの組み立てでも取り出せる）",
      source(
        ...REQUIRED_IMPORTS,
        'import * as support from "./support";',
        'import support2 from "./support";',
        'const m = await import("./support");',
      ),
      [3, 4, 5],
    ],
    [
      "ほかの feature の support.ts から組み立てを import（拡張子付きも）",
      source(
        ...REQUIRED_IMPORTS,
        'import { getYApi } from "../y/support";',
        'import { createXApi } from "../y/support.ts";',
      ),
      [3, 4],
    ],
    [
      "ほかの api を値で import（同じ feature・別の feature・@repo/backend/・拡張子付き・dynamic import()）",
      source(
        ...REQUIRED_IMPORTS,
        'import { ListXApi } from "../../features/x/internal/presentation/list-x.api";',
        'import { GetYApi } from "@repo/backend/features/y/internal/presentation/get-y.api.ts";',
        'import { DeleteXApi, type DeleteXResponse } from "../../features/x/internal/presentation/delete-x.api";',
        'const m = await import("../../features/x/internal/presentation/list-x.api");',
      ),
      [3, 4, 5, 6],
    ],
  ])("%s は違反", (_name, text, lines) => {
    expect(findApiSpecViolations(STEPS, source(text, LOAD_FEATURE))).toEqual(
      lines.map((line) => ({ rule: "api-spec-own-api-only", line })),
    );
  });

  it("対の組み立ての名前は api ファイルの名前の camelCase に Api を足したもの（change-x-completion → changeXCompletionApi）", () => {
    const path =
      "apps/backend/api-specs/x/change-x-completion.api-spec.test.ts";
    const text = (name: string) =>
      source(
        DATABASE_IMPORT,
        'import type { A } from "../../features/x/internal/presentation/change-x-completion.api";',
        `import { ${name} } from "./support";`,
        'const feature = await loadFeature("./change-x-completion.feature");',
      );
    expect({
      own: findApiSpecViolations(path, text("changeXCompletionApi")),
      kebab: findApiSpecViolations(path, text("changeXcompletionApi")),
      create: findApiSpecViolations(path, text("createXApi")),
    }).toEqual({
      own: [],
      kebab: [{ rule: "api-spec-own-api-only", line: 3 }],
      create: [{ rule: "api-spec-own-api-only", line: 3 }],
    });
  });
});

describe("step の実装の loadFeature と skip（findApiSpecViolations）", () => {
  it.each([
    [
      "対の .feature を第 2 引数なしで読む",
      source(...REQUIRED_IMPORTS, LOAD_FEATURE),
    ],
    [
      "単一引用符・括弧の内側の空白・名前空間の import 経由",
      source(
        ...REQUIRED_IMPORTS,
        'import * as vc from "@amiceli/vitest-cucumber";',
        "const feature = await vc.loadFeature( './create-x.feature' );",
      ),
    ],
    [
      "コメント・文字列の中の setVitestCucumberConfiguration・別のパスの loadFeature・.skip(・@ignore",
      source(
        ...REQUIRED_IMPORTS,
        LOAD_FEATURE,
        '// setVitestCucumberConfiguration({ language: "ja" }); loadFeature("./x.feature"); Scenario.skip("a");',
        'const note = "Scenario.only( と includeTags は使わない";',
      ),
    ],
    [
      "skip・only を名前の一部に含むだけの識別子（skipped・.skipper・onlyOne）・スプレッド（...only）・.todo のプロパティ",
      source(
        ...REQUIRED_IMPORTS,
        LOAD_FEATURE,
        "const skipped = list.skipper(onlyOne);",
        "const x = { ...only, ...skip, todo: body.todo };",
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findApiSpecViolations(STEPS, text)).toEqual([]);
  });

  it.each([
    [
      "loadFeature が無い（ファイル全体）",
      source(...REQUIRED_IMPORTS),
      [{ rule: "api-spec-load-feature" }],
    ],
    [
      "第 2 引数（language）を渡す",
      source(
        ...REQUIRED_IMPORTS,
        'const feature = await loadFeature("./create-x.feature", { language: "ja" });',
      ),
      [
        { rule: "api-spec-load-feature", line: 3 },
        { rule: "api-spec-load-feature" },
      ],
    ],
    [
      "対でないパス（別の api・./ の無いもの・親のディレクトリ・テンプレートリテラル・変数）",
      source(
        ...REQUIRED_IMPORTS,
        'await loadFeature("./list-x.feature");',
        'await loadFeature("create-x.feature");',
        'await loadFeature("../x/create-x.feature");',
        "await loadFeature(`./create-x.feature`);",
        "await loadFeature(path);",
      ),
      [
        ...[3, 4, 5, 6, 7].map((line) => ({
          rule: "api-spec-load-feature" as const,
          line,
        })),
        { rule: "api-spec-load-feature" },
      ],
    ],
    [
      "対の loadFeature があっても、ほかの形の loadFeature・設定・別の読み込み口・別名の import は違反",
      source(
        ...REQUIRED_IMPORTS,
        LOAD_FEATURE,
        'const other = await loadFeature("./create-x.feature", options);',
        'import { setVitestCucumberConfiguration } from "@amiceli/vitest-cucumber";',
        'setVitestCucumberConfiguration({ language: "ja" });',
        'import { loadFeature as lf } from "@amiceli/vitest-cucumber";',
        'const f = loadFeatureFromText("Feature: x");',
        'defineFeature("x", () => {});',
      ),
      [4, 5, 6, 7, 8, 9].map((line) => ({
        rule: "api-spec-load-feature",
        line,
      })),
    ],
    [
      "skip・only・skipIf・runIf（Scenario・Feature・Background・it・空白を挟むもの・?.）とタグの絞り込み",
      source(
        ...REQUIRED_IMPORTS,
        LOAD_FEATURE,
        'Scenario.skip("レスポンス", () => {});',
        'Scenario.only("レスポンス", () => {});',
        "describeFeature.skip(feature, () => {});",
        "Background . skip(() => {});",
        'it.skipIf(true)("a", () => {});',
        'Scenario?.skip("a", () => {});',
        'it.runIf(false)("a", () => {});',
        'describeFeature(feature, () => {}, { excludeTags: ["x"] });',
        'describeFeature(feature, () => {}, { includeTags: ["x"] });',
      ),
      [4, 5, 6, 7, 8, 9, 10, 11, 12].map((line) => ({
        rule: "api-spec-no-skip",
        line,
      })),
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findApiSpecViolations(STEPS, text)).toEqual(expected);
  });
});

describe("補助 support.ts の中身（findApiSpecViolations）", () => {
  it.each([
    [
      "自 feature の api を 1 つ値で import（vitest の expect・drizzle など api 以外の import もあってよい）",
      source(
        'import { expect } from "vitest";',
        'import { sql } from "drizzle-orm";',
        'import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
      ),
    ],
    [
      "複数の api・type の混じった import・@repo/backend/ の書き方・拡張子付き",
      source(
        "import {",
        "  CreateXApi,",
        "  type CreateXResponse,",
        '} from "@repo/backend/features/x/internal/presentation/create-x.api.ts";',
        'import { ListXApi } from "../../features/x/internal/presentation/list-x.api";',
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findApiSpecViolations(SUPPORT, text)).toEqual([]);
  });

  it.each([
    ["import が何も無い", source("export const a = 1;")],
    [
      "api を型だけで import（import type・inline の type だけ）",
      source(
        'import type { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
        'import { type ListXApi } from "../../features/x/internal/presentation/list-x.api";',
      ),
    ],
    [
      "別の feature の api・presentation の api でないモジュール・入れ子の api・api のテスト・前方一致だけの別 feature",
      source(
        'import { CreateYApi } from "../../features/y/internal/presentation/create-y.api";',
        'import { a } from "../../features/x/internal/presentation/x-schema";',
        'import { b } from "../../features/x/internal/application/create-x.command";',
        'import { c } from "../../features/x/internal/presentation/nested/create-x.api";',
        'import { d } from "../../features/x/internal/presentation/create-x.api.test";',
        'import { e } from "../../features/x-extra/internal/presentation/create-x.api";',
      ),
    ],
    [
      "dynamic import()・export … from・コメントの中の import",
      source(
        'const m = await import("../../features/x/internal/presentation/create-x.api");',
        'export { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
        '// import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
      ),
    ],
  ])("%s は違反", (_name, text) => {
    expect(findApiSpecViolations(SUPPORT, text)).toEqual([
      { rule: "api-spec-support-assembles-apis" },
    ]);
  });

  it("vitest から vi を import すれば、その行の違反（step と同じ判定。api を組み立てていても）", () => {
    expect(
      findApiSpecViolations(
        SUPPORT,
        source(
          'import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
          'import { expect, vi } from "vitest";',
          'const m = await import("vitest");',
        ),
      ),
    ).toEqual([
      { rule: "api-spec-no-vi", line: 2 },
      { rule: "api-spec-no-vi", line: 3 },
    ]);
  });
});

// --- 補助 support.ts の組み立て（api-spec-support-no-api-call・api-spec-support-assembler-per-api） ---
// support.ts の値の import を満たす冒頭（create-x と list-x の api を値で import）。中身の例はこの後ろに足す（行は 3 から）。
const SUPPORT_IMPORTS = [
  'import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";',
  'import { ListXApi } from "../../features/x/internal/presentation/list-x.api";',
];

describe("補助 support.ts の組み立て（findApiSpecViolations）: must pass", () => {
  it.each([
    [
      "API ごとの組み立て関数（名前は Api のクラス名の先頭を小文字にしたもの）が、その Api を 1 つだけ new して handle を返す",
      source(
        ...SUPPORT_IMPORTS,
        "export function createXApi(db: Database) {",
        "  return new CreateXApi(new CreateXCommand(new PostgresXRepository(db))).handle;",
        "}",
        "export async function listXApi(db: Database, notify: (m: string) => void) {",
        "  return new ListXApi(new ListXQuery(db, notify)).handle;",
        "}",
      ),
    ],
    [
      "組み立て関数の型の参照（typeof・ReturnType）・Api で終わらない関数の呼び出し・handle の参照（呼ばない）",
      source(
        ...SUPPORT_IMPORTS,
        "export function createXApi<T>(db: Database) {",
        "  return new CreateXApi(new CreateXCommand(db)).handle;",
        "}",
        "export type Post = ReturnType<typeof createXApi>;",
        "export function jsonRequest(body: unknown): Request {",
        '  return new Request("http://localhost", { body: JSON.stringify(body) });',
        "}",
        'export const pick = (api: Pick<CreateXApi, "handle">) => api.handle;',
      ),
    ],
    [
      "コメント・文字列の中の呼び出しと new",
      source(
        ...SUPPORT_IMPORTS,
        "// const post = createXApi(db); await post.handle(request);",
        "/* new ListXApi(query) */",
        'const text = "createXApi(db).handle(request) new ListXApi(";',
      ),
    ],
  ])("%s は違反なし", (_name, text) => {
    expect(findApiSpecViolations(SUPPORT, text)).toEqual([]);
  });
});

describe("補助 support.ts の組み立て（findApiSpecViolations）: must reject", () => {
  it.each<[string, string, ApiSpecViolation[]]>([
    [
      "handler を呼ぶ（.handle(・?.handle(・空白を挟む・.handle.call( / .apply( / .bind(）",
      source(
        ...SUPPORT_IMPORTS,
        "export function createXApi(db: Database) {",
        "  return new CreateXApi(new CreateXCommand(db)).handle(request);",
        "}",
        "export async function seed(api?: CreateXApi) {",
        "  await api?.handle(request);",
        "  await api.handle (request);",
        "  await api.handle.call(undefined, request);",
        "  await api.handle.apply(api, [request]);",
        "  api.handle.bind(api)(request);",
        "}",
      ),
      [4, 7, 8, 9, 10, 11].map((line) => ({
        rule: "api-spec-support-no-api-call",
        line,
      })),
    ],
    [
      "組み立て関数・Api で終わる名前を呼ぶ（型引数付き・optional call・メソッド・Api のクラスを new せずに呼ぶ）",
      source(
        ...SUPPORT_IMPORTS,
        "export async function createTodo(db: Database) {",
        "  const post = createXApi(db);",
        "  const list = listXApi<T>(db);",
        "  await apis.postXApi(request);",
        "  return CreateXApi(db);",
        "  const get = getXApi?.(db);",
        "}",
      ),
      [4, 5, 6, 7, 8].map((line) => ({
        rule: "api-spec-support-no-api-call",
        line,
      })),
    ],
    [
      "1 つの関数ですべての Api を組み立てる（todoApis のような形。2 つ目以降も名前の違いも違反）",
      source(
        ...SUPPORT_IMPORTS,
        "export function xApis(db: Database) {",
        "  return {",
        "    postX: new CreateXApi(new CreateXCommand(db)).handle,",
        "    listX: new ListXApi(new ListXQuery(db)).handle,",
        "  };",
        "}",
      ),
      [5, 6].map((line) => ({
        rule: "api-spec-support-assembler-per-api",
        line,
      })),
    ],
    [
      "組み立て関数の名前が Api のクラスと違う・同じ関数で 2 つ new する",
      source(
        ...SUPPORT_IMPORTS,
        "export function listXApi(db: Database) {",
        "  return new CreateXApi(new CreateXCommand(db)).handle;",
        "}",
        "export function createXApi(db: Database) {",
        "  return [new CreateXApi(a).handle, new CreateXApi(b).handle];",
        "}",
      ),
      [4, 7].map((line) => ({
        rule: "api-spec-support-assembler-per-api",
        line,
      })),
    ],
    [
      "function の宣言でない場所（最上位・アロー関数）で new する",
      source(
        ...SUPPORT_IMPORTS,
        "const post = new CreateXApi(new CreateXCommand(db)).handle;",
        "export const listXApi = (db: Database) => new ListXApi(new ListXQuery(db)).handle;",
      ),
      [3, 4].map((line) => ({
        rule: "api-spec-support-assembler-per-api",
        line,
      })),
    ],
    [
      "呼び出しと組み立ての違反と vi の import（行の順）",
      source(
        ...SUPPORT_IMPORTS,
        'import { vi } from "vitest";',
        "export function xApis(db: Database) {",
        "  return new CreateXApi(db).handle(request);",
        "}",
      ),
      [
        { rule: "api-spec-no-vi", line: 3 },
        { rule: "api-spec-support-assembler-per-api", line: 5 },
        { rule: "api-spec-support-no-api-call", line: 5 },
      ],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findApiSpecViolations(SUPPORT, text)).toEqual(expected);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（api-specs/ の下・外の *.api-spec.test.*・api ファイルの見つけ方）が漏れれば見逃す。一時
//   ディレクトリに架空のツリーを置き、本番と同じ collectApiSpecViolations に通して、違反の集合を丸ごと比較する。
describe("API 仕様の列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "api-spec-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  const presentation = "apps/backend/features/x/internal/presentation";
  const specs = "apps/backend/api-specs/x";
  const goodFeature = source(
    "Feature: x",
    "  Scenario: レスポンス",
    "    * 作られる",
  );
  // api-specs/x/<name>.api-spec.test.ts の必須の import（実 DB と対の api）。
  const stepsFor = (name: string, ...extra: string[]) =>
    source(
      DATABASE_IMPORT,
      `import type { A } from "../../features/x/internal/presentation/${name}.api";`,
      ...extra,
      `const feature = await loadFeature("./${name}.feature");`,
    );

  it("api-specs/ の下・外の *.api-spec.test.*・api ファイルを対象にし、違反を「規則: パス(:行)（無いファイル）」で返す", () => {
    const root = fixture({
      // 対がそろい、中身も違反なし（support.ts も）。
      [`${presentation}/create-x.api.ts`]: "export class CreateXApi {}\n",
      [`${specs}/create-x.feature`]: goodFeature,
      [`${specs}/create-x.api-spec.test.ts`]: stepsFor("create-x"),
      [`${specs}/support.ts`]: source(
        'import { expect } from "vitest";',
        `import { CreateXApi } from "../../features/x/internal/presentation/create-x.api";`,
      ),
      // 補助の違反: 自 feature の api を型だけで import（組み立てていない）。
      "apps/backend/api-specs/y/support.ts": source(
        'import type { CreateYApi } from "../../features/y/internal/presentation/create-y.api";',
      ),
      // 補助の違反: すべての Api を 1 つの関数で組み立て、組み立て関数を呼ぶ（前提を API で作る口）。
      "apps/backend/api-specs/z/support.ts": source(
        'import { CreateZApi } from "../../features/z/internal/presentation/create-z.api";',
        "export function zApis(db) {",
        "  return new CreateZApi(db).handle;",
        "}",
        "export async function seed(db) {",
        '  return createZApi(db)(new Request("http://localhost"));',
        "}",
      ),
      // 対がそろうが、.feature と step の中身が違反。
      [`${presentation}/list-x.api.ts`]: "export class ListXApi {}\n",
      [`${specs}/list-x.feature`]: source(
        "Feature: x",
        "  Scenario: 一覧",
        "    Given DB が空",
        "  @ignore",
      ),
      [`${specs}/list-x.api-spec.test.ts`]: stepsFor(
        "list-x",
        'import { vi } from "vitest";',
        'Scenario.skip("a", () => {});',
        'import { createXApi } from "./support";',
      ),
      // 対の違反: api だけ（.feature と step が無い）、.feature だけ、api の無い step。
      [`${presentation}/delete-x.api.ts`]: "export class DeleteXApi {}\n",
      [`${presentation}/get-x.api.ts`]: "export class GetXApi {}\n",
      [`${specs}/get-x.feature`]: goodFeature,
      [`${specs}/rename-x.api-spec.test.ts`]: stepsFor("rename-x"),
      // 置き場所の違反: 補助の別名・サブディレクトリ・直下・外の step。
      [`${specs}/helper.ts`]: "export const a = 1;\n",
      [`${specs}/nested/create-x.feature`]: "Feature: DB\n",
      "apps/backend/api-specs/support.ts": "export const a = 1;\n",
      [`${presentation}/create-x.api-spec.test.ts`]: "",
      "apps/frontend_customer/x.api-spec.test.tsx": "",
      // 対象外: presentation の単体テスト・api-journeys・node_modules と . で始まるディレクトリの中。
      [`${presentation}/create-x.api.test.ts`]:
        'import { vi } from "vitest";\n',
      "apps/backend/api-journeys/x.feature": "Feature: DB\n",
      "apps/backend/node_modules/x/x.api-spec.test.ts": "",
      "apps/frontend_customer/.next/x.api-spec.test.ts": "",
    });
    expect({
      files: listApiSpecTargets(root),
      violations: collectApiSpecViolations(root),
    }).toEqual({
      files: [
        "apps/backend/api-specs/support.ts",
        "apps/backend/api-specs/x/create-x.api-spec.test.ts",
        "apps/backend/api-specs/x/create-x.feature",
        "apps/backend/api-specs/x/get-x.feature",
        "apps/backend/api-specs/x/helper.ts",
        "apps/backend/api-specs/x/list-x.api-spec.test.ts",
        "apps/backend/api-specs/x/list-x.feature",
        "apps/backend/api-specs/x/nested/create-x.feature",
        "apps/backend/api-specs/x/rename-x.api-spec.test.ts",
        "apps/backend/api-specs/x/support.ts",
        "apps/backend/api-specs/y/support.ts",
        "apps/backend/api-specs/z/support.ts",
        "apps/backend/features/x/internal/presentation/create-x.api-spec.test.ts",
        "apps/backend/features/x/internal/presentation/create-x.api.ts",
        "apps/backend/features/x/internal/presentation/delete-x.api.ts",
        "apps/backend/features/x/internal/presentation/get-x.api.ts",
        "apps/backend/features/x/internal/presentation/list-x.api.ts",
        "apps/frontend_customer/x.api-spec.test.tsx",
      ],
      violations: [
        "api-spec-placement: apps/backend/api-specs/support.ts",
        "api-spec-placement: apps/backend/api-specs/x/helper.ts",
        "api-spec-no-vi: apps/backend/api-specs/x/list-x.api-spec.test.ts:3",
        "api-spec-no-skip: apps/backend/api-specs/x/list-x.api-spec.test.ts:4",
        "api-spec-own-api-only: apps/backend/api-specs/x/list-x.api-spec.test.ts:5",
        "api-spec-scenario-heading: apps/backend/api-specs/x/list-x.feature:2",
        "api-spec-step-star: apps/backend/api-specs/x/list-x.feature:2",
        "api-spec-step-star: apps/backend/api-specs/x/list-x.feature:3",
        "api-spec-business-language: apps/backend/api-specs/x/list-x.feature:3",
        "api-spec-tag: apps/backend/api-specs/x/list-x.feature:4",
        "api-spec-placement: apps/backend/api-specs/x/nested/create-x.feature",
        "api-spec-pair: apps/backend/api-specs/x/rename-x.api-spec.test.ts（対の apps/backend/features/x/internal/presentation/rename-x.api.ts が無い）",
        "api-spec-support-assembles-apis: apps/backend/api-specs/y/support.ts",
        "api-spec-support-assembler-per-api: apps/backend/api-specs/z/support.ts:3",
        "api-spec-support-no-api-call: apps/backend/api-specs/z/support.ts:6",
        "api-spec-placement: apps/backend/features/x/internal/presentation/create-x.api-spec.test.ts",
        "api-spec-pair: apps/backend/features/x/internal/presentation/delete-x.api.ts（apps/backend/api-specs/x/delete-x.feature が無い）",
        "api-spec-pair: apps/backend/features/x/internal/presentation/delete-x.api.ts（apps/backend/api-specs/x/delete-x.api-spec.test.ts が無い）",
        "api-spec-pair: apps/backend/features/x/internal/presentation/get-x.api.ts（apps/backend/api-specs/x/get-x.api-spec.test.ts が無い）",
        "api-spec-placement: apps/frontend_customer/x.api-spec.test.tsx",
      ],
    });
  });

  it("apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listApiSpecTargets(root),
      violations: collectApiSpecViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("API 仕様（実ファイル）", () => {
  it("presentation の api ファイルごとに apps/backend/api-specs/<feature>/ に <api>.feature と <api>.api-spec.test.ts があり、.feature は固定の見出しの Scenario と `*` の step を業務の言葉だけで書き、step の実装は vi と InMemory を使わず、実 DB を使って対の api を参照し、対象でない API の handler を手に入れず、support.ts が api を値で API ごとに組み立て、handler を呼ばない", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    expect(listApiSpecTargets(repoRoot)).toEqual(
      expect.arrayContaining([
        "apps/backend/features/todo/internal/presentation/list-todos.api.ts",
        "apps/backend/api-specs/todo/list-todos.feature",
        "apps/backend/api-specs/todo/list-todos.api-spec.test.ts",
      ]),
    );
    expect(collectApiSpecViolations(repoRoot)).toEqual([]);
  });
});

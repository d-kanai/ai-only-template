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
import { featureLines } from "./feature-lines";

// domain 仕様（Issue #318。.claude/rules/quality/testing.md の domain 仕様の節）の置き場所と形を、ファイルの一覧とソースで機械的に
//   検査するテスト。
// domain 仕様 = Entity の業務ルールを、人が読む仕様として Gherkin の <name>.feature に業務の言葉で書き、step の実装
//   （<name>.domain-spec.test.ts）が domain のモジュールだけで確かめるテスト。`*` の 1 行 = 1 つの振る舞い = 1 つのテスト
//   （vitest-cucumber は step 1 つを Vitest の test 1 つにする。API 仕様と同じ）。
// 違反にするもの（規則）:
//   - domain-spec-placement: apps/backend/spec/domain/ の下には、<feature>/ の直下の <name>.feature と <name>.domain-spec.test.ts
//     だけを置く。spec/domain/ の直下のファイル・<feature>/ の下のサブディレクトリの中のファイル・ほかの種類のファイル（support.ts・
//     README.md・x.test.ts・.tsx）は違反。apps/ の下のほかの場所（features/<f>/・spec/api/ など）に *.domain-spec.test.* を置くのも違反。
//     WHY 置き場所を 1 か所にする: 人が読む業務ルールを feature ごとに 1 つのディレクトリで一覧でき、API 仕様（spec/api/）・
//       API ジャーニー（spec/journey/）と同じ spec/ の下に並ぶ。補助のファイルを置かせないのは、step を domain だけで書く
//       （domain-spec-pure）ので、組み立ての補助が要らないため。
//     WHY spec/domain/ の外の .feature はここで見ない: rule-tests/api-journey.test.ts の api-journey-placement が止める（spec/api/ と
//       spec/domain/ の下の .feature だけを例外にしている）。
//   - domain-spec-pair: spec/domain/<feature>/ の直下の <name>.feature には同じ場所の <name>.domain-spec.test.ts が要り、
//     <name>.domain-spec.test.ts には <name>.feature が要る（無いほうを、置いたファイルの違反にする）。置き場所の違反のファイルは見ない。
//     WHY: .feature だけでは何も実行されず（Vitest の include は *.test.ts）、書いた規則が検査されないまま残る。step のファイルだけだと
//       人が読む仕様が無い。step のファイルが対の .feature を読むことは domain-spec-load-feature が見る。
//   以下は .feature（spec/domain/<feature>/ の直下の *.feature）の中身の規則。行ごとに見る（行は 1 始まり。区切りは \r\n・\r・\n。
//   rule-tests/feature-lines.ts の featureLines。vitest-cucumber は readline で読み、単独の \r でも行を分けるため）:
//   - domain-spec-keyword: 使えるキーワードは `Feature:` / `Rule:` / `Scenario:` と `*` の step だけ。`Background:` /
//     `Scenario Outline:` / `Scenario Template:` / `Example:` / `Examples:` / `Scenarios:` の行、`Given` / `When` / `Then` / `And` /
//     `But` で始まる step の行、`# language:` の行は違反。
//     WHY: 形を「Feature → 説明 → Rule → 理由 → Scenario → `*` の step」の 1 通りにし、どの Entity の仕様も同じ場所を拾い読みできる
//       ようにする。Example は Scenario の別名で、Rule の下の Scenario の検査を逃れる。Background（共通の前提）と Outline（例の表）は、
//       `*` の 1 行で前提から確かめまで完結させる形と合わない（API 仕様の api-spec-keyword と同じ）。Given / When / Then を使わないのは、
//       step 1 つが前提から検証までの 1 テストで、フェーズは step の実装のフェーズコメントで表すため（rule-tests/test-phases.test.ts）。
//     WHY `# language:` も止める: 言語は loadFeature の第 2 引数と setVitestCucumberConfiguration で決まり（domain-spec-load-feature で
//       止める）、この行は実行に効かないが、Gherkin の慣習では言語の指定なので、別の言語のキーワードで書く意図を持ち込ませない
//       （API 仕様と同じ。reviewer の実測、Issue #219）。
//   - domain-spec-tag: `@` で始まる行（タグ。字下げの後）は違反。
//     WHY: vitest-cucumber は既定の excludeTags（`@ignore` など）が付いた Scenario を skip にし、仕様が黙って外れたまま緑になる
//       （API 仕様の api-spec-tag と同じ。reviewer の実測、Issue #219）。
//   - domain-spec-structure（仕様メモの強制。Issue #318 の主目的）: 次のどれかに当たれば違反（行は見出しか、その行）。
//     - `Feature:` の見出しが無い（ファイルの違反）・2 つ目の `Feature:`・`Feature:` より前の行（コメント・空行・タグ・言語の指定を除く）。
//     - `Feature:` の後、最初の `Rule:` の前に説明の行（キーワードでもコメントでも空行でもない行）が無い（Feature の行の違反）。
//     - `Rule:` が 1 つも無い（Feature の行の違反）。
//     - 各 `Rule:` の後、その最初の `Scenario:` の前に説明の行が無い・`Scenario:` が 1 つも無い（Rule の行の違反）。
//     - 最初の `Rule:` より前の `Scenario:`（Scenario の行の違反）。
//     - `*` の step が 1 つも無い `Scenario:`（Scenario の行の違反）。`Scenario:` の外（Feature や Rule の説明の位置）の `*` の step。
//     WHY Feature と Rule に説明を求める: domain 仕様は、Entity が何か（Feature の説明）と、規則ごとの理由（Rule の説明）を書き残す
//       仕様メモ。Scenario と step だけだと「何を受け付けるか」は読めても「なぜその規則か」が残らず、後で規則を変える人が背景を
//       知らずに変える（CLAUDE.md の 6. 変更前の背景確認）。コメント（`#`）は説明に数えない: 読者向けの文として残すため（コメントは
//       書き手のメモ）。
//     WHY Scenario を Rule の下に限る: 業務ルール 1 つ（Rule）ごとに、受け付ける例・拒否する例（Scenario）をまとめて読む形にする。
//   - domain-spec-business-language: `#` のコメント行と空行を除くすべての行（Feature / Rule / Scenario の見出し・説明・step。
//     違反のキーワードやタグの行も）に、rule-tests/feature-business-language.ts の禁止語が含まれると違反（1 行 1 件）。
//     WHY: .feature は業務の仕様として開発者でない人も読む（API ジャーニー・API 仕様と同じ語の一覧を共有する）。API 仕様と違い
//       見出しも見る: domain 仕様の見出しは固定の一覧ではなく、業務ルールの名前そのもの。
//   以下は step の実装（spec/domain/<feature>/ の直下の <name>.domain-spec.test.ts）の中身の規則:
//   - domain-spec-load-feature: `loadFeature("./<name>.feature")`（対の .feature を第 2 引数なしで読む。引用符は " か '。名前空間の
//     `x.loadFeature(` も同じ）の呼び出しが 1 つ以上要る（無ければファイルの違反）。それ以外の形の loadFeature の呼び出し（第 2 引数・
//     別のパス・テンプレートリテラル・変数）、`loadFeature as` の別名の import、setVitestCucumberConfiguration・loadFeatureFromText・
//     defineFeature の名前、`.skip` / `.only` / `.skipIf` / `.runIf`（直前が `.` のスプレッドは除く）と includeTags / excludeTags の
//     名前は、その行の違反。
//     WHY: 対の .feature を実行することを読み込みの形で確かめる。言語は第 2 引数と setVitestCucumberConfiguration で変わり（キーワードの
//       規則を別の言語ですり抜けられる）、loadFeatureFromText・defineFeature は .feature のファイルを読まない。skip した Scenario は
//       skipped のまま Vitest が成功で終わり、only はほかの Scenario を黙って止め、タグの絞り込みも Scenario を外しうる（API 仕様の
//       api-spec-load-feature / api-spec-no-skip と同じ。Biome の noSkippedTests は `RuleScenario.skip(` を止めない）。
//   - domain-spec-pure: *.in-memory（InMemory の Repository）と apps/backend/test-support/database（実 DB）を import しない（値・
//     `import type`・dynamic `import()`・`export … from` のどれも。相対パスと `@repo/backend/` の書き方のどちらも。その行の違反）。
//     同じ feature（ファイルの置き場所の <feature>）の apps/backend/features/<feature>/internal/domain/ の下のモジュールを、相対パスの
//     静的な import で 1 つ以上値として取り込む（無ければファイルの違反。型だけ・dynamic `import()`・`export … from` は数えない）。
//     WHY: domain 仕様は Entity の業務ルールを、DB も Repository も通さずに domain だけで確かめる（業務ルールは domain に閉じる。
//       .claude/rules/code/backend.md の DDD 4 層）。InMemory や実 DB を使うと、確かめているのが Entity の規則か保存の振る舞いかが
//       混ざる（保存は infra のテストと API 仕様が見る）。domain の値の import を求めるのは、仕様が実際の Entity を通らない（step の
//       中で期待値だけを書く）形を止めるため。
//     WHY 相対パスに限る: backend の中の import は相対パスだけ（rule-tests/architecture.test.ts の backend-relative-only）。
// コメントの扱い: .ts は行コメントとブロックコメントの中を見ない（文字列は残す）。loadFeature・skip の検査は文字列の中も見ない
//   （loadFeature の引数の文字列だけは対の形かを読む）。.feature はコメントの行（`#` で始まる行）を説明にも禁止語の対象にも数えない。
// 限界（字句の推定。rule-tests/api-spec.test.ts と同じ方式）:
//   - .feature: 行ごとに見るので、docstring（`"""`）の中も行の種類を区別しない（中の `#` の行はコメント、`Given` で始まる行は step
//     として扱う）。Scenario の中の説明の行・表の行・docstring は止めない（step の引数として読まれる）。表の行（`|`）と docstring の区切り（`"""`・```）は説明の行に数えない（区切りの間の行は説明に数える）。説明の行が業務ルールの理由に
//     なっているか・`*` の文が振る舞い 1 つかは見ない（reviewer が見る）。禁止語は一覧の語だけ。
//   - step の実装: import の文を正規表現で読むので、`require`・変数を渡す `import(x)` は見ない。domain の値の import は、取り込んだ値を
//     step の中で使っているかを見ない。domain 以外の層（application・infra・presentation）や vi の import は止めない（必要になったら
//     規則を足す）。loadFeature・skip は名前で見るので、`x["skip"](`・変数に入れ直した関数は見ない（逆に、同じ名前の別の関数・
//     プロパティ `.only` も違反にする）。step ごとに前提から確かめまで完結しているかは見ない（フェーズコメントは test-phases が見る）。
// WHY 文字列で判定する（AST にしない）: 見るのはパス・行の先頭のキーワード・import の参照先だけで、正規表現で足りる
//   （rule-tests/api-spec.test.ts と同じ）。
// WHY 判定の補助（stripComments・extractImports など）を rule-tests/api-spec.test.ts から import せずに持つ: テストファイルを import すると
//   その中の step も登録され、Biome の noExportsInTest も止める（rule-tests/feature-business-language.ts の冒頭）。

type DomainSpecRuleId =
  | "domain-spec-placement"
  | "domain-spec-pair"
  | "domain-spec-keyword"
  | "domain-spec-tag"
  | "domain-spec-structure"
  | "domain-spec-business-language"
  | "domain-spec-load-feature"
  | "domain-spec-pure";

// 同じ行の違反を並べる順（規則の一覧の順）。
const RULE_ORDER: readonly DomainSpecRuleId[] = [
  "domain-spec-placement",
  "domain-spec-pair",
  "domain-spec-keyword",
  "domain-spec-tag",
  "domain-spec-structure",
  "domain-spec-business-language",
  "domain-spec-load-feature",
  "domain-spec-pure",
];

// line: ソースの中の位置で決まる違反だけ持つ（1 始まり）。note: 違反の理由（構造の違反の種類・無いファイルなど）。
type DomainSpecViolation = {
  rule: DomainSpecRuleId;
  line?: number;
  note?: string;
};

const DOMAIN_SPECS_DIR = "apps/backend/spec/domain/";

// domain 仕様の .feature か（spec/domain/<feature>/ の直下の *.feature）。
function isDomainSpecFeatureFile(path: string): boolean {
  return /^apps\/backend\/spec\/domain\/[^/]+\/[^/]+\.feature$/.test(path);
}

// domain 仕様の step の実装か（spec/domain/<feature>/ の直下の *.domain-spec.test.ts）。
function isDomainSpecStepFile(path: string): boolean {
  return /^apps\/backend\/spec\/domain\/[^/]+\/[^/]+\.domain-spec\.test\.ts$/.test(
    path,
  );
}

// spec/domain/ の外で、置いてあれば置き場所の違反になる名前。WHY 拡張子を広く取る: .tsx・.js で外に置いても見つける。
const OUTSIDE_DOMAIN_SPEC_FILE = /\.domain-spec\.test\.[cm]?[jt]sx?$/;

// path（リポジトリ相対、/ 区切り）が置き場所の規則に違反するか（domain-spec-placement）。
function isMisplacedDomainSpecFile(path: string): boolean {
  if (path.startsWith(DOMAIN_SPECS_DIR)) {
    return !isDomainSpecFeatureFile(path) && !isDomainSpecStepFile(path);
  }
  return OUTSIDE_DOMAIN_SPEC_FILE.test(path);
}

// 対の違反（domain-spec-pair）。files は同じ列挙（listDomainSpecTargets）の結果。置き場所の違反のファイルは見ない。
function findPairViolations(
  path: string,
  files: ReadonlySet<string>,
): DomainSpecViolation[] {
  const pair = isDomainSpecFeatureFile(path)
    ? path.replace(/\.feature$/, ".domain-spec.test.ts")
    : isDomainSpecStepFile(path)
      ? path.replace(/\.domain-spec\.test\.ts$/, ".feature")
      : undefined;
  return pair === undefined || files.has(pair)
    ? []
    : [{ rule: "domain-spec-pair", note: `対の ${pair} が無い` }];
}

// .feature の 1 行の種類。blank: 空行。comment: `#` の行（language を除く）。language: `# language:` の行。tag: `@` で始まる行。
//   feature / rule / scenario: 使ってよい見出し。keyword: 使わない見出し（Background・Outline など）。keyword-step: `*` 以外の step。
//   star: `*` の step。text: それ以外（説明の行・表の行・docstring）。
type FeatureLineKind =
  | "blank"
  | "comment"
  | "language"
  | "tag"
  | "feature"
  | "rule"
  | "scenario"
  | "keyword"
  | "keyword-step"
  | "star"
  | "table"
  | "text";

function featureLineKind(line: string): FeatureLineKind {
  // WHY 行頭（字下げの後）の # だけをコメントにする: Gherkin のコメントは行全体だけで、行の途中の # は文の一部。
  if (/^\s*#\s*language\s*:/i.test(line)) return "language";
  if (/^\s*$/.test(line)) return "blank";
  if (/^\s*#/.test(line)) return "comment";
  if (/^\s*@/.test(line)) return "tag";
  if (/^\s*Feature\s*:/.test(line)) return "feature";
  if (/^\s*Rule\s*:/.test(line)) return "rule";
  if (/^\s*Scenario\s*:/.test(line)) return "scenario";
  if (
    /^\s*(?:Scenario Outline|Scenario Template|Background|Examples?|Scenarios)\s*:/.test(
      line,
    )
  ) {
    return "keyword";
  }
  if (/^\s*(?:Given|When|Then|And|But)(?:\s|$)/.test(line)) {
    return "keyword-step";
  }
  // WHY 表の行と docstring の区切りを説明の行と分ける: 説明の位置に表や docstring だけを置いても、規則の理由（仕様メモ）を
  //   書いたことにしない（reviewer の指摘、Issue #318）。
  if (/^\s*(?:\||"""|```)/.test(line)) return "table";
  return /^\s*\*(?:\s|$)/.test(line) ? "star" : "text";
}

// 1 行の種類ごとの違反（構造の違反は findFeatureContentViolations が見る）。
const RULE_OF_LINE_KIND: Partial<Record<FeatureLineKind, DomainSpecRuleId>> = {
  language: "domain-spec-keyword",
  tag: "domain-spec-tag",
  keyword: "domain-spec-keyword",
  "keyword-step": "domain-spec-keyword",
};

// 禁止語を見ない行の種類（コメント・空行。language もコメント）。
const LINE_KINDS_WITHOUT_WORDING: ReadonlySet<FeatureLineKind> = new Set([
  "blank",
  "comment",
  "language",
]);

// 構造の違反（domain-spec-structure）の理由。テストの期待値もこの文で書く。
const STRUCTURE = {
  noFeature: "Feature の見出しが無い",
  secondFeature: "Feature の見出しが 2 つ目",
  beforeFeature: "Feature の見出しより前の行",
  featureDescription: "Feature の後、最初の Rule の前に説明の行が無い",
  noRule: "Rule が無い",
  ruleDescription: "Rule の後、最初の Scenario の前に説明の行が無い",
  ruleWithoutScenario: "Rule に Scenario が無い",
  scenarioOutsideRule: "Scenario が Rule の下に無い",
  scenarioWithoutStep: "Scenario に箇条書きの step が無い",
  stepOutsideScenario: "箇条書きの step が Scenario の下に無い",
} as const;

// .feature の構造（domain-spec-structure）を 1 行ずつ読み、違反を積む。
// WHY クラスにして行の種類ごとのメソッドに分ける: 見出し・step・説明の行で状態（今の Feature・Rule・Scenario）の変え方が違い、
//   1 つの関数に書くと分岐が多くなりすぎる（Biome の noExcessiveCognitiveComplexity）。
class FeatureStructureReader {
  readonly violations: DomainSpecViolation[] = [];
  private feature: { line: number; descriptions: number } | undefined;
  private rules = 0;
  // 今いる Rule（行・説明の行の数・Scenario の数）と Scenario（行・`*` の数）。
  private rule:
    | { line: number; descriptions: number; scenarios: number }
    | undefined;
  private scenario: { line: number; stars: number } | undefined;
  // 使わない見出し（Background など）の後、次の使ってよい見出しまで。WHY 説明の行と step を数えない: その見出しの下の行は
  //   キーワードの違反の一部で、Feature / Rule の説明や Scenario の外の step として重ねて数えない。
  private underForbiddenHeading = false;

  // 構造の違反の対象になる行（コメント・空行・言語の指定・タグを除いた行）を 1 行読む。
  read(kind: FeatureLineKind, line: number): void {
    if (kind === "feature") {
      this.readFeature(line);
    } else if (this.feature === undefined) {
      this.add(STRUCTURE.beforeFeature, line);
    } else if (kind === "rule") {
      this.readRule(line);
    } else if (kind === "scenario") {
      this.readScenario(line);
    } else if (kind === "keyword") {
      this.closeScenario();
      this.underForbiddenHeading = true;
    } else if (!this.underForbiddenHeading) {
      this.readBody(kind, line, this.feature);
    }
  }

  // ファイルの終わり。開いている Rule・Scenario を閉じ、Feature の説明と Rule の数を見る。
  finish(): void {
    this.closeRule();
    if (this.feature === undefined) {
      this.add(STRUCTURE.noFeature);
      return;
    }
    if (this.feature.descriptions === 0) {
      this.add(STRUCTURE.featureDescription, this.feature.line);
    }
    if (this.rules === 0) {
      this.add(STRUCTURE.noRule, this.feature.line);
    }
  }

  private add(note: string, line?: number): void {
    this.violations.push({ rule: "domain-spec-structure", line, note });
  }

  private readFeature(line: number): void {
    if (this.feature === undefined) {
      this.feature = { line, descriptions: 0 };
    } else {
      this.add(STRUCTURE.secondFeature, line);
    }
  }

  private readRule(line: number): void {
    this.closeRule();
    this.rules += 1;
    this.rule = { line, descriptions: 0, scenarios: 0 };
    this.underForbiddenHeading = false;
  }

  private readScenario(line: number): void {
    this.closeScenario();
    this.underForbiddenHeading = false;
    if (this.rule === undefined) {
      this.add(STRUCTURE.scenarioOutsideRule, line);
    } else {
      this.rule.scenarios += 1;
    }
    this.scenario = { line, stars: 0 };
  }

  // 見出しでない行（`*` の step・Given などの step・説明の行）。
  private readBody(
    kind: FeatureLineKind,
    line: number,
    feature: { descriptions: number },
  ): void {
    if (kind === "star") {
      if (this.scenario === undefined) {
        this.add(STRUCTURE.stepOutsideScenario, line);
      } else {
        this.scenario.stars += 1;
      }
      return;
    }
    // 説明の行（text）。Scenario の中の行は数えない（限界: Scenario の説明・表・docstring は止めない）。Given などの step は
    //   キーワードの違反で、説明に数えない。
    if (kind !== "text" || this.scenario !== undefined) {
      return;
    }
    if (this.rule !== undefined) {
      this.rule.descriptions += 1;
    } else {
      feature.descriptions += 1;
    }
  }

  private closeScenario(): void {
    if (this.scenario !== undefined && this.scenario.stars === 0) {
      this.add(STRUCTURE.scenarioWithoutStep, this.scenario.line);
    }
    this.scenario = undefined;
  }

  private closeRule(): void {
    this.closeScenario();
    if (this.rule !== undefined && this.rule.descriptions === 0) {
      this.add(STRUCTURE.ruleDescription, this.rule.line);
    }
    if (this.rule !== undefined && this.rule.scenarios === 0) {
      this.add(STRUCTURE.ruleWithoutScenario, this.rule.line);
    }
    this.rule = undefined;
  }
}

// .feature の中身の違反（行の順。同じ行なら RULE_ORDER の順。ファイルの違反（Feature の見出しが無い）は先頭）。
function findFeatureContentViolations(source: string): DomainSpecViolation[] {
  const violations: DomainSpecViolation[] = [];
  const structure = new FeatureStructureReader();
  featureLines(source).forEach((line, index) => {
    const lineNumber = index + 1;
    const kind = featureLineKind(line);
    const lineRule = RULE_OF_LINE_KIND[kind];
    if (lineRule !== undefined) {
      violations.push({ rule: lineRule, line: lineNumber });
    }
    if (LINE_KINDS_WITHOUT_WORDING.has(kind)) {
      return;
    }
    if (containsForbiddenWord(line)) {
      violations.push({
        rule: "domain-spec-business-language",
        line: lineNumber,
      });
    }
    if (kind !== "tag") {
      structure.read(kind, lineNumber);
    }
  });
  structure.finish();
  // WHY 並べ直す: Rule・Scenario の違反は、次の見出し（かファイル末尾）で分かるので後から積まれる。
  return [...violations, ...structure.violations].sort(
    (a, b) =>
      (a.line ?? 0) - (b.line ?? 0) ||
      RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule),
  );
}

// コメントを消す（文字列は残す。改行は残して行番号を変えない）。rule-tests/api-spec.test.ts の stripComments と同じ正規表現。
// WHY 文字列を先に一致させる: 文字列の中の "//"（"http://localhost" など）をコメントの開始と誤認しない。
function stripComments(source: string): string {
  const stringOrComment =
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  return source.replace(stringOrComment, (match, literal?: string) =>
    literal === undefined ? match.replace(/[^\n]/g, " ") : literal,
  );
}

// 文字列の中身を空白にする（改行と長さは残し、位置と行番号を変えない）。stripComments の後に使う。
// WHY: 文字列の中の `.skip(`・`loadFeature(`・`setVitestCucumberConfiguration` を呼び出しと数えない。
function blankStrings(code: string): string {
  return code.replace(
    /"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
    (literal) => literal.replace(/[^\n]/g, " "),
  );
}

function lineAt(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

// import の種類（rule-tests/api-spec.test.ts と同じ）。value: 値の名前を 1 つ以上取る静的な import。type: `import type` か、すべてに
//   inline の type。dynamic: dynamic import()。other: 副作用だけの import・export … from。
type ImportKind = "value" | "type" | "dynamic" | "other";

type ImportRef = { specifier: string; kind: ImportKind; line: number };

// `{ type A, type B }` のように、すべてに inline の type が付いているか（rule-tests/api-spec.test.ts と同じ）。
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

// `{}` のように名前を 1 つも取らないか。値を何も取り込まないので値の import に数えない（reviewer の指摘、Issue #318）。
function hasNoImportedName(clause: string): boolean {
  return /^\{\s*\}$/.test(clause.trim());
}

// ソース（コメントを消したもの）の import / export … from / import "…" / import("…") の参照先（rule-tests/api-spec.test.ts と同じ
//   正規表現。WHY は architecture.test.ts の IMPORT_EXPORT_FROM のコメント）。
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
          : hasNoImportedName(clause ?? "")
            ? "other"
            : "value";
    // WHY 参照先の位置で行を数える: 一致は前の空行（\s*）から始まることがあり、先頭の位置では import の行とずれる。
    return {
      specifier,
      kind,
      line: lineAt(code, match.index + whole.lastIndexOf(specifier)),
    };
  });
  const otherImports = (pattern: RegExp, kind: ImportKind) =>
    [...code.matchAll(pattern)].map(
      (match): ImportRef => ({
        specifier: match[2] ?? "",
        kind,
        line: lineAt(code, match.index),
      }),
    );
  return [
    ...staticImports,
    ...otherImports(/\bimport\s*(["'])([^"'\n]+)\1/g, "other"),
    ...otherImports(/\bimport\s*\(\s*(["'`])([^"'`$\n]+)\1\s*[,)]/g, "dynamic"),
  ];
}

// 参照先をリポジトリ相対のパス（拡張子なし）にする。自前のコードでない参照（パッケージ）は undefined。
// WHY 解決して比べる: `../../../test-support/database` と `@repo/backend/test-support/database` は同じモジュール。
function resolveSpecifier(from: string, specifier: string): string | undefined {
  const alias = "@repo/backend/";
  const resolved = specifier.startsWith(".")
    ? posix.join(posix.dirname(from), specifier)
    : specifier.startsWith(alias)
      ? posix.join("apps/backend", specifier.slice(alias.length))
      : undefined;
  return resolved?.replace(/\.[cm]?[jt]sx?$/, "");
}

// 実 Postgres のテスト用の DB を用意するモジュール（リポジトリ相対、拡張子なし）。
const TEST_DATABASE_MODULE = "apps/backend/test-support/database";

// loadFeature と skip の違反（domain-spec-load-feature）。code はコメントを消したもの、paired は対の .feature の相対パス。
// 対の形 = `loadFeature("./<name>.feature")`（引用符は " か '、第 2 引数なし。名前空間の `x.loadFeature(` も同じに見る）。
function findLoadFeatureViolations(
  code: string,
  paired: string,
): DomainSpecViolation[] {
  const blanked = blankStrings(code);
  const calls = [...blanked.matchAll(/\bloadFeature\s*\(/g)].map((match) => {
    const args = /^loadFeature\s*\(\s*(["'])([^"'\n]*)\1\s*\)/.exec(
      code.slice(match.index),
    );
    return { index: match.index, paired: args?.[2] === paired };
  });
  // WHY 別名の import・ほかの口・設定を止める: 別名で呼ぶと上の形の検査を逃れ、loadFeatureFromText・defineFeature は .feature の
  //   ファイルを読まず、setVitestCucumberConfiguration は言語とタグの絞り込みを全体で変える。
  // WHY skip の直前が . のもの（スプレッドの `...only`）を除く: `{ ...todo }` のようなスプレッドを呼び出しと取り違えない。
  const others = [
    ...blanked.matchAll(
      /\bloadFeature\s+as\b|\b(?:setVitestCucumberConfiguration|loadFeatureFromText|defineFeature|includeTags|excludeTags)\b|(?<!\.)\.\s*(?:skip|only|skipIf|runIf)\b/g,
    ),
  ].map((match) => match.index);
  const lines = [
    ...calls.filter((call) => !call.paired).map((call) => call.index),
    ...others,
  ].map(
    (index): DomainSpecViolation => ({
      rule: "domain-spec-load-feature",
      line: lineAt(code, index),
    }),
  );
  return calls.some((call) => call.paired)
    ? lines
    : [
        ...lines,
        {
          rule: "domain-spec-load-feature",
          note: `loadFeature("${paired}") が無い`,
        },
      ];
}

// import の違反（domain-spec-pure）。code はコメントを消したもの。
function findPureViolations(path: string, code: string): DomainSpecViolation[] {
  const imports = extractImports(code);
  const lines = imports
    .filter(
      (ref) =>
        /\.in-memory$/.test(
          (ref.specifier.split("/").pop() ?? "").replace(/\.[cm]?[jt]sx?$/, ""),
        ) || resolveSpecifier(path, ref.specifier) === TEST_DATABASE_MODULE,
    )
    .map(
      (ref): DomainSpecViolation => ({
        rule: "domain-spec-pure",
        line: ref.line,
      }),
    );
  const feature = path.slice(DOMAIN_SPECS_DIR.length).split("/")[0] ?? "";
  const domainDir = `apps/backend/features/${feature}/internal/domain/`;
  const importsDomainValue = imports.some(
    (ref) =>
      ref.kind === "value" &&
      ref.specifier.startsWith(".") &&
      (resolveSpecifier(path, ref.specifier) ?? "").startsWith(domainDir),
  );
  return importsDomainValue
    ? lines
    : [
        ...lines,
        {
          rule: "domain-spec-pure",
          note: `${domainDir} のモジュールを相対パスで値として import していない`,
        },
      ];
}

// step の実装の中身の違反（行の違反を行の順に、その後ろにファイルの違反）。
function findStepContentViolations(
  path: string,
  source: string,
): DomainSpecViolation[] {
  const code = stripComments(source);
  const name = posix.basename(path).replace(/\.domain-spec\.test\.ts$/, "");
  return [
    ...findLoadFeatureViolations(code, `./${name}.feature`),
    ...findPureViolations(path, code),
  ].sort(
    (a, b) =>
      (a.line ?? Number.POSITIVE_INFINITY) -
        (b.line ?? Number.POSITIVE_INFINITY) ||
      RULE_ORDER.indexOf(a.rule) - RULE_ORDER.indexOf(b.rule),
  );
}

// path の違反。置き場所が違えば置き場所の違反だけを返し（中身は見ない）、.feature・step の実装なら中身を見る。
function findDomainSpecViolations(
  path: string,
  source: string,
): DomainSpecViolation[] {
  if (isMisplacedDomainSpecFile(path)) {
    return [{ rule: "domain-spec-placement" }];
  }
  if (isDomainSpecFeatureFile(path)) {
    return findFeatureContentViolations(source);
  }
  return isDomainSpecStepFile(path)
    ? findStepContentViolations(path, source)
    : [];
}

// root の下の dir を再帰的にたどり、ファイルのリポジトリ相対パス（/ 区切り）を返す。
// WHY node_modules と . で始まるディレクトリ（.next など）に入らない: 依存やビルド結果は検査の対象ではなく、たどると遅い
//   （rule-tests/api-spec.test.ts の walk と同じ）。
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

// 検査の対象: apps/ の下のファイルのうち、apps/backend/spec/domain/ の下のものと、外に置くと違反になる名前
//   （OUTSIDE_DOMAIN_SPEC_FILE）のもの。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listDomainSpecTargets(root: string): string[] {
  return walk(root, "apps")
    .filter(
      (path) =>
        path.startsWith(DOMAIN_SPECS_DIR) ||
        OUTSIDE_DOMAIN_SPEC_FILE.test(path),
    )
    .sort();
}

// 違反を「<規則>: <パス>(:<行>)(（<理由>）)」で返す。
function collectDomainSpecViolations(root: string): string[] {
  const paths = listDomainSpecTargets(root);
  const files = new Set(paths);
  return paths.flatMap((path) =>
    [
      ...findDomainSpecViolations(path, readFileSync(join(root, path), "utf8")),
      ...findPairViolations(path, files),
    ].map(
      ({ rule, line, note }) =>
        `${rule}: ${path}${line === undefined ? "" : `:${line}`}${note === undefined ? "" : `（${note}）`}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const FEATURE = "apps/backend/spec/domain/x/x.feature";
const STEPS = "apps/backend/spec/domain/x/x.domain-spec.test.ts";

// 違反の無い .feature（Feature の説明・Rule の理由・Rule の下の Scenario と `*` の step）。
const GOOD_FEATURE = source(
  "Feature: x の規則",
  "  x は、利用者が書き留めたもの。",
  "",
  "  Rule: 名前は 1〜100 文字",
  "    一覧で 1 行に収まる長さにするため。",
  "",
  "    Scenario: 受け付ける名前",
  "      * 1 文字の名前で作れる",
);

// step の実装の必須の形（対の .feature を読み、同じ feature の domain を値で import する）。例はこれに足すか、どれかを欠く。
const DOMAIN_IMPORT =
  'import { X } from "../../../features/x/internal/domain/x";';
const LOAD_FEATURE = 'const feature = await loadFeature("./x.feature");';
const stepsWith = (...extra: string[]) =>
  source(DOMAIN_IMPORT, LOAD_FEATURE, ...extra);

// WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "domain-spec-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const structure = (note: string, line?: number): DomainSpecViolation => ({
  rule: "domain-spec-structure",
  line,
  note,
});

const feature = await loadFeature("./domain-spec.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("domain 仕様の置き場所（isMisplacedDomainSpecFile）", ({ And }) => {
    And(
      "spec/domain/<feature>/ の直下の .feature と step の実装、domain 仕様でないファイルは違反なし（API 仕様・層の下の単体テストなど）",
      () => {
        // given
        const cases: [string, string][] = [
          ["spec/domain/<feature>/ の直下の .feature", FEATURE],
          ["spec/domain/<feature>/ の直下の step の実装", STEPS],
          [
            "domain の単体テスト",
            "apps/backend/features/x/internal/domain/x.test.ts",
          ],
          [
            "API 仕様の step",
            "apps/backend/spec/api/x/create-x.api-spec.test.ts",
          ],
          ["API 仕様の .feature", "apps/backend/spec/api/x/create-x.feature"],
          [
            "名前に domain-spec を含むがテストでないファイル（spec/domain/ の外）",
            "apps/backend/features/x/internal/domain/x.domain-spec.ts",
          ],
          [
            "spec/domain の前方一致だけの別ディレクトリのテストでないファイル",
            "apps/backend/spec/domain-x/x/x.ts",
          ],
        ];

        // when
        const result = casesByName(cases, ([, path]) =>
          isMisplacedDomainSpecFile(path),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => false));
      },
    );

    And(
      "spec/domain/<feature>/ の直下でないファイル・ほかの種類のファイルと、spec/domain/ の外の step の実装は違反（spec/domain/ の直下・入れ子・support.ts など）",
      () => {
        // given
        const cases: [string, string][] = [
          [
            "spec/domain/ の直下の .feature",
            "apps/backend/spec/domain/x.feature",
          ],
          [
            "spec/domain/ の直下の step の実装",
            "apps/backend/spec/domain/x.domain-spec.test.ts",
          ],
          [
            "<feature>/ の下のサブディレクトリの .feature",
            "apps/backend/spec/domain/x/nested/x.feature",
          ],
          [
            "<feature>/ の下のサブディレクトリの step の実装",
            "apps/backend/spec/domain/x/nested/x.domain-spec.test.ts",
          ],
          ["補助の support.ts", "apps/backend/spec/domain/x/support.ts"],
          ["補助のほかの名前", "apps/backend/spec/domain/x/helper.ts"],
          ["README", "apps/backend/spec/domain/x/README.md"],
          [
            "domain-spec の名前の無いテスト",
            "apps/backend/spec/domain/x/x.test.ts",
          ],
          [
            "API 仕様の名前のテスト",
            "apps/backend/spec/domain/x/x.api-spec.test.ts",
          ],
          [
            ".tsx の step の実装",
            "apps/backend/spec/domain/x/x.domain-spec.test.tsx",
          ],
          [
            ".feature の後ろに拡張子を足したもの",
            "apps/backend/spec/domain/x/x.feature.md",
          ],
          [
            "feature の下の domain の step の実装",
            "apps/backend/features/x/internal/domain/x.domain-spec.test.ts",
          ],
          [
            "spec/api/ の下の step の実装",
            "apps/backend/spec/api/x/x.domain-spec.test.ts",
          ],
          [
            "spec/domain の前方一致だけの別ディレクトリの step の実装",
            "apps/backend/spec/domain-x/x/x.domain-spec.test.ts",
          ],
          [
            "frontend の step の実装（.js）",
            "apps/frontend_customer/x.domain-spec.test.js",
          ],
        ];

        // when
        const result = casesByName(cases, ([, path]) =>
          isMisplacedDomainSpecFile(path),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => true));
      },
    );
  });

  Scenario(".feature と step の実装の対（findPairViolations）", ({ And }) => {
    And("同じ名前の .feature と step の実装がそろえば違反なし", () => {
      // given
      const files = new Set([FEATURE, STEPS]);
      const cases: [string, string][] = [
        [".feature", FEATURE],
        ["step の実装", STEPS],
        [
          "置き場所の違反のファイル（対を見ない）",
          "apps/backend/spec/domain/x/nested/y.feature",
        ],
        ["対象外のファイル", "apps/backend/features/x/internal/domain/x.ts"],
      ];

      // when
      const result = casesByName(cases, ([, path]) =>
        findPairViolations(path, files),
      );

      // then
      expect(result).toEqual(casesByName(cases, () => []));
    });

    And("片方だけ・名前の違う組は、対の無いほうの違反になる", () => {
      // given
      const files = new Set([
        FEATURE,
        "apps/backend/spec/domain/x/y.domain-spec.test.ts",
        "apps/backend/spec/domain/z/x.domain-spec.test.ts",
      ]);
      const cases: [string, string, DomainSpecViolation[]][] = [
        [
          "step の無い .feature",
          FEATURE,
          [{ rule: "domain-spec-pair", note: `対の ${STEPS} が無い` }],
        ],
        [
          "名前の違う step の実装",
          "apps/backend/spec/domain/x/y.domain-spec.test.ts",
          [
            {
              rule: "domain-spec-pair",
              note: "対の apps/backend/spec/domain/x/y.feature が無い",
            },
          ],
        ],
        [
          "feature のディレクトリの違う step の実装",
          "apps/backend/spec/domain/z/x.domain-spec.test.ts",
          [
            {
              rule: "domain-spec-pair",
              note: "対の apps/backend/spec/domain/z/x.feature が無い",
            },
          ],
        ],
      ];

      // when
      const result = casesByName(cases, ([, path]) =>
        findPairViolations(path, files),
      );

      // then
      expect(result).toEqual(casesByName(cases, ([, , expected]) => expected));
    });
  });

  Scenario(
    ".feature のキーワードとタグ（findFeatureContentViolations）",
    ({ And }) => {
      And(
        "Feature・Rule・Scenario の見出し・箇条書きの step・説明の行・コメント・空行だけなら違反なし（行の区切りが CRLF でも）",
        () => {
          // given
          const cases: [string, string][] = [
            ["基本の形", GOOD_FEATURE],
            [
              "コメント・字下げの違い・複数の Rule と Scenario",
              source(
                "# 書き手のメモ",
                "Feature: x の規則",
                "x は、利用者が書き留めたもの。",
                "  # Rule の前のコメント",
                "Rule: 名前は 1〜100 文字",
                "  一覧で 1 行に収まる長さにするため。",
                "  Scenario: 受け付ける名前",
                "    * 1 文字の名前で作れる",
                "    # step の間のコメント",
                "    * 100 文字の名前で作れる",
                "  Scenario: 拒否する名前",
                "    * 空の名前は拒否される",
                "Rule: 完了は取り消せる",
                "  完了を押し間違えたときに戻せるようにするため。",
                "  Scenario: 取り消し",
                "    * 完了した x を未完了に戻せる",
              ),
            ],
            ["CRLF の行の区切り", GOOD_FEATURE.replace(/\n/g, "\r\n")],
            [
              "行の途中の # と @ と Given は文の一部",
              source(
                "Feature: x の規則",
                "  x は、# の記号や @ の記号を名前に含められる。",
                "  Rule: 名前は自由",
                "    説明の途中に Given の語を書いてもよい。",
                "    Scenario: 記号",
                "      * 名前に # と @ を含められる",
              ),
            ],
          ];

          // when
          const result = casesByName(cases, ([, feature]) =>
            findFeatureContentViolations(feature),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => []));
        },
      );

      And(
        "Background・Scenario Outline・Example などのキーワード、Given などの step、言語の指定、タグの行は、行の番号で違反になる",
        () => {
          // given
          const feature = source(
            "# language: ja",
            "@tag",
            "Feature: x の規則",
            "  x は、利用者が書き留めたもの。",
            "  Background:",
            "    * 前提",
            "  Rule: 名前は 1〜100 文字",
            "    一覧で 1 行に収まる長さにするため。",
            "    @ignore",
            "    Scenario: 受け付ける名前",
            "      Given 1 文字の名前",
            "      When 作る",
            "      Then 作れる",
            "      And 一覧に出る",
            "      But 2 つは出ない",
            "      * 1 文字の名前で作れる",
            "    Scenario Outline: 例の表",
            "      * <名前> で作れる",
            "      Examples:",
            "        | 名前 |",
            "    Scenario Template: 例の表 2",
            "    Example: 別名",
            "    Scenarios:",
            "    Scenario: 拒否する名前",
            "      * 空の名前は拒否される",
          );

          // when
          const result = findFeatureContentViolations(feature);

          // then
          expect(result).toEqual([
            { rule: "domain-spec-keyword", line: 1 },
            { rule: "domain-spec-tag", line: 2 },
            { rule: "domain-spec-keyword", line: 5 },
            { rule: "domain-spec-tag", line: 9 },
            ...[11, 12, 13, 14, 15, 17, 19, 21, 22, 23].map((line) => ({
              rule: "domain-spec-keyword" as const,
              line,
            })),
          ]);
        },
      );
    },
  );

  Scenario(
    ".feature の仕様メモの構造（findFeatureContentViolations）",
    ({ And }) => {
      And(
        "Feature の後と各 Rule の後に説明の行があり、Scenario がすべて Rule の下で、箇条書きの step を持てば違反なし（説明が複数行・Scenario の中の説明の行など）",
        () => {
          // given
          const cases: [string, string][] = [
            [
              "説明が複数行・空行とコメントを挟む",
              source(
                "Feature: x の規則",
                "",
                "  # メモ",
                "  x は、利用者が書き留めたもの。",
                "  2 行目の説明。",
                "  Rule: 名前は 1〜100 文字",
                "",
                "    # メモ",
                "    一覧で 1 行に収まる長さにするため。",
                "    2 行目の理由。",
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
              ),
            ],
            [
              "Scenario の中の説明の行・表の行（限界: 止めない）",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    Scenario: 受け付ける名前",
                "      Scenario の説明の行。",
                "      * 1 文字の名前で作れる",
                "        | 名前 |",
              ),
            ],
          ];

          // when
          const result = casesByName(cases, ([, feature]) =>
            findFeatureContentViolations(feature),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => []));
        },
      );

      And(
        "Feature や Rule の後に説明の行が無い（コメントと空行だけ・表と docstring だけも）と、見出しの行の違反になる",
        () => {
          // given
          const cases: [string, string, DomainSpecViolation[]][] = [
            [
              "Feature の説明が無い",
              source(
                "Feature: x の規則",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
              ),
              [structure(STRUCTURE.featureDescription, 1)],
            ],
            [
              "Feature の後がコメントと空行だけ",
              source(
                "Feature: x の規則",
                "  # x は、利用者が書き留めたもの。",
                "",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
              ),
              [structure(STRUCTURE.featureDescription, 1)],
            ],
            [
              "Rule の後が表と docstring だけ",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Rule: 名前は 1〜100 文字",
                "    | 名前 |",
                '    """',
                '    """',
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
              ),
              [structure(STRUCTURE.ruleDescription, 3)],
            ],
            [
              "Feature の説明も最初の Rule の理由も無い（2 つ目の Rule の後の説明の行はその Rule の理由に数える）",
              source(
                "Feature: x の規則",
                "  Rule: 名前は 1〜100 文字",
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
                "  Rule: 完了は取り消せる",
                "    完了を押し間違えたときに戻せるようにするため。",
                "    Scenario: 取り消し",
                "      * 完了した x を未完了に戻せる",
              ),
              [
                structure(STRUCTURE.featureDescription, 1),
                structure(STRUCTURE.ruleDescription, 2),
              ],
            ],
            [
              "Rule の理由が無い（2 つ目の Rule だけ）",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
                "  Rule: 完了は取り消せる",
                "    # 押し間違えを戻すため",
                "",
                "    Scenario: 取り消し",
                "      * 完了した x を未完了に戻せる",
              ),
              [structure(STRUCTURE.ruleDescription, 7)],
            ],
            [
              "Rule の理由が Scenario の後ろにだけある",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Rule: 名前は 1〜100 文字",
                "    Scenario: 受け付ける名前",
                "      一覧で 1 行に収まる長さにするため。",
                "      * 1 文字の名前で作れる",
              ),
              [structure(STRUCTURE.ruleDescription, 3)],
            ],
          ];

          // when
          const result = casesByName(cases, ([, feature]) =>
            findFeatureContentViolations(feature),
          );

          // then
          expect(result).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );

      And(
        "Rule が無い・Rule より前の Scenario・Scenario の無い Rule・step の無い Scenario・Scenario の外の step・Feature の見出しの欠けと重なりは違反になる",
        () => {
          // given
          const cases: [string, string, DomainSpecViolation[]][] = [
            [
              "Rule が無い（Scenario も Rule の下に無い）",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Scenario: 受け付ける名前",
                "    * 1 文字の名前で作れる",
              ),
              [
                structure(STRUCTURE.noRule, 1),
                structure(STRUCTURE.scenarioOutsideRule, 3),
              ],
            ],
            [
              "最初の Rule より前の Scenario",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Scenario: 受け付ける名前",
                "    * 1 文字の名前で作れる",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    Scenario: 拒否する名前",
                "      * 空の名前は拒否される",
              ),
              [structure(STRUCTURE.scenarioOutsideRule, 3)],
            ],
            [
              "Scenario の無い Rule（途中と最後）",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "  Rule: 完了は取り消せる",
                "    完了を押し間違えたときに戻せるようにするため。",
                "    Scenario: 取り消し",
                "      * 完了した x を未完了に戻せる",
                "  Rule: 削除は戻せない",
                "    消したものは残さないため。",
              ),
              [
                structure(STRUCTURE.ruleWithoutScenario, 3),
                structure(STRUCTURE.ruleWithoutScenario, 9),
              ],
            ],
            [
              "step の無い Scenario（途中と最後。Given だけの Scenario も）",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    Scenario: 受け付ける名前",
                "    Scenario: 拒否する名前",
                "      Given 空の名前",
                "    Scenario: 長さ",
                "      * 100 文字の名前で作れる",
                "    Scenario: 最後",
              ),
              [
                structure(STRUCTURE.scenarioWithoutStep, 5),
                structure(STRUCTURE.scenarioWithoutStep, 6),
                { rule: "domain-spec-keyword", line: 7 },
                structure(STRUCTURE.scenarioWithoutStep, 10),
              ],
            ],
            [
              "Scenario の外の step（Feature と Rule の説明の位置）",
              source(
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  * Feature の下の step",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    * Rule の下の step",
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
              ),
              [
                structure(STRUCTURE.stepOutsideScenario, 3),
                structure(STRUCTURE.stepOutsideScenario, 6),
              ],
            ],
            [
              "Feature の見出しが無い",
              source(
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
              ),
              [
                structure(STRUCTURE.noFeature),
                structure(STRUCTURE.beforeFeature, 1),
                structure(STRUCTURE.beforeFeature, 2),
              ],
            ],
            [
              "Feature の見出しより前の説明の行と、2 つ目の Feature",
              source(
                "x の説明",
                "Feature: x の規則",
                "  x は、利用者が書き留めたもの。",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
                "Feature: y の規則",
              ),
              [
                structure(STRUCTURE.beforeFeature, 1),
                structure(STRUCTURE.secondFeature, 8),
              ],
            ],
            [
              "Feature の見出しだけ",
              "Feature: x の規則",
              [
                structure(STRUCTURE.featureDescription, 1),
                structure(STRUCTURE.noRule, 1),
              ],
            ],
            [
              "使わない見出し（Background）の下の行は説明や step に数えない",
              source(
                "Feature: x の規則",
                "  Background:",
                "    前提の説明",
                "    * 前提",
                "  Rule: 名前は 1〜100 文字",
                "    一覧で 1 行に収まる長さにするため。",
                "    Scenario: 受け付ける名前",
                "      * 1 文字の名前で作れる",
              ),
              [
                structure(STRUCTURE.featureDescription, 1),
                { rule: "domain-spec-keyword", line: 2 },
              ],
            ],
          ];

          // when
          const result = casesByName(cases, ([, feature]) =>
            findFeatureContentViolations(feature),
          );

          // then
          expect(result).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );
    },
  );

  Scenario(
    ".feature の業務の言葉（findFeatureContentViolations）",
    ({ And }) => {
      And(
        "見出し・説明・step の行の禁止語は行の番号で違反になり、コメントの行の禁止語は違反なし",
        () => {
          // given
          const feature = source(
            "# DB の表 todos を読む（コメントは見ない）",
            "Feature: x の DB の規則",
            "  x は、テーブルの 1 レコード。",
            "  Rule: title は 1〜100 文字",
            "    バリデーションで止めるため。",
            "    # null は拒否（コメントは見ない）",
            "    Scenario: null の名前",
            "      * null の名前は拒否される",
            "      * 100 文字の名前で作れる",
          );

          // when
          const result = findFeatureContentViolations(feature);

          // then
          expect(result).toEqual(
            [2, 3, 4, 5, 7, 8].map((line) => ({
              rule: "domain-spec-business-language",
              line,
            })),
          );
        },
      );
    },
  );

  Scenario(
    "step の実装の loadFeature と skip（findStepContentViolations）",
    ({ And }) => {
      And(
        "対の .feature を第 2 引数なしで読めば違反なし（単一引用符・名前空間・文字列やコメントの中の skip など）",
        () => {
          // given
          const cases: [string, string][] = [
            ["基本の形", stepsWith()],
            [
              "単一引用符と括弧の内側の空白",
              source(
                DOMAIN_IMPORT,
                "const feature = await loadFeature( './x.feature' );",
              ),
            ],
            [
              "名前空間の import 経由",
              source(
                DOMAIN_IMPORT,
                'import * as cucumber from "@amiceli/vitest-cucumber";',
                'const feature = await cucumber.loadFeature("./x.feature");',
              ),
            ],
            [
              "文字列とコメントの中の skip・only・設定の名前・別の loadFeature",
              stepsWith(
                '// Scenario.skip(), loadFeature("./y.feature"), excludeTags',
                "/* RuleScenario.only( */",
                'const text = "RuleScenario.skip( setVitestCucumberConfiguration";',
                "const spread = { ...only };",
              ),
            ],
          ];

          // when
          const result = casesByName(cases, ([, steps]) =>
            findStepContentViolations(STEPS, steps),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => []));
        },
      );

      And(
        "loadFeature の無い・対でない・第 2 引数のある読み方、ほかの読み込み口と設定、skip・only とタグの絞り込みは違反",
        () => {
          // given
          const missing: DomainSpecViolation = {
            rule: "domain-spec-load-feature",
            note: 'loadFeature("./x.feature") が無い',
          };
          const at = (...lines: number[]): DomainSpecViolation[] =>
            lines.map((line) => ({ rule: "domain-spec-load-feature", line }));
          const cases: [string, string, DomainSpecViolation[]][] = [
            ["loadFeature が無い", DOMAIN_IMPORT, [missing]],
            [
              "別の .feature・./ の無いパス・テンプレートリテラル・変数",
              source(
                DOMAIN_IMPORT,
                'const a = await loadFeature("./y.feature");',
                'const b = await loadFeature("x.feature");',
                "const c = await loadFeature(`./x.feature`);",
                "const d = await loadFeature(path);",
              ),
              [...at(2, 3, 4, 5), missing],
            ],
            [
              "第 2 引数で言語を渡す（対の形の呼び出しが別にあっても）",
              stepsWith(
                'const ja = await loadFeature("./x.feature", { language: "ja" });',
              ),
              at(3),
            ],
            [
              "別名の import・ほかの読み込み口・設定",
              stepsWith(
                'import { loadFeature as load } from "@amiceli/vitest-cucumber";',
                'import { loadFeatureFromText, defineFeature } from "@amiceli/vitest-cucumber";',
                'setVitestCucumberConfiguration({ language: "ja" });',
              ),
              at(3, 4, 4, 5),
            ],
            [
              "skip・only・skipIf・runIf（空白を挟むものも）とタグの絞り込み",
              stepsWith(
                'RuleScenario.skip("a", () => {});',
                'Rule.only("b", () => {});',
                "describeFeature.skipIf(true)(feature, () => {});",
                'it.runIf(false)("c", () => {});',
                'RuleScenario . skip("d", () => {});',
                'describeFeature(feature, () => {}, { includeTags: ["a"], excludeTags: ["b"] });',
              ),
              at(3, 4, 5, 6, 7, 8, 8),
            ],
          ];

          // when
          const result = casesByName(cases, ([, steps]) =>
            findStepContentViolations(STEPS, steps),
          );

          // then
          expect(result).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );
    },
  );

  Scenario(
    "step の実装の import（findStepContentViolations の domain-spec-pure）",
    ({ And }) => {
      And(
        "同じ feature の domain のモジュールを相対パスで値として import すれば違反なし（複数行・type の混じった import・拡張子付き・domain の下の入れ子など）",
        () => {
          // given
          const cases: [string, string][] = [
            ["基本の形", stepsWith()],
            [
              "複数行・type の混じった import",
              source(
                "import {",
                "  type XProps,",
                "  X,",
                '} from "../../../features/x/internal/domain/x";',
                LOAD_FEATURE,
              ),
            ],
            [
              "拡張子付き",
              source(
                'import { X } from "../../../features/x/internal/domain/x.ts";',
                LOAD_FEATURE,
              ),
            ],
            [
              "domain の下の入れ子のモジュール",
              source(
                'import { Title } from "../../../features/x/internal/domain/value/title";',
                LOAD_FEATURE,
              ),
            ],
            [
              "コメントと文字列の中の InMemory と実 DB",
              stepsWith(
                '// import { InMemoryXRepository } from "../../../test-support/x/x-repository.in-memory";',
                'const text = "../../../test-support/database";',
              ),
            ],
          ];

          // when
          const result = casesByName(cases, ([, steps]) =>
            findStepContentViolations(STEPS, steps),
          );

          // then
          expect(result).toEqual(casesByName(cases, () => []));
        },
      );

      And(
        "InMemory と実 DB の import（型だけ・dynamic import・再公開も）は行の違反、同じ feature の domain の値の import が無ければファイルの違反になる",
        () => {
          // given
          const noDomain: DomainSpecViolation = {
            rule: "domain-spec-pure",
            note: "apps/backend/features/x/internal/domain/ のモジュールを相対パスで値として import していない",
          };
          const at = (...lines: number[]): DomainSpecViolation[] =>
            lines.map((line) => ({ rule: "domain-spec-pure", line }));
          const cases: [string, string, DomainSpecViolation[]][] = [
            [
              "InMemory（値・型だけ・dynamic import・再公開・拡張子付き）",
              stepsWith(
                'import { InMemoryXRepository } from "../../../test-support/x/x-repository.in-memory";',
                'import type { InMemoryXRepository as R } from "../../../test-support/x/x-repository.in-memory";',
                'const m = await import("../../../test-support/x/x-repository.in-memory");',
                'export { InMemoryXRepository } from "../../../test-support/x/x-repository.in-memory.ts";',
              ),
              at(3, 4, 5, 6),
            ],
            [
              "実 DB（相対パス・@repo/backend の書き方・型だけ・dynamic import）",
              stepsWith(
                'import { TestDatabase } from "../../../test-support/database";',
                'import type { Database } from "@repo/backend/test-support/database";',
                'const db = await import("../../../test-support/database.ts");',
              ),
              at(3, 4, 5),
            ],
            [
              "domain を型だけで import",
              source(
                'import type { X } from "../../../features/x/internal/domain/x";',
                LOAD_FEATURE,
              ),
              [noDomain],
            ],
            [
              "domain を inline の type だけで import",
              source(
                'import { type X } from "../../../features/x/internal/domain/x";',
                LOAD_FEATURE,
              ),
              [noDomain],
            ],
            [
              "domain を名前の無い import {} で読む",
              source(
                'import {} from "../../../features/x/internal/domain/x";',
                LOAD_FEATURE,
              ),
              [noDomain],
            ],
            [
              "domain を dynamic import と再公開だけで読む",
              source(
                'const m = await import("../../../features/x/internal/domain/x");',
                'export { X } from "../../../features/x/internal/domain/x";',
                LOAD_FEATURE,
              ),
              [noDomain],
            ],
            [
              "別の feature の domain",
              source(
                'import { Y } from "../../../features/y/internal/domain/y";',
                LOAD_FEATURE,
              ),
              [noDomain],
            ],
            [
              "同じ feature の domain 以外の層",
              source(
                'import { CreateXCommand } from "../../../features/x/internal/application/create-x.command";',
                LOAD_FEATURE,
              ),
              [noDomain],
            ],
            [
              "domain の前方一致だけの別ディレクトリ",
              source(
                'import { X } from "../../../features/x/internal/domain-x/x";',
                LOAD_FEATURE,
              ),
              [noDomain],
            ],
            [
              "@repo/backend の書き方の domain（相対パスでない）",
              source(
                'import { X } from "@repo/backend/features/x/internal/domain/x";',
                LOAD_FEATURE,
              ),
              [noDomain],
            ],
            [
              "InMemory を使い domain の値の import も無い（行の違反の後ろにファイルの違反）",
              source(
                'import { InMemoryXRepository } from "../../../test-support/x/x-repository.in-memory";',
                LOAD_FEATURE,
              ),
              [...at(1), noDomain],
            ],
          ];

          // when
          const result = casesByName(cases, ([, steps]) =>
            findStepContentViolations(STEPS, steps),
          );

          // then
          expect(result).toEqual(
            casesByName(cases, ([, , expected]) => expected),
          );
        },
      );
    },
  );

  Scenario("列挙と検査（fixture）", ({ And }) => {
    And(
      "spec/domain/ の下と外の domain 仕様の step を対象にし、違反を「規則: パス(:行)（理由）」で返す",
      () => {
        // given
        const specs = "apps/backend/spec/domain/x";
        const root = fixture({
          // 対がそろい、中身も違反なし。
          [`${specs}/x.feature`]: GOOD_FEATURE,
          [`${specs}/x.domain-spec.test.ts`]: stepsWith(),
          // 対がそろうが、.feature と step の中身が違反。
          [`${specs}/bad.feature`]: source(
            "Feature: bad の規則",
            "  Rule: DB の規則",
            "    Scenario: 受け付ける",
            "      Given 前提",
            "      * 作れる",
            "    @ignore",
          ),
          [`${specs}/bad.domain-spec.test.ts`]: source(
            DOMAIN_IMPORT,
            'import { TestDatabase } from "../../../test-support/database";',
            'const feature = await loadFeature("./x.feature");',
            'RuleScenario.skip("a", () => {});',
          ),
          // 対の違反: .feature だけ・step だけ。
          [`${specs}/only-feature.feature`]: GOOD_FEATURE,
          [`${specs}/only-steps.domain-spec.test.ts`]: source(
            DOMAIN_IMPORT,
            'const feature = await loadFeature("./only-steps.feature");',
          ),
          // 置き場所の違反: 補助・入れ子・直下・外の step（中身は見ない）。
          [`${specs}/support.ts`]: "export const a = 1;\n",
          [`${specs}/nested/x.feature`]: "Feature: DB\n",
          "apps/backend/spec/domain/x.feature": "Feature: DB\n",
          "apps/backend/features/x/internal/domain/x.domain-spec.test.ts": "",
          // 対象外: API 仕様・domain の単体テスト・node_modules と . で始まるディレクトリの中。
          "apps/backend/spec/api/x/create-x.feature": "Feature: DB\n",
          "apps/backend/features/x/internal/domain/x.test.ts": "",
          "apps/backend/node_modules/x/x.domain-spec.test.ts": "",
          "apps/frontend_customer/.next/x.domain-spec.test.ts": "",
        });

        // when
        const result = {
          files: listDomainSpecTargets(root),
          violations: collectDomainSpecViolations(root),
        };

        // then
        expect(result).toEqual({
          files: [
            "apps/backend/features/x/internal/domain/x.domain-spec.test.ts",
            "apps/backend/spec/domain/x.feature",
            "apps/backend/spec/domain/x/bad.domain-spec.test.ts",
            "apps/backend/spec/domain/x/bad.feature",
            "apps/backend/spec/domain/x/nested/x.feature",
            "apps/backend/spec/domain/x/only-feature.feature",
            "apps/backend/spec/domain/x/only-steps.domain-spec.test.ts",
            "apps/backend/spec/domain/x/support.ts",
            "apps/backend/spec/domain/x/x.domain-spec.test.ts",
            "apps/backend/spec/domain/x/x.feature",
          ],
          violations: [
            "domain-spec-placement: apps/backend/features/x/internal/domain/x.domain-spec.test.ts",
            "domain-spec-placement: apps/backend/spec/domain/x.feature",
            "domain-spec-pure: apps/backend/spec/domain/x/bad.domain-spec.test.ts:2",
            "domain-spec-load-feature: apps/backend/spec/domain/x/bad.domain-spec.test.ts:3",
            "domain-spec-load-feature: apps/backend/spec/domain/x/bad.domain-spec.test.ts:4",
            'domain-spec-load-feature: apps/backend/spec/domain/x/bad.domain-spec.test.ts（loadFeature("./bad.feature") が無い）',
            "domain-spec-structure: apps/backend/spec/domain/x/bad.feature:1（Feature の後、最初の Rule の前に説明の行が無い）",
            "domain-spec-structure: apps/backend/spec/domain/x/bad.feature:2（Rule の後、最初の Scenario の前に説明の行が無い）",
            "domain-spec-business-language: apps/backend/spec/domain/x/bad.feature:2",
            "domain-spec-keyword: apps/backend/spec/domain/x/bad.feature:4",
            "domain-spec-tag: apps/backend/spec/domain/x/bad.feature:6",
            "domain-spec-placement: apps/backend/spec/domain/x/nested/x.feature",
            "domain-spec-pair: apps/backend/spec/domain/x/only-feature.feature（対の apps/backend/spec/domain/x/only-feature.domain-spec.test.ts が無い）",
            "domain-spec-pair: apps/backend/spec/domain/x/only-steps.domain-spec.test.ts（対の apps/backend/spec/domain/x/only-steps.feature が無い）",
            "domain-spec-placement: apps/backend/spec/domain/x/support.ts",
          ],
        });
      },
    );

    And("apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
      // given
      const root = fixture({ "README.md": "# x\n" });

      // when
      const result = {
        files: listDomainSpecTargets(root),
        violations: collectDomainSpecViolations(root),
      };

      // then
      expect(result).toEqual({ files: [], violations: [] });
    });
  });

  Scenario("domain 仕様（実ファイル）", ({ And }) => {
    And(
      "apps/backend/spec/domain/ の下に domain 仕様があり、置き場所・対・.feature の形・step の実装の規則に違反が無い",
      () => {
        // given: 実ファイル（repoRoot）
        // when
        const files = listDomainSpecTargets(repoRoot);
        const violations = collectDomainSpecViolations(repoRoot);

        // then
        // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
        expect(files).toEqual(
          expect.arrayContaining([
            "apps/backend/spec/domain/todo/todo.feature",
            "apps/backend/spec/domain/todo/todo.domain-spec.test.ts",
          ]),
        );
        expect(violations).toEqual([]);
      },
    );
  });
});

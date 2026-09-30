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

// ジャーニーテスト（Issue #187。.claude/rules/testing.md の「ジャーニーテスト」、ADR docs/adr/quality/20260930-backend-journey-tests.md）の
//   置き場所と形を、ファイルの一覧とソースで機械的に検査するテスト。
// ジャーニーテスト = 実 Postgres の上で、複数の API の handler（XxxApi.handle）を業務ユースケースに沿って順に呼ぶテスト。
// 違反にするもの:
//   - journey-placement: apps/backend/journeys/ の下には、直下の *.journey.test.ts だけを置く。サブディレクトリの中のファイル・
//     テスト以外のファイル（補助の .ts・.md も）・名前に .journey の無いテスト（x.test.ts）・.tsx は違反。apps/ の下のほかの場所
//     （features/x/journeys/ など）に *.journey.test.* を置くのも違反。
//     WHY 置き場所を 1 か所にする: ジャーニーは feature をまたぐ業務の流れを置く場所で、features/<f>/ の下では feature をまたげない。
//       直下のジャーニーだけにすると、test-support/database の import の例外（rule-tests/test-doubles.test.ts の db-tests-in-infra-only）も
//       この 1 か所に絞れる。共通の補助が要るようになったら apps/backend/test-support/ に置く（journeys/ に置かない）。
//     WHY テスト以外のソースも止める（architecture.test.ts の backend-placement でも止まるが、ここでも見る）: .md など
//       ソースでないファイルは backend-placement の対象外で、journeys/ を別の用途の置き場所にさせないため。
//   以下はジャーニー（apps/backend/journeys/ の直下の *.journey.test.ts）の中身の規則:
//   - journey-no-in-memory: *.in-memory（InMemory の Repository）を import しない（`import type` も・`import()` も・`export … from` も）。
//     WHY: ジャーニーは本番と同じ部品（Postgres の Repository）で API のつながりを確かめる。InMemory で組むと単体テストと同じになる。
//     WHY import type も違反: 型だけでも InMemory で組み立てる形の入口になる。ジャーニーに InMemory の型が要る場面は無い。
//   - journey-no-vi: `vitest` から `vi`（と同じものの別名 `vitest`）を import しない。`vi as v` の別名・名前空間（`import * as x`）・
//     既定の import・dynamic `import("vitest")` も違反（名前空間・既定・dynamic は、取り出す名前によらず違反）。`import type` と
//     inline の `type` は通す（型だけでは vi を呼べない）。vitest の設定で globals は無効なので、import しなければ `vi` は使えない。
//     WHY: テストダブル（`vi.mock`・`vi.spyOn(...).mockResolvedValue`・`vi.useFakeTimers` / `vi.setSystemTime`・`vi.stubGlobal`）は
//       差し替えた部分のつながりを確かめなくする。以前の journey-no-mock は `vi.mock(` / `vi.doMock(` の呼び出しだけを見ていて、
//       ほかのメソッドや `vi?.mock` が通った（reviewer の指摘、Issue #187）。使い方の列挙は漏れるので、入口の import で止める。
//       時計も差し替えず、実時計のままで成り立つ流れを書く（作成順は todo-lifecycle.journey.test.ts の waitUntilAfter のように
//       実時計が進むのを待つ）。
//   - journey-handler-naming: `new XxxApi(`（名前が Api で終わるクラス）は `<名前> = ` か `<名前>: `（オブジェクトのキー）の直後にだけ
//     書き、名前は HTTP メソッドで始める（大文字小文字を区別しない前方一致。変更系は post / put / patch / delete、読み取りは get /
//     list）。名前の無い `new XxxApi(`（`await new XxxApi(c).handle(r)`）も違反。行は `new XxxApi(` の行。
//     WHY: 次の journey-asserts-db-after-mutation は、呼び出しの名前で変更系を見分ける。`renameTodo` のような名前だと変更系と
//       分からず、DB の検証が無くても通ってしまう。名前を規約に縛って、見分けの漏れを止める。
//   - journey-asserts-db-after-mutation: 変更系の handler の呼び出し（`await <名前>(`・`await <名前>.handle(`・
//     `await <x>.<名前>(`。<名前> が post / put / patch / delete で始まる）の後、次の変更系の呼び出し（無ければファイル末尾）までに、
//     DB の読み取り `db.select(`（`database.db.select(` など。`db` の前は識別子の文字でないこと、`.` と `(` の前後の空白・改行は可）
//     が無ければ違反。行は呼び出しの行。読み取り系（get / list）の後は見ない。
//     WHY: 応答が正しくても永続化がずれる誤り（差分 UPDATE の漏れ・where の欠落・削除の取り違え）は、次の API の応答だけでは
//       見逃しうる。ジャーニーは実 DB を使う唯一の複数 API のテストなので、変更のたびに行を見る（ユーザー判断、Issue #187）。
//     WHY db. を必須にする: `.select(` だけでは、DB 以外の select（`repository.select(`）や別の接続（`tx.select(`）と区別できない。
//     WHY 文字列の中の db.select( を数えない（コメントと同じ）: 読み取りは「ある」ほうが違反を消すので、数えない側が安全側。
//       逆に変更系の呼び出しは、文字列の中の `await postX(` も数える（数える側が安全側）。
//   - journey-uses-multiple-apis: 異なる *.api モジュール（presentation の api ファイル）を 2 つ以上、値として import する。
//     WHY: 1 つの API だけなら presentation の単体テスト（*.api.test.ts）の範囲で、ジャーニー（複数の API の流れ）ではない。
//     数え方: 参照先を解決したパス（拡張子なし）で数える（`./x.api` と `./x.api.ts` は 1 つ）。`import type` と、すべてに inline の
//       type が付いたもの（`{ type A }`）は数えない（handler を呼べない）。
//   - journey-uses-real-database: apps/backend/test-support/database（createTestDatabase）を値として import する。
//     WHY: 実 DB で流れを確かめるのがジャーニーの目的。型だけの import（TestDatabase）では実 DB を用意しない。
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
// WHY 文字列で判定する（AST にしない）: 見るのはパスと import の参照先と名前・呼び出しの形だけで、正規表現で足りる
//   （rule-tests/test-doubles.test.ts と同じ）。

type JourneyRuleId =
  | "journey-placement"
  | "journey-no-in-memory"
  | "journey-no-vi"
  | "journey-handler-naming"
  | "journey-asserts-db-after-mutation"
  | "journey-uses-multiple-apis"
  | "journey-uses-real-database";

// line: ソースの中の位置で決まる違反だけ持つ（1 始まり）。ファイル全体で決まる違反（置き場所・必須の import）は持たない。
type JourneyViolation = { rule: JourneyRuleId; line?: number };

const JOURNEYS_DIR = "apps/backend/journeys/";

// ジャーニーのファイルか（apps/backend/journeys/ の直下の *.journey.test.ts）。
function isJourneyFile(path: string): boolean {
  return /^apps\/backend\/journeys\/[^/]+\.journey\.test\.ts$/.test(path);
}

// path（リポジトリ相対、/ 区切り）が置き場所の規則に違反するか。
function isMisplacedJourneyFile(path: string): boolean {
  if (path.startsWith(JOURNEYS_DIR)) {
    return !isJourneyFile(path);
  }
  // WHY 拡張子を広く取る: .tsx・.js などで journeys/ の外に置いても、置き場所の違反として見つける。
  return /\.journey\.test\.[cm]?[jt]sx?$/.test(path);
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
// WHY 解決して比べる: `../test-support/database` と `@repo/backend/test-support/database` は同じモジュール。書き方の文字列で
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

// vitest の import が vi に届くか（journey-no-vi）。
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

// handler の名前の規約（journey-handler-naming）: HTTP メソッドで始まる（大文字小文字を区別しない前方一致）。
function isHandlerName(name: string): boolean {
  return /^(?:get|list|post|put|patch|delete)/i.test(name);
}

// 変更系の handler の名前か（journey-asserts-db-after-mutation）。読み取り系（get / list）は含めない。
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

// `new XxxApi(` の名前の違反（journey-handler-naming）。行は `new XxxApi(` の行。
function findHandlerNamingViolations(code: string): JourneyViolation[] {
  return [...code.matchAll(/\bnew\s+[A-Z][\w$]*Api\s*\(/g)]
    .filter((match) => {
      const name = /([A-Za-z_$][\w$]*)\s*[=:]\s*$/.exec(
        code.slice(0, match.index),
      )?.[1];
      return name === undefined || !isHandlerName(name);
    })
    .map((match) => ({
      rule: "journey-handler-naming",
      line: lineAt(code, match.index),
    }));
}

// 変更系の呼び出しの後に DB の読み取りが無い違反（journey-asserts-db-after-mutation）。行は呼び出しの名前の行。
// 呼び出しの形: `await a(`・`await a.b(`（最後の名前）・`await a.handle(` / `await x.a.handle(`（handle の前の名前）。
function findMissingDbReadViolations(code: string): JourneyViolation[] {
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
      rule: "journey-asserts-db-after-mutation",
      line: lineAt(code, mutation.index),
    }));
}

// 実 Postgres のテスト用の DB を用意するモジュール（リポジトリ相対、拡張子なし）。
const TEST_DATABASE_MODULE = "apps/backend/test-support/database";

// ジャーニー（isJourneyFile のファイル）の中身の違反。行のあるものを行の順に、その後にファイル全体の違反を返す。
function findJourneyContentViolations(
  path: string,
  source: string,
): JourneyViolation[] {
  const code = stripComments(source);
  const imports = extractImports(code);
  const inMemory = imports
    .filter((ref) => /\.in-memory$/.test(moduleBaseName(ref.specifier)))
    .map(
      (ref): JourneyViolation => ({
        rule: "journey-no-in-memory",
        line: ref.line,
      }),
    );
  const vitestImports = imports
    .filter((ref) => ref.specifier === "vitest" && reachesVi(ref))
    .map(
      (ref): JourneyViolation => ({ rule: "journey-no-vi", line: ref.line }),
    );
  const valueModules = imports
    .filter((ref) => ref.kind === "value")
    .map((ref) => resolveSpecifier(path, ref.specifier));
  const apis = new Set(
    valueModules.filter(
      (module) => module !== undefined && /\.api$/.test(posix.basename(module)),
    ),
  );
  const fileLevel: JourneyViolation[] = [
    ...(apis.size >= 2
      ? []
      : [{ rule: "journey-uses-multiple-apis" as const }]),
    ...(valueModules.includes(TEST_DATABASE_MODULE)
      ? []
      : [{ rule: "journey-uses-real-database" as const }]),
  ];
  const lineLevel = [
    ...inMemory,
    ...vitestImports,
    ...findHandlerNamingViolations(code),
    ...findMissingDbReadViolations(code),
  ].sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return [...lineLevel, ...fileLevel];
}

// path の違反。置き場所が違えば置き場所の違反だけを返し（中身は見ない）、ジャーニーなら中身を見る。対象外のファイルは []。
function findJourneyViolations(
  path: string,
  source: string,
): JourneyViolation[] {
  if (isMisplacedJourneyFile(path)) {
    return [{ rule: "journey-placement" }];
  }
  return isJourneyFile(path) ? findJourneyContentViolations(path, source) : [];
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

// 検査の対象: apps/ の下のファイルのうち、apps/backend/journeys/ の下にあるものと、名前が *.journey.test.* のもの。名前順。
// WHY root を引数で受け取る: 本番（リポジトリ直下）と fixture（一時ディレクトリ）で同じ列挙を通すため。
function listJourneyTargets(root: string): string[] {
  return walk(root, "apps")
    .filter(
      (path) =>
        path.startsWith(JOURNEYS_DIR) ||
        /\.journey\.test\.[cm]?[jt]sx?$/.test(path),
    )
    .sort();
}

// 違反を「<規則>: <パス>」か「<規則>: <パス>:<行>」で返す。
function collectJourneyViolations(root: string): string[] {
  return listJourneyTargets(root).flatMap((path) =>
    findJourneyViolations(path, readFileSync(join(root, path), "utf8")).map(
      ({ rule, line }) =>
        line === undefined ? `${rule}: ${path}` : `${rule}: ${path}:${line}`,
    ),
  );
}

const repoRoot = join(import.meta.dirname, "..");

// テストの入力を行の配列で書き、1 行目を 1 として違反の行番号を読みやすくする。
const source = (...lines: string[]) => lines.join("\n");

const JOURNEY = "apps/backend/journeys/x.journey.test.ts";
const CREATE_API = "../features/x/presentation/create-x.api";
const LIST_API = "../features/x/presentation/list-x.api";
// ジャーニーの必須の import（実 DB と 2 つの api）。must reject の例は、これに違反を 1 つ足すか、どれかを欠く。
const DATABASE_IMPORT =
  'import { createTestDatabase } from "../test-support/database";';
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

describe("ジャーニーの置き場所（isMisplacedJourneyFile）", () => {
  it.each([
    ["apps/backend/journeys/ の直下の *.journey.test.ts", JOURNEY],
    [
      "apps/backend/ の層の下の普通のテスト",
      "apps/backend/features/x/presentation/x.api.test.ts",
    ],
    ["apps/backend/ のソース", "apps/backend/features/x/domain/x.ts"],
    [
      "名前に journey を含むが *.journey.test.* ではないファイル",
      "apps/backend/features/journey/domain/journey.test.ts",
    ],
  ])("%s は違反なし", (_name, path) => {
    expect(isMisplacedJourneyFile(path)).toBe(false);
  });

  it.each([
    ["journeys/ の .journey の無いテスト", "apps/backend/journeys/x.test.ts"],
    ["journeys/ のテスト以外のソース", "apps/backend/journeys/helper.ts"],
    ["journeys/ の .md", "apps/backend/journeys/README.md"],
    [
      "journeys/ のサブディレクトリの中のジャーニー",
      "apps/backend/journeys/todo/x.journey.test.ts",
    ],
    [
      "journeys/ の .tsx のジャーニー",
      "apps/backend/journeys/x.journey.test.tsx",
    ],
    [
      "feature の下の journeys/ のジャーニー",
      "apps/backend/features/x/journeys/x.journey.test.ts",
    ],
    [
      "apps/backend/ の直下以外の journeys/（shared/journeys/）",
      "apps/backend/shared/journeys/x.journey.test.ts",
    ],
    [
      "frontend のジャーニー",
      "apps/frontend_customer/features/x/x.journey.test.tsx",
    ],
  ])("%s は違反", (_name, path) => {
    expect(isMisplacedJourneyFile(path)).toBe(true);
  });
});

describe("ジャーニーの中身（findJourneyViolations）: must pass", () => {
  it.each([
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
        'import { ListXApi } from "@repo/backend/features/x/presentation/list-x.api.ts";',
      ),
    ],
    [
      "別の feature の api を 1 つずつ（feature をまたぐ流れ）",
      source(
        DATABASE_IMPORT,
        'import { CreateXApi } from "../features/x/presentation/create-x.api";',
        'import { CreateYApi } from "../features/y/presentation/create-y.api";',
      ),
    ],
    [
      "Postgres の Repository・command / query を import（InMemory ではない）",
      source(
        ...REQUIRED_IMPORTS,
        'import { PostgresXRepository } from "../features/x/infra/x-repository.postgres";',
        'import { CreateXCommand } from "../features/x/application/create-x.command";',
      ),
    ],
    [
      "コメントの中の vi.mock( / vi.doMock( / InMemory の import（行コメントとブロックコメント）",
      source(
        ...REQUIRED_IMPORTS,
        '// vi.mock("@repo/shared/now") は使わない。',
        '/* vi.doMock("./x"); import { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory"; */',
        '// import { vi } from "vitest";',
        'const url = "http://localhost"; // import "../features/x/infra/x-repository.in-memory";',
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
  ])("%s は違反なし", (_name, text) => {
    expect(findJourneyViolations(JOURNEY, text)).toEqual([]);
  });

  it("ジャーニーでないファイル（層の下のテスト）は中身を見ない", () => {
    expect(
      findJourneyViolations(
        "apps/backend/features/x/presentation/x.api.test.ts",
        source(
          'import { vi } from "vitest";',
          "const renameX = new RenameXApi(command).handle;",
        ),
      ),
    ).toEqual([]);
  });
});

describe("ジャーニーの中身（findJourneyViolations）: must reject", () => {
  it.each<[string, string, JourneyViolation[]]>([
    [
      "InMemory の Repository を値で import",
      source(
        ...REQUIRED_IMPORTS,
        'import { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory";',
      ),
      [{ rule: "journey-no-in-memory", line: 4 }],
    ],
    [
      "InMemory を import type で（型だけでも違反）",
      source(
        ...REQUIRED_IMPORTS,
        'import type { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory";',
      ),
      [{ rule: "journey-no-in-memory", line: 4 }],
    ],
    [
      "InMemory を inline の type・拡張子付き・@repo/backend/ で",
      source(
        ...REQUIRED_IMPORTS,
        'import { type InMemoryXRepository } from "@repo/backend/features/x/infra/x-repository.in-memory.ts";',
      ),
      [{ rule: "journey-no-in-memory", line: 4 }],
    ],
    [
      "InMemory を dynamic import()・副作用の import・export … from（複数行）",
      source(
        ...REQUIRED_IMPORTS,
        'const m = await import("../features/x/infra/x-repository.in-memory");',
        'import "../features/x/infra/x-repository.in-memory";',
        "export {",
        "  InMemoryXRepository,",
        '} from "../features/x/infra/x-repository.in-memory";',
      ),
      [
        { rule: "journey-no-in-memory", line: 4 },
        { rule: "journey-no-in-memory", line: 5 },
        { rule: "journey-no-in-memory", line: 8 },
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
      [{ rule: "journey-no-vi", line: 4 }],
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
      [{ rule: "journey-no-vi", line: 8 }],
    ],
    [
      "vi と同じものの別名 vitest を単独で import（vitest.spyOn などが使える）",
      source(
        ...REQUIRED_IMPORTS,
        'import { vitest } from "vitest";',
        'vitest.spyOn(console, "error");',
      ),
      [{ rule: "journey-no-vi", line: 4 }],
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
        { rule: "journey-no-vi", line: 4 },
        { rule: "journey-no-vi", line: 6 },
      ],
    ],
    [
      'dynamic import("vitest")（vi?.mock も）',
      source(
        ...REQUIRED_IMPORTS,
        'const { vi } = await import("vitest");',
        'vi?.mock("./x");',
      ),
      [{ rule: "journey-no-vi", line: 4 }],
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
        { rule: "journey-handler-naming", line: 4 },
        { rule: "journey-handler-naming", line: 5 },
        { rule: "journey-handler-naming", line: 6 },
        { rule: "journey-handler-naming", line: 7 },
        { rule: "journey-handler-naming", line: 9 },
        { rule: "journey-handler-naming", line: 10 },
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
      [{ rule: "journey-asserts-db-after-mutation", line: 6 }],
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
      [{ rule: "journey-asserts-db-after-mutation", line: 8 }],
    ],
    [
      "db.select( が変更系より前にだけある",
      source(...JOURNEY_HEAD, DB_READ, "await postX(request);"),
      [{ rule: "journey-asserts-db-after-mutation", line: 7 }],
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
      [{ rule: "journey-asserts-db-after-mutation", line: 6 }],
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
      [{ rule: "journey-asserts-db-after-mutation", line: 6 }],
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
        { rule: "journey-asserts-db-after-mutation", line: 9 },
        { rule: "journey-asserts-db-after-mutation", line: 10 },
        { rule: "journey-asserts-db-after-mutation", line: 12 },
      ],
    ],
    [
      "api を 1 つだけ import",
      source(DATABASE_IMPORT, CREATE_API_IMPORT),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "同じ api を書き方を変えて 2 回（相対・拡張子付き・@repo/backend/）",
      source(
        DATABASE_IMPORT,
        `import { CreateXApi } from "${CREATE_API}";`,
        `import { CreateXApi as ApiWithExtension } from "${CREATE_API}.ts";`,
        'import { CreateXApi as Api } from "@repo/backend/features/x/presentation/create-x.api";',
      ),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "2 つ目の api が import type・inline の type だけ",
      source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        `import type { ListXResponse } from "${LIST_API}";`,
        'import { type GetXResponse } from "../features/x/presentation/get-x.api";',
      ),
      [{ rule: "journey-uses-multiple-apis" }],
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
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "api の単体テストや名前の一部だけが api のモジュール（x.api.test・x.api-helper・api）",
      source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        'import { a } from "../features/x/presentation/list-x.api.test";',
        'import { b } from "../features/x/presentation/x.api-helper";',
        'import { c } from "../features/x/presentation/api";',
      ),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "api をコメントの中でだけ import",
      source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        `// import { ListXApi } from "${LIST_API}";`,
      ),
      [{ rule: "journey-uses-multiple-apis" }],
    ],
    [
      "test-support/database を import しない",
      source(CREATE_API_IMPORT, LIST_API_IMPORT),
      [{ rule: "journey-uses-real-database" }],
    ],
    [
      "test-support/database を import type だけ",
      source(
        'import type { TestDatabase } from "../test-support/database";',
        CREATE_API_IMPORT,
        LIST_API_IMPORT,
      ),
      [{ rule: "journey-uses-real-database" }],
    ],
    [
      "名前・場所の一部だけが同じ別のモジュール（shared/infra/database・database-x・別の場所の test-support/database）",
      source(
        'import { getDatabase } from "../shared/infra/database";',
        'import { a } from "../test-support/database-x";',
        'import { b } from "./test-support/database";',
        CREATE_API_IMPORT,
        LIST_API_IMPORT,
      ),
      [{ rule: "journey-uses-real-database" }],
    ],
    [
      "空のファイル（すべての必須を欠く）",
      "",
      [
        { rule: "journey-uses-multiple-apis" },
        { rule: "journey-uses-real-database" },
      ],
    ],
    [
      "違反が重なる（行のある違反を行の順に、その後にファイル全体の違反）",
      source(
        'import { vi } from "vitest";',
        'import { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory";',
        CREATE_API_IMPORT,
        "const createX = new CreateXApi(command).handle;",
        "await createX(request);",
        "const postX = new CreateXApi(command).handle;",
        "await postX(request);",
      ),
      [
        { rule: "journey-no-vi", line: 1 },
        { rule: "journey-no-in-memory", line: 2 },
        { rule: "journey-handler-naming", line: 4 },
        { rule: "journey-asserts-db-after-mutation", line: 7 },
        { rule: "journey-uses-multiple-apis" },
        { rule: "journey-uses-real-database" },
      ],
    ],
  ])("%s は違反", (_name, text, expected) => {
    expect(findJourneyViolations(JOURNEY, text)).toEqual(expected);
  });

  it("置き場所が違えば置き場所の違反だけを返す（中身は見ない）", () => {
    expect(
      findJourneyViolations(
        "apps/backend/journeys/x.test.ts",
        'import { vi } from "vitest";',
      ),
    ).toEqual([{ rule: "journey-placement" }]);
  });
});

// --- 列挙 → 読み取り → 判定を通した fixture テスト ---
// WHY: 判定が正しくても、対象の列挙（journeys/ の下と *.journey.test.* の見つけ方）が漏れれば見逃す。一時ディレクトリに架空の
//   ツリーを置き、本番と同じ collectJourneyViolations に通して、違反の集合を丸ごと比較する（見逃しも余分な検出も失敗にする）。
describe("ジャーニーの列挙と検査（fixture）", () => {
  // WHY OS の一時ディレクトリに置く: リポジトリ内に置くと本番の検査や Biome・git の差分に混ざる。afterAll で消す。
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  function fixture(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), "journey-"));
    roots.push(root);
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return root;
  }

  it("journeys/ の下と *.journey.test.* を対象にし、違反を「規則: パス(:行)」で返す", () => {
    const root = fixture({
      [JOURNEY]: source(...REQUIRED_IMPORTS),
      "apps/backend/journeys/mock.journey.test.ts": source(
        ...REQUIRED_IMPORTS,
        'import { vi } from "vitest";',
        'vi.mock("@repo/shared/now");',
      ),
      "apps/backend/journeys/no-db-check.journey.test.ts": source(
        ...JOURNEY_HEAD,
        "const renameX = new RenameXApi(command).handle;",
        "await postX(request);",
        DB_READ,
        "await renameX(request);",
        "await postX(request);",
      ),
      "apps/backend/journeys/single-api.journey.test.ts": source(
        DATABASE_IMPORT,
        CREATE_API_IMPORT,
        'import { InMemoryXRepository } from "../features/x/infra/x-repository.in-memory";',
      ),
      "apps/backend/journeys/x.test.ts": source(...REQUIRED_IMPORTS),
      "apps/backend/journeys/helper.ts": "export const a = 1;\n",
      "apps/backend/journeys/nested/y.journey.test.ts": source(
        ...REQUIRED_IMPORTS,
      ),
      "apps/backend/features/x/journeys/x.journey.test.ts": source(
        ...REQUIRED_IMPORTS,
      ),
      // 対象外: 層の下のテスト（vi.mock があってもジャーニーではない）、node_modules と . で始まるディレクトリの中。
      "apps/backend/features/x/presentation/x.api.test.ts": source(
        'import { vi } from "vitest";',
        "await renameX(request);",
      ),
      "apps/backend/node_modules/x/x.journey.test.ts": "",
      "apps/frontend_customer/.next/x.journey.test.ts": "",
    });
    expect({
      files: listJourneyTargets(root),
      violations: collectJourneyViolations(root),
    }).toEqual({
      files: [
        "apps/backend/features/x/journeys/x.journey.test.ts",
        "apps/backend/journeys/helper.ts",
        "apps/backend/journeys/mock.journey.test.ts",
        "apps/backend/journeys/nested/y.journey.test.ts",
        "apps/backend/journeys/no-db-check.journey.test.ts",
        "apps/backend/journeys/single-api.journey.test.ts",
        "apps/backend/journeys/x.journey.test.ts",
        "apps/backend/journeys/x.test.ts",
      ],
      violations: [
        "journey-placement: apps/backend/features/x/journeys/x.journey.test.ts",
        "journey-placement: apps/backend/journeys/helper.ts",
        "journey-no-vi: apps/backend/journeys/mock.journey.test.ts:4",
        "journey-placement: apps/backend/journeys/nested/y.journey.test.ts",
        "journey-handler-naming: apps/backend/journeys/no-db-check.journey.test.ts:6",
        "journey-asserts-db-after-mutation: apps/backend/journeys/no-db-check.journey.test.ts:10",
        "journey-no-in-memory: apps/backend/journeys/single-api.journey.test.ts:3",
        "journey-uses-multiple-apis: apps/backend/journeys/single-api.journey.test.ts",
        "journey-placement: apps/backend/journeys/x.test.ts",
      ],
    });
  });

  it("apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）", () => {
    const root = fixture({ "README.md": "# x\n" });
    expect({
      files: listJourneyTargets(root),
      violations: collectJourneyViolations(root),
    }).toEqual({ files: [], violations: [] });
  });
});

describe("ジャーニー（実ファイル）", () => {
  it("apps/backend/journeys/ には *.journey.test.ts だけがあり、各ジャーニーは InMemory と vi を使わず、実 DB と 2 つ以上の API を使い、変更系の API の後に DB を読む", () => {
    // WHY 対象を確かめてから違反 0 件を見る: 列挙が壊れて 0 件になると、違反も 0 件になり常に緑になる。
    expect(listJourneyTargets(repoRoot)).toContain(
      "apps/backend/journeys/todo-lifecycle.journey.test.ts",
    );
    expect(collectJourneyViolations(repoRoot)).toEqual([]);
  });
});

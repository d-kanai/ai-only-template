// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom（コンポーネントテスト用）だが、このテストはファイルを読むだけで
//   DOM を使わない。Node 環境で動かし、jsdom の初期化コストと無関係な差異を避ける。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// pnpm-workspace.yaml のサプライチェーン保護と版の書き方の設定（.claude/rules/dependencies.md）を仕様として固定するテスト。
// ルール検査テスト（.claude/rules/testing.md）なので、読み取り（readTopLevelSettings）と判定（findWorkspaceSettingViolations）を
// 関数に切り出し、許可される例（must pass）と違反の例（must reject）の両方で固定する。

const repoRoot = join(import.meta.dirname, "..");

// WHY yaml パーサを依存に加えない: 検査したいのはトップレベルのキーと、その 1 段下のキー（allowBuilds の中身）だけで、
//   行単位の読み取りで足りる（依存を増やすとサプライチェーンの対象も増える）。
// WHY `pnpm config list --json` で pnpm 自身の解釈を読まない: pnpm は環境変数（pnpm_config_minimum_release_age=1 など）を
//   pnpm-workspace.yaml より優先する（2026-09-28、pnpm 12.7.0 で実測）。検査したいのはリポジトリにコミットされたファイルの
//   中身なので、実行環境の影響を受けないファイルの読み取りにする。
// 読み取りの仕様（下の must reject / must pass で固定する）:
//   - `#` で始まる行（コメントアウトした設定を含む）は読まない。値の後ろの ` # ...` もコメントとして捨てる。
//   - 行頭（インデントなし）の `key: value` をトップレベルの設定とする。インデントされた行は直前のトップレベルのキー
//     （値が空の行）の子として読むので、ネストの中の同名キーはトップレベルの設定として数えない。
//   - 子は最初の子のインデントと同じ深さの `key: value` だけを読む。それより深い行やリストの行（`- x`）は読まない。
//   - 値は true / false を真偽値、整数を数、'...' / "..." を中身の文字列、それ以外をそのままの文字列にする。
//     フローの書き方（`allowBuilds: { lefthook: true }`）などは文字列のまま残り、期待値と一致せず違反になる
//     （見逃す方向ではなく、多く検出する方向に倒れる）。
//   - トップレベルのキーの重複は YAML の仕様で不正なので、例外にする。
// 限界: pnpm 自身が読めない YAML（タブのインデント、`minimumReleaseAge: 07200`、allowBuilds の値が空の子の下の孫）は、
//   ここでは「違反なし」になりうる。いずれも pnpm 12.7.0 の `pnpm config get` が「Failed to parse pnpm-workspace.yaml」で
//   止まる（2026-09-28 実測）ので、install も止まり実害はない。
//   逆に `minimumReleaseAge: "7200"`（クォートした文字列）と値の後ろの空白（`7200 `）は、pnpm は 7200 と読む（同じ実測）が、
//   ここでは安全側に倒して違反にする（must reject で固定）。
type Scalar = string | number | boolean;
type Settings = Record<string, Scalar | Record<string, Scalar>>;

// WHY キーの先頭に `#` を許さない: コメントの行（コメントアウトした設定 `# minimumReleaseAge: 7200` を含む）を
//   設定として読まないため。コメントの行はどちらの正規表現にも一致せず、読み飛ばされる。
//   CHILD_ENTRY は先頭の `-` も許さない（リストの行 `- x` を子として読まない）。
const TOP_LEVEL_ENTRY = /^([^\s#][^:]*):(?:\s+(.*))?$/;
const CHILD_ENTRY = /^(\s+)([^\s#-][^:]*):\s+(.*)$/;
const QUOTED = /^(['"])(.*)\1$/;
const INTEGER = /^-?\d+$/;
const TRAILING_COMMENT = /(?:^|\s+)#.*$/;

function unquote(text: string): string {
  return text.match(QUOTED)?.[2] ?? text;
}

function parseScalar(raw: string): Scalar {
  // WHY クォートの後ろのコメント（`'x' # 理由`）をここで除く: 子の値は CHILD_ENTRY から生のまま渡るため。
  //   トップレベルの値は splitTopLevelBlocks で先に ` #` 以降を除いてから渡る。そのため、トップレベルのクォートの中に
  //   ` #` があると値が途中で切れるが、検査する値（7200 / true / '' など）にその形は無く、切れた場合は期待値と一致せず
  //   違反になる（見逃す方向ではない）。
  const quoted = raw.match(/^(['"])(.*?)\1(?:\s+#.*)?$/);
  if (quoted) return quoted[2];
  const plain = raw.replace(TRAILING_COMMENT, "");
  if (plain === "true") return true;
  if (plain === "false") return false;
  if (INTEGER.test(plain)) return Number(plain);
  return plain;
}

type TopLevelBlock = { key: string; value: string; childLines: string[] };

// トップレベルの行ごとに、続くインデントされた行（子の候補）をまとめる。
function splitTopLevelBlocks(yaml: string): TopLevelBlock[] {
  const blocks: TopLevelBlock[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const top = line.match(TOP_LEVEL_ENTRY);
    if (top) {
      blocks.push({
        key: unquote(top[1].trim()),
        value: (top[2] ?? "").replace(TRAILING_COMMENT, ""),
        childLines: [],
      });
    } else {
      blocks.at(-1)?.childLines.push(line);
    }
  }
  return blocks;
}

// WHY 最初の子と同じ深さの `key: value` だけを読む: それより深い行は孫（子のマップの中身）で、
//   同名のキーがあっても子として数えないため。リストの行（`- x`）は CHILD_ENTRY に一致しないので読まない。
function readChildren(lines: string[]): Record<string, Scalar> {
  const children: Record<string, Scalar> = {};
  let indent: string | undefined;
  for (const line of lines) {
    const child = line.match(CHILD_ENTRY);
    if (!child) continue;
    indent ??= child[1];
    if (child[1] === indent) {
      children[unquote(child[2].trim())] = parseScalar(child[3]);
    }
  }
  return children;
}

// WHY 値が空のトップレベルのキーだけを子を持つマップとして読む: 値のあるキー（`minimumReleaseAge: 7200`）の後に
//   インデントされた行が続いても、YAML としては不正で、子として数えると誤った設定を「あり」と読んでしまうため。
function readTopLevelSettings(yaml: string): Settings {
  const settings: Settings = {};
  for (const block of splitTopLevelBlocks(yaml)) {
    if (block.key in settings) {
      throw new Error(`トップレベルのキー ${block.key} が重複しています`);
    }
    settings[block.key] =
      block.value === ""
        ? readChildren(block.childLines)
        : parseScalar(block.value);
  }
  return settings;
}

// WHY 各値（検査する設定と、その値にしている理由）:
//   - minimumReleaseAge: 7200（5 日）: 悪意あるリリースは公開から数日以内に検知・削除されることが多く、1 日では短い。
//     一方、開発機の safe-chain と同じ 14 日に揃えると Next.js などの更新に 2 週間遅れで追随することになるため、
//     ユーザーの判断で 5 日にした（Issue #32）。pnpm 側の設定は safe-chain の有無（クラウドセッション・CI）に
//     関係なく効く防御なので、値が意図せず下がっていないことをテストで担保する。
//   - minimumReleaseAgeStrict: true: 非 strict だと条件を満たす版がないときに古い版へ黙ってフォールバックし、
//     lockfile の内容が意図しない版に変わりうる。失敗させて人間・AI に気づかせる。
//   - savePrefix: ''（空文字）: `pnpm add <pkg>` で版を書き忘れても範囲指定（既定の '^'）にならないようにする
//     （依存は完全固定。.claude/rules/dependencies.md）。
//   - allowBuilds: 依存のビルドスクリプト（postinstall 等）は任意コードを実行できるため、許可・不許可をパッケージごとに
//     レビューして決めている（各パッケージの理由は pnpm-workspace.yaml のコメント）。許可（true）が黙って増えたり、
//     lefthook（pre-commit の導入に必要）が false になったりしないよう、中身を丸ごと比較する。
//     パッケージを足す・変えるときは、pnpm-workspace.yaml と一緒にここも直す。
const EXPECTED_SETTINGS: Settings = {
  minimumReleaseAge: 7200,
  minimumReleaseAgeStrict: true,
  savePrefix: "",
  allowBuilds: {
    esbuild: false,
    sharp: false,
    "unrs-resolver": false,
    workerd: false,
    lefthook: true,
  },
};

type SettingViolation = {
  key: string;
  expected: Settings[string];
  actual: Settings[string] | undefined;
};

function findWorkspaceSettingViolations(
  settings: Settings,
): SettingViolation[] {
  return Object.entries(EXPECTED_SETTINGS)
    .filter(([key, expected]) => !isDeepStrictEqual(settings[key], expected))
    .map(([key, expected]) => ({ key, expected, actual: settings[key] }));
}

function readWorkspaceSettings(path: string): Settings {
  return readTopLevelSettings(readFileSync(path, "utf8"));
}

function violationsOf(yaml: string): string[] {
  return findWorkspaceSettingViolations(readTopLevelSettings(yaml)).map(
    (violation) => violation.key,
  );
}

// 本物の pnpm-workspace.yaml と同じ形（コメント、他の設定、クォートしたキー）を持つ、許可される設定の例。
const VALID_YAML = [
  "# pnpm の設定ファイル",
  "allowBuilds:",
  "  esbuild: false",
  "  sharp: false",
  "  unrs-resolver: false",
  "  workerd: false",
  "  lefthook: true",
  "",
  "# ---- サプライチェーン保護設定 ----",
  "minimumReleaseAge: 7200",
  "",
  "minimumReleaseAgeStrict: true",
  "trustPolicy: no-downgrade",
  "savePrefix: ''",
  "",
  "patchedDependencies:",
  "  '@scope/pkg@1.0.0': patches/@scope__pkg@1.0.0.patch",
  "",
].join("\n");

// WHY 置換の対象が 1 か所だけ一致することを確かめる: 一致しないまま置換すると元の VALID_YAML のままになり、
//   must reject の例が「違反を含まない YAML」になって、テストが何を検査しているか分からなくなる（LEARNINGS.md）。
function replaceOnce(text: string, from: string, to: string): string {
  expect(text.split(from)).toHaveLength(2);
  return text.replace(from, to);
}

describe("設定の読み取りと判定（must pass）", () => {
  it("期待どおりの設定だけなら違反なし", () => {
    expect(violationsOf(VALID_YAML)).toEqual([]);
  });

  it("値の後ろのコメントは値に含めない", () => {
    expect(
      violationsOf(
        replaceOnce(
          VALID_YAML,
          "minimumReleaseAge: 7200\n",
          "minimumReleaseAge: 7200 # 5 日\n",
        ),
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "子の間の、インデントされた `key: value` 形式のコメント行",
      "  sharp: false\n",
      "  sharp: false\n  # note: x\n",
    ],
    [
      "子の間の、行頭の `key: value` 形式のコメント行",
      "  sharp: false\n",
      "  sharp: false\n# a: b\n",
    ],
    [
      "子の値の後ろのコメント",
      "  lefthook: true\n",
      "  lefthook: true # 理由\n",
    ],
  ])("%s は読まない（違反なし）", (_case, from, to) => {
    expect(violationsOf(replaceOnce(VALID_YAML, from, to))).toEqual([]);
  });

  it("改行が CRLF でも読める", () => {
    expect(violationsOf(VALID_YAML.replaceAll("\n", "\r\n"))).toEqual([]);
  });

  it("トップレベルと子の値を型付きで読む", () => {
    expect(readTopLevelSettings(VALID_YAML)).toEqual({
      allowBuilds: {
        esbuild: false,
        sharp: false,
        "unrs-resolver": false,
        workerd: false,
        lefthook: true,
      },
      minimumReleaseAge: 7200,
      minimumReleaseAgeStrict: true,
      trustPolicy: "no-downgrade",
      savePrefix: "",
      patchedDependencies: {
        "@scope/pkg@1.0.0": "patches/@scope__pkg@1.0.0.patch",
      },
    });
  });
});

describe("設定の読み取りと判定（must reject）", () => {
  it.each([
    [
      "minimumReleaseAge が無い",
      (yaml: string) => replaceOnce(yaml, "minimumReleaseAge: 7200\n", ""),
      ["minimumReleaseAge"],
    ],
    [
      "minimumReleaseAge の値が違う（1440 = 1 日）",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "minimumReleaseAge: 7200\n",
          "minimumReleaseAge: 1440\n",
        ),
      ["minimumReleaseAge"],
    ],
    [
      "minimumReleaseAge がコメントアウトされている",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "minimumReleaseAge: 7200\n",
          "# minimumReleaseAge: 7200\n",
        ),
      ["minimumReleaseAge"],
    ],
    [
      "minimumReleaseAge が別のキーのネストの中にだけある",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "minimumReleaseAge: 7200\n",
          "overrides:\n  minimumReleaseAge: 7200\n",
        ),
      ["minimumReleaseAge"],
    ],
    [
      "minimumReleaseAge がインデントされて allowBuilds の子になっている",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "minimumReleaseAge: 7200\n",
          "  minimumReleaseAge: 7200\n",
        ),
      ["minimumReleaseAge", "allowBuilds"],
    ],
    [
      "minimumReleaseAgeStrict が false",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "minimumReleaseAgeStrict: true",
          "minimumReleaseAgeStrict: false",
        ),
      ["minimumReleaseAgeStrict"],
    ],
    [
      "minimumReleaseAgeStrict が無い",
      (yaml: string) =>
        replaceOnce(yaml, "minimumReleaseAgeStrict: true\n", ""),
      ["minimumReleaseAgeStrict"],
    ],
    [
      "savePrefix が '^'",
      (yaml: string) => replaceOnce(yaml, "savePrefix: ''", "savePrefix: '^'"),
      ["savePrefix"],
    ],
    [
      "savePrefix が無い（pnpm の既定は '^'）",
      (yaml: string) => replaceOnce(yaml, "savePrefix: ''\n", ""),
      ["savePrefix"],
    ],
    [
      "allowBuilds の lefthook が false",
      (yaml: string) =>
        replaceOnce(yaml, "  lefthook: true", "  lefthook: false"),
      ["allowBuilds"],
    ],
    [
      "allowBuilds に許可（true）のパッケージが増えている",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "  lefthook: true\n",
          "  lefthook: true\n  evil: true\n",
        ),
      ["allowBuilds"],
    ],
    [
      "allowBuilds から不許可（false）のパッケージが消えている",
      (yaml: string) => replaceOnce(yaml, "  sharp: false\n", ""),
      ["allowBuilds"],
    ],
    [
      "allowBuilds の lefthook が、さらに深いネストの中にだけある",
      (yaml: string) =>
        replaceOnce(yaml, "  lefthook: true", "  nested:\n    lefthook: true"),
      ["allowBuilds"],
    ],
    [
      "allowBuilds の lefthook がコメントアウトされている",
      (yaml: string) =>
        replaceOnce(yaml, "  lefthook: true", "  # lefthook: true"),
      ["allowBuilds"],
    ],
    [
      "allowBuilds がフローの書き方で書かれている（読み取りの対象外）",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "allowBuilds:\n  esbuild: false\n  sharp: false\n  unrs-resolver: false\n  workerd: false\n  lefthook: true\n",
          "allowBuilds: { esbuild: false, sharp: false, unrs-resolver: false, workerd: false, lefthook: true }\n",
        ),
      ["allowBuilds"],
    ],
    [
      "allowBuilds が無い",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "allowBuilds:\n  esbuild: false\n  sharp: false\n  unrs-resolver: false\n  workerd: false\n  lefthook: true\n",
          "",
        ),
      ["allowBuilds"],
    ],
    // 安全側に倒して違反にするもの（pnpm は 7200 と読むが、書き方を 1 通りにする。上の「限界」）。
    [
      "minimumReleaseAge がクォートした文字列",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "minimumReleaseAge: 7200\n",
          'minimumReleaseAge: "7200"\n',
        ),
      ["minimumReleaseAge"],
    ],
    [
      "minimumReleaseAge の値の後ろに空白がある",
      (yaml: string) =>
        replaceOnce(
          yaml,
          "minimumReleaseAge: 7200\n",
          "minimumReleaseAge: 7200 \n",
        ),
      ["minimumReleaseAge"],
    ],
    // WHY: 読み取りが空（ファイルの取り違えなど）でも「違反なし」にならず、すべての設定が欠けていると報告すること。
    [
      "ファイルが空",
      () => "",
      [
        "minimumReleaseAge",
        "minimumReleaseAgeStrict",
        "savePrefix",
        "allowBuilds",
      ],
    ],
  ])("%s と違反になる", (_case, mutate, expectedKeys) => {
    expect(violationsOf(mutate(VALID_YAML))).toEqual(expectedKeys);
  });

  it("トップレベルのキーが重複していると例外にする", () => {
    // WHY toThrow(Error) と message の両方: toThrow("文字列") は throw undefined でも通る（.claude/rules/testing.md）。
    expect(() =>
      readTopLevelSettings(`${VALID_YAML}minimumReleaseAge: 1440\n`),
    ).toThrow(
      expect.objectContaining({
        message: expect.stringContaining("minimumReleaseAge"),
      }),
    );
  });
});

describe("pnpm-workspace.yaml の実ファイル", () => {
  let dir: string;

  beforeAll(() => {
    // WHY: fixture をリポジトリ内に置くと、テストが途中で落ちたときに作業ツリーへ残る。OS の一時ディレクトリに置いて afterAll で消す。
    dir = mkdtempSync(join(tmpdir(), "pnpm-workspace-test-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // 読み込み → 読み取り → 判定を、本番と同じ readWorkspaceSettings で実ファイルから通す
  //   （.claude/rules/testing.md の「ルール検査テスト」）。
  it("違反を含む pnpm-workspace.yaml からは、違反の設定と実際の値をすべて検出する", () => {
    const file = join(dir, "pnpm-workspace.yaml");
    writeFileSync(
      file,
      [
        "allowBuilds:",
        "  esbuild: false",
        "  lefthook: true",
        "  sharp: true",
        "# minimumReleaseAge: 7200",
        "minimumReleaseAgeStrict: true",
        "savePrefix: '^'",
        "",
      ].join("\n"),
    );

    expect(findWorkspaceSettingViolations(readWorkspaceSettings(file))).toEqual(
      [
        {
          key: "minimumReleaseAge",
          expected: 7200,
          actual: undefined,
        },
        { key: "savePrefix", expected: "", actual: "^" },
        {
          key: "allowBuilds",
          expected: EXPECTED_SETTINGS.allowBuilds,
          actual: { esbuild: false, lefthook: true, sharp: true },
        },
      ],
    );
  });

  it("サプライチェーン保護と版の書き方の設定が期待どおり", () => {
    // 失敗時にどの設定がどの値かが出力に出るよう、違反の一覧を空配列と比較する。
    expect(
      findWorkspaceSettingViolations(
        readWorkspaceSettings(join(repoRoot, "pnpm-workspace.yaml")),
      ),
    ).toEqual([]);
  });
});

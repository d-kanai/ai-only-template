// @vitest-environment node
// WHY: vitest.config.mts の既定環境は jsdom だが、このテストはファイルを読むのと bash -n を起動するだけで DOM を使わない。
//
// .claude/settings.json の権限（permissions.deny）とフックの登録を仕様として固定するルール検査テスト
// （WHAT / WHY は .claude/rules/git-guard.md。JSON にはコメントを書けないため）。
// 判定を関数に切り出し、架空の JSON で許可（must pass）と拒否（must reject）を固定してから、同じ関数で実ファイルを検査する。
// .feature（settings.feature）と step の実装（このファイル）に分けた（Issue #282）。
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describeFeature, loadFeature } from "@amiceli/vitest-cucumber";
import { afterAll, beforeAll, expect } from "vitest";
import { casesByName } from "./case-table";

const repoRoot = resolve(__dirname, "..");

// 必ず入っている deny のルール。フック（scripts/hooks/guard-git.sh）と二重にする（WHY は .claude/rules/git-guard.md）。
// 書式は公式 permissions の「Wildcard patterns」: 末尾の `*` の前に空白を置かない形（`--force*`）は `--force-with-lease` も含む。
const REQUIRED_DENY_RULES = [
  "Bash(git push --force*)",
  "Bash(git push -f*)",
  "Bash(git push origin main*)",
  "Bash(git push -u origin main*)",
  "Bash(git commit --no-verify*)",
  "Bash(git merge --squash*)",
  "Bash(LEFTHOOK=0 *)",
];

// PreToolUse の guard-git.sh が見る必要のあるツール。MCP は GitHub への書き込み（PR 作成・マージ・push 相当）だけ。
const GUARDED_TOOLS = [
  "Bash",
  "mcp__github__create_pull_request",
  "mcp__github__merge_pull_request",
  "mcp__github__push_files",
  "mcp__github__create_or_update_file",
  "mcp__github__delete_file",
  "mcp__github__update_pull_request_branch",
];

type ExpectedHook = {
  event: string;
  // undefined: matcher を書かない（matcher を取らないイベントか、すべての発生で動かしたいイベント）。
  matcher?: string;
  command: string;
  timeout?: number;
};

const hookCommand = (script: string) =>
  `bash "$CLAUDE_PROJECT_DIR"/scripts/${script}`;

const PRE_TOOL_USE_MATCHER = GUARDED_TOOLS.join("|");

// 各イベントに登録するスクリプト。matcher の有無は公式 hooks の「Matcher patterns」の表に従う
// （Stop / WorktreeCreate / WorktreeRemove は matcher を取らない。PreCompact / InstructionsLoaded / SubagentStop は取るが、
// すべての発生で動かすので書かない）。
const EXPECTED_HOOKS: ExpectedHook[] = [
  {
    event: "SessionStart",
    matcher: "startup|resume",
    command: hookCommand("cloud-session-start.sh"),
  },
  {
    event: "PreToolUse",
    matcher: PRE_TOOL_USE_MATCHER,
    command: hookCommand("hooks/guard-git.sh"),
    timeout: 60,
  },
  {
    event: "Stop",
    command: hookCommand("hooks/require-work-log.sh"),
    timeout: 60,
  },
  {
    event: "SubagentStop",
    command: hookCommand("hooks/subagent-stop.sh"),
    timeout: 60,
  },
  {
    event: "WorktreeCreate",
    command: hookCommand("hooks/worktree-create.sh"),
    timeout: 300,
  },
  {
    event: "WorktreeRemove",
    command: hookCommand("hooks/worktree-remove.sh"),
    timeout: 60,
  },
  {
    event: "PreCompact",
    command: hookCommand("hooks/pre-compact.sh"),
    timeout: 60,
  },
  {
    event: "InstructionsLoaded",
    command: hookCommand("hooks/instructions-loaded.sh"),
    timeout: 60,
  },
];

// 公式 hooks の「Matcher patterns」に従い、matcher が toolName に当たるかを判定する。
// - "*"・""・undefined: すべてに当たる。
// - 英数字・`_`・`-`・空白・`,`・`|` だけ: `|` か `,` で区切った完全一致の一覧。
// - それ以外の文字を含む: JavaScript の正規表現（アンカーなし。RegExp#test）。
function matcherMatches(matcher: string | undefined, toolName: string) {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map((name) => name.trim())
      .includes(toolName);
  }
  return new RegExp(matcher).test(toolName);
}

function findUncoveredTools(matcher: string | undefined, tools: string[]) {
  return tools.filter((tool) => !matcherMatches(matcher, tool));
}

type HookEntry = { type?: unknown; command?: unknown; timeout?: unknown };
type HookGroup = { matcher?: unknown; hooks?: unknown };

function hookGroups(settings: unknown, event: string): HookGroup[] {
  const hooks = (settings as { hooks?: Record<string, unknown> })?.hooks;
  const groups = hooks?.[event];
  return Array.isArray(groups) ? (groups as HookGroup[]) : [];
}

function groupEntries(group: HookGroup): HookEntry[] {
  return Array.isArray(group.hooks) ? (group.hooks as HookEntry[]) : [];
}

function findMissingDenyRules(settings: unknown, required: string[]) {
  const deny = (settings as { permissions?: { deny?: unknown } })?.permissions
    ?.deny;
  const rules = Array.isArray(deny) ? deny : [];
  return required.filter((rule) => !rules.includes(rule));
}

// 期待する登録（イベント・matcher・コマンド・timeout）が 1 つずつあるかを調べ、足りないものを文で返す。
function findHookProblems(settings: unknown, expected: ExpectedHook[]) {
  return expected.flatMap((hook) => {
    const found = hookGroups(settings, hook.event).some(
      (group) =>
        group.matcher === hook.matcher &&
        groupEntries(group).some(
          (entry) =>
            entry.type === "command" &&
            entry.command === hook.command &&
            entry.timeout === hook.timeout,
        ),
    );
    return found
      ? []
      : [
          `${hook.event}: matcher=${String(hook.matcher)} command=${hook.command} timeout=${String(hook.timeout)} が無い`,
        ];
  });
}

// フックのコマンドから `"$CLAUDE_PROJECT_DIR"/<path>.sh` のスクリプトのパス（リポジトリ直下からの相対）を取り出す。
function listHookScripts(settings: unknown): string[] {
  const hooks = (settings as { hooks?: Record<string, unknown> })?.hooks ?? {};
  const scripts = Object.keys(hooks).flatMap((event) =>
    hookGroups(settings, event).flatMap((group) =>
      groupEntries(group).flatMap((entry) => {
        const match =
          typeof entry.command === "string" &&
          /"\$CLAUDE_PROJECT_DIR"\/(\S+\.sh)/.exec(entry.command);
        return match ? [match[1]] : [];
      }),
    ),
  );
  return [...new Set(scripts)];
}

// スクリプトが無い・bash の構文エラーがあるものを返す。
function findBrokenScripts(root: string, scripts: string[]) {
  return scripts.flatMap((script) => {
    const result = spawnSync("bash", ["-n", join(root, script)], {
      encoding: "utf8",
    });
    return result.status === 0
      ? []
      : [`${script}: ${result.stderr.trim() || `exit ${result.status}`}`];
  });
}

// 権限・フックを黙って効かなくする設定を返す。
// - disableAllHooks: true: guard-git.sh を含むすべてのフックが止まる（公式 hooks の「Disable or remove hooks」）。
// - permissions.defaultMode: "bypassPermissions": deny は効くが、.git・.claude への書き込みも確認なしになり
//   （公式 permissions の「Permission modes」）、settings.json や .git/hooks を黙って書き換えられる。公式ではこのモードを
//   設定ファイルから有効にできるのは user / --settings / managed とあり、プロジェクトの settings.json で効くかは未確認。
// - permissions.allow の Bash / Bash(*): すべての Bash を確認なしで許す（公式: Bash(*) は Bash と同じ）。
function findUnsafeSettings(settings: unknown): string[] {
  const s = (settings ?? {}) as {
    disableAllHooks?: unknown;
    permissions?: { defaultMode?: unknown; allow?: unknown };
  };
  const allow = Array.isArray(s.permissions?.allow) ? s.permissions.allow : [];
  return [
    ...(s.disableAllHooks === true ? ["disableAllHooks: true"] : []),
    ...(s.permissions?.defaultMode === "bypassPermissions"
      ? ["permissions.defaultMode: bypassPermissions"]
      : []),
    ...allow
      .filter((rule) => rule === "Bash" || rule === "Bash(*)")
      .map((rule) => `permissions.allow: ${String(rule)}`),
  ];
}

// EXPECTED_HOOKS に無い登録（想定外のイベント・matcher・コマンド・timeout）を返す。
// WHY: 登録の有無（findHookProblems）だけでは、同じイベントに足された別のフック（例: PreToolUse で常に allow を返すもの）や
//   Stop に足された別の処理に気づけない。登録を足すときは EXPECTED_HOOKS も直す。
function findUnexpectedHooks(settings: unknown, expected: ExpectedHook[]) {
  const hooks = (settings as { hooks?: Record<string, unknown> })?.hooks ?? {};
  return Object.keys(hooks).flatMap((event) =>
    hookGroups(settings, event).flatMap((group) => {
      const entries = groupEntries(group);
      const unexpected = (entry: HookEntry) =>
        !expected.some(
          (hook) =>
            hook.event === event &&
            hook.matcher === group.matcher &&
            entry.type === "command" &&
            hook.command === entry.command &&
            hook.timeout === entry.timeout,
        );
      const found = entries.length === 0 ? [{}] : entries.filter(unexpected);
      return found.map(
        (entry) =>
          `${event}: matcher=${String(group.matcher)} command=${String(entry.command)} は想定外`,
      );
    }),
  );
}

// 架空の settings。EXPECTED_HOOKS と REQUIRED_DENY_RULES をすべて満たす形を作り、テストごとに 1 か所だけ壊す。
function validSettings() {
  const hooks: Record<string, HookGroup[]> = {};
  for (const hook of EXPECTED_HOOKS) {
    const entry: HookEntry = { type: "command", command: hook.command };
    if (hook.timeout !== undefined) entry.timeout = hook.timeout;
    const group: HookGroup = { hooks: [entry] };
    if (hook.matcher !== undefined) group.matcher = hook.matcher;
    hooks[hook.event] = [group];
  }
  return {
    permissions: { deny: [...REQUIRED_DENY_RULES, "Bash(rm -rf /*)"] },
    hooks,
  };
}

let dir: string;

beforeAll(() => {
  // WHY 一時ディレクトリ: リポジトリの中に置くと、テストが途中で落ちたときに作業ツリーに残る。
  dir = mkdtempSync(join(tmpdir(), "settings-test-"));
  mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "scripts", "ok.sh"), "#!/bin/bash\necho ok\n");
  writeFileSync(join(dir, "scripts", "broken.sh"), "#!/bin/bash\nif then\n");
  chmodSync(join(dir, "scripts", "ok.sh"), 0o755);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const feature = await loadFeature("./settings.feature");

describeFeature(feature, ({ Scenario }) => {
  Scenario("matcher の判定（公式 hooks の Matcher patterns）", ({ And }) => {
    And(
      "matcher がツール名に当たるかを公式の書き方どおりに判定する（無し・空・星印・名前・| と , の並び・前方一致の境界・正規表現・アンカー・部分一致）",
      () => {
        // given: [matcher, ツール名, 当たるか]
        const cases: [string | undefined, string, boolean][] = [
          [undefined, "Bash", true],
          ["", "Bash", true],
          ["*", "mcp__github__push_files", true],
          ["Bash", "Bash", true],
          ["Bash|Edit", "Edit", true],
          ["Bash, Edit", "Edit", true],
          ["Bash", "BashOutput", false],
          ["Bashx|Edit", "Bash", false],
          ["Bash|mcp__github__push_files", "mcp__github__push_files", true],
          ["Bash|mcp__github__push_files", "mcp__github__delete_file", false],
          ["mcp__github__.*", "mcp__github__delete_file", true],
          ["mcp__github__.*", "Bash", false],
          ["^Bash$", "Bash", true],
          ["^Bash$", "BashOutput", false],
          // 正規表現はアンカーなしなので、部分一致でも当たる（公式: RegExp.prototype.test）。
          ["Bas.", "Bash", true],
        ];

        // when
        // WHY 表のまま比べる: matcher は undefined や重なる値があり、casesByName のケース名にできない。
        const result = cases.map(([matcher, tool]) => [
          matcher,
          tool,
          matcherMatches(matcher, tool),
        ]);

        // then
        expect(result).toEqual(cases);
      },
    );

    And(
      "Bash と MCP の書き込みツールをすべて並べた matcher は漏れがない（must pass）",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const uncoveredTools = findUncoveredTools(
          PRE_TOOL_USE_MATCHER,
          GUARDED_TOOLS,
        );

        // then
        expect(uncoveredTools).toEqual([]);
      },
    );

    And(
      "Bash だけの matcher では MCP の書き込みツールが漏れる（must reject）",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const uncoveredTools = findUncoveredTools("Bash", GUARDED_TOOLS);

        // then
        expect(uncoveredTools).toEqual(GUARDED_TOOLS.slice(1));
      },
    );

    And(
      "MCP の正規表現だけの matcher では Bash が漏れる（must reject）",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const uncoveredTools = findUncoveredTools(
          "mcp__github__.*",
          GUARDED_TOOLS,
        );

        // then
        expect(uncoveredTools).toEqual(["Bash"]);
      },
    );
  });

  Scenario("permissions.deny の判定", ({ And }) => {
    And(
      "必須のルールがすべてあれば（ほかのルールがあっても）不足なし（must pass）",
      () => {
        // given: 前提なし（入力は when の呼び出しに直接書く）
        // when
        const missingDenyRules = findMissingDenyRules(
          validSettings(),
          REQUIRED_DENY_RULES,
        );

        // then
        expect(missingDenyRules).toEqual([]);
      },
    );

    And(
      "必須のルールのどれか 1 つが無ければ、そのルールを不足として返す（must reject）（必須のルールのそれぞれ）",
      () => {
        // given
        const cases: [string][] = REQUIRED_DENY_RULES.map((rule) => [rule]);

        // when
        const result = casesByName(cases, ([rule]) => {
          const settings = validSettings();
          settings.permissions.deny = settings.permissions.deny.filter(
            (r) => r !== rule,
          );
          return findMissingDenyRules(settings, REQUIRED_DENY_RULES);
        });

        // then
        expect(result).toEqual(casesByName(cases, ([rule]) => [rule]));
      },
    );

    And(
      "書式が違うルール（末尾の星印の前の空白の有無）は同じルールとみなさない（must reject）",
      () => {
        // given
        const settings = validSettings();
        settings.permissions.deny = settings.permissions.deny.map((r) =>
          r === "Bash(git push --force*)" ? "Bash(git push --force *)" : r,
        );

        // when
        const missingDenyRules = findMissingDenyRules(
          settings,
          REQUIRED_DENY_RULES,
        );

        // then
        expect(missingDenyRules).toEqual(["Bash(git push --force*)"]);
      },
    );

    And(
      "permissions が無い・deny が配列でない・settings が null ときは必須のルールをすべて不足として返す（must reject）",
      () => {
        // given
        const cases: [string, unknown][] = [
          ["permissions が無い", {}],
          [
            "deny が配列でない",
            { permissions: { deny: "Bash(git push --force*)" } },
          ],
          ["settings が null", null],
        ];

        // when
        const result = casesByName(cases, ([, settings]) =>
          findMissingDenyRules(settings, REQUIRED_DENY_RULES),
        );

        // then
        expect(result).toEqual(casesByName(cases, () => REQUIRED_DENY_RULES));
      },
    );
  });

  Scenario("hooks の登録の判定", ({ And }) => {
    And("期待する登録がすべてあれば問題なし（must pass）", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const hookProblems = findHookProblems(validSettings(), EXPECTED_HOOKS);

      // then
      expect(hookProblems).toEqual([]);
    });

    And(
      "同じイベントにほかのグループやフックが並んでいても問題なし（must pass）",
      () => {
        // given
        const settings = validSettings();
        settings.hooks.PreToolUse.unshift({
          matcher: "Edit",
          hooks: [{ type: "command", command: "echo other" }],
        });
        settings.hooks.PreToolUse[1].hooks = [
          { type: "command", command: "echo first" },
          ...groupEntries(settings.hooks.PreToolUse[1]),
        ];

        // when
        const hookProblems = findHookProblems(settings, EXPECTED_HOOKS);

        // then
        expect(hookProblems).toEqual([]);
      },
    );

    And(
      "期待するイベントのどれか 1 つの登録が無ければ、そのイベントの問題として返す（must reject）（期待するイベントのそれぞれ）",
      () => {
        // given
        const cases: [string][] = EXPECTED_HOOKS.map((hook) => [hook.event]);

        for (const [event] of cases) {
          const settings = validSettings();
          delete settings.hooks[event];

          // when
          const problems = findHookProblems(settings, EXPECTED_HOOKS);

          // then
          expect(problems, event).toHaveLength(1);
          expect(problems[0], event).toMatch(new RegExp(`^${event}: `));
        }
      },
    );

    And(
      "登録の形が違うときは問題として返す（must reject）（スクリプトのパス・matcher を取らないイベントの matcher・PreToolUse の matcher の漏れ・SessionStart の matcher が無い・type・timeout・別のイベント・相対パス）",
      () => {
        // given
        const cases: [string, (s: ReturnType<typeof validSettings>) => void][] =
          [
            [
              "スクリプトのパスが違う",
              (s) => {
                s.hooks.Stop[0].hooks = [
                  {
                    type: "command",
                    command: hookCommand("hooks/require-work-logs.sh"),
                    timeout: 60,
                  },
                ];
              },
            ],
            [
              "matcher を取らないイベント（Stop）に matcher を書いた",
              (s) => {
                s.hooks.Stop[0].matcher = "*";
              },
            ],
            [
              "PreToolUse の matcher から MCP のツールが抜けた",
              (s) => {
                s.hooks.PreToolUse[0].matcher = "Bash";
              },
            ],
            [
              "SessionStart の matcher が無い",
              (s) => {
                delete s.hooks.SessionStart[0].matcher;
              },
            ],
            [
              "type が command でない",
              (s) => {
                s.hooks.SubagentStop[0].hooks = [
                  {
                    type: "prompt",
                    command: hookCommand("hooks/subagent-stop.sh"),
                    timeout: 60,
                  },
                ];
              },
            ],
            [
              "timeout が違う（WorktreeCreate は pnpm install と migrate を含むので 300）",
              (s) => {
                s.hooks.WorktreeCreate[0].hooks = [
                  {
                    type: "command",
                    command: hookCommand("hooks/worktree-create.sh"),
                    timeout: 60,
                  },
                ];
              },
            ],
            [
              "別のイベントに登録した（SubagentStop のスクリプトを Stop に）",
              (s) => {
                s.hooks.Stop = s.hooks.SubagentStop;
              },
            ],
            [
              "$CLAUDE_PROJECT_DIR を使わない相対パス",
              (s) => {
                s.hooks.PreCompact[0].hooks = [
                  {
                    type: "command",
                    command: "bash scripts/hooks/pre-compact.sh",
                    timeout: 60,
                  },
                ];
              },
            ],
          ];

        // when
        const result = casesByName(cases, ([, breakIt]) => {
          const settings = validSettings();
          breakIt(settings);
          return findHookProblems(settings, EXPECTED_HOOKS).length;
        });

        // then
        expect(result).toEqual(casesByName(cases, () => 1));
      },
    );

    And(
      "フックのコマンドから $CLAUDE_PROJECT_DIR 配下のスクリプトを重複なく取り出す",
      () => {
        // given
        const settings = validSettings();
        settings.hooks.Extra = [
          {
            hooks: [
              { type: "command", command: hookCommand("hooks/guard-git.sh") },
              { type: "command", command: "echo no-script" },
            ],
          },
        ];

        // when
        const hookScripts = listHookScripts(settings);

        // then
        expect(hookScripts).toEqual(
          EXPECTED_HOOKS.map((hook) => hook.command.split('"/')[1]),
        );
      },
    );
  });

  Scenario("権限・フックを黙って効かなくする設定の判定", ({ And }) => {
    And(
      "期待どおりの settings（ほかの allow があっても）は問題なし（must pass）",
      () => {
        // given
        const settings = {
          ...validSettings(),
          disableAllHooks: false,
          permissions: {
            ...validSettings().permissions,
            defaultMode: "default",
            allow: ["Bash(pnpm test *)", "Bash(git status)", "Read"],
          },
        };

        // when
        const unsafeSettings = findUnsafeSettings(settings);
        const unexpectedHooks = findUnexpectedHooks(settings, EXPECTED_HOOKS);

        // then
        expect(unsafeSettings).toEqual([]);
        expect(unexpectedHooks).toEqual([]);
      },
    );

    And(
      "フックや権限を黙って効かなくする設定は問題として返す（must reject）（disableAllHooks: true・defaultMode: bypassPermissions・allow に Bash の全許可・allow に Bash）",
      () => {
        // given
        const cases: [string, Record<string, unknown>, string[]][] = [
          [
            "disableAllHooks: true",
            { disableAllHooks: true },
            ["disableAllHooks: true"],
          ],
          [
            "defaultMode: bypassPermissions",
            { permissions: { defaultMode: "bypassPermissions" } },
            ["permissions.defaultMode: bypassPermissions"],
          ],
          [
            "allow に Bash(*)",
            { permissions: { allow: ["Read", "Bash(*)"] } },
            ["permissions.allow: Bash(*)"],
          ],
          [
            "allow に Bash",
            { permissions: { allow: ["Bash"] } },
            ["permissions.allow: Bash"],
          ],
        ];

        // when
        const result = casesByName(cases, ([, extra]) =>
          findUnsafeSettings({ ...validSettings(), ...extra }),
        );

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => expected),
        );
      },
    );

    And(
      "想定外のフックの登録は想定外として返す（must reject）（PreToolUse の想定外のグループ・同じグループの想定外のコマンド・想定外のイベント・フックが空のグループ）",
      () => {
        // given
        const cases: [
          string,
          (s: ReturnType<typeof validSettings>) => void,
          string,
        ][] = [
          [
            "PreToolUse に想定外のグループ（常に allow を返すフックなど）",
            (s) => {
              s.hooks.PreToolUse.push({
                matcher: "Bash",
                hooks: [{ type: "command", command: "echo allow" }],
              });
            },
            "PreToolUse: matcher=Bash command=echo allow は想定外",
          ],
          [
            "Stop の同じグループに想定外のコマンド",
            (s) => {
              s.hooks.Stop[0].hooks = [
                ...groupEntries(s.hooks.Stop[0]),
                { type: "command", command: "true" },
              ];
            },
            "Stop: matcher=undefined command=true は想定外",
          ],
          [
            "想定外のイベント",
            (s) => {
              s.hooks.PostToolUse = [
                { hooks: [{ type: "command", command: "echo post" }] },
              ];
            },
            "PostToolUse: matcher=undefined command=echo post は想定外",
          ],
          [
            "フックが空のグループ",
            (s) => {
              s.hooks.Stop.push({ hooks: [] });
            },
            "Stop: matcher=undefined command=undefined は想定外",
          ],
        ];

        // when
        const result = casesByName(cases, ([, breakIt]) => {
          const settings = validSettings();
          breakIt(settings);
          return findUnexpectedHooks(settings, EXPECTED_HOOKS);
        });

        // then
        expect(result).toEqual(
          casesByName(cases, ([, , expected]) => [expected]),
        );
      },
    );
  });

  Scenario("スクリプトの存在と構文の判定（fixture）", ({ And }) => {
    And("あって構文の正しいスクリプトは問題なし（must pass）", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const brokenScripts = findBrokenScripts(dir, ["scripts/ok.sh"]);

      // then
      expect(brokenScripts).toEqual([]);
    });

    And("無いスクリプトと構文エラーのスクリプトを返す（must reject）", () => {
      // given
      const problems = findBrokenScripts(dir, [
        "scripts/ok.sh",
        "scripts/missing.sh",
        "scripts/broken.sh",
      ]);

      // when
      const result = problems.map((p) => p.split(":")[0]);

      // then
      expect(result).toEqual(["scripts/missing.sh", "scripts/broken.sh"]);
    });
  });

  Scenario(".claude/settings.json（実ファイル）", ({ And }) => {
    const settings: unknown = JSON.parse(
      readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"),
    );

    And("permissions.deny に必須のルールがすべてある", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const missingDenyRules = findMissingDenyRules(
        settings,
        REQUIRED_DENY_RULES,
      );

      // then
      expect(missingDenyRules).toEqual([]);
    });

    And("各イベントに指定のスクリプトが登録されている", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const hookProblems = findHookProblems(settings, EXPECTED_HOOKS);

      // then
      expect(hookProblems).toEqual([]);
    });

    And("想定外のフックの登録が無い", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const unexpectedHooks = findUnexpectedHooks(settings, EXPECTED_HOOKS);

      // then
      expect(unexpectedHooks).toEqual([]);
    });

    And("フックや権限を黙って効かなくする設定が無い", () => {
      // given: 前提なし（入力は when の呼び出しに直接書く）
      // when
      const unsafeSettings = findUnsafeSettings(settings);

      // then
      expect(unsafeSettings).toEqual([]);
    });

    And(
      "guard-git.sh を登録した PreToolUse の matcher が Bash と MCP の書き込みツールをすべて含む",
      () => {
        // given
        const groups = hookGroups(settings, "PreToolUse").filter((group) =>
          groupEntries(group).some(
            (entry) => entry.command === hookCommand("hooks/guard-git.sh"),
          ),
        );
        const matcher = groups[0].matcher;

        // when
        const uncoveredTools = findUncoveredTools(
          matcher as string,
          GUARDED_TOOLS,
        );

        // then
        expect(groups).toHaveLength(1);
        expect(typeof matcher).toBe("string");
        expect(uncoveredTools).toEqual([]);
      },
    );

    And("フックが参照するスクリプトがすべてあり、bash -n が通る", () => {
      // given
      const scripts = listHookScripts(settings);

      // when
      const brokenScripts = findBrokenScripts(repoRoot, scripts);

      // then
      // WHY 件数も見る: 取り出しが壊れて 0 件になると、存在の検査が常に通ってしまうため。
      expect(scripts).toHaveLength(EXPECTED_HOOKS.length);
      expect(brokenScripts).toEqual([]);
    });
  });
});

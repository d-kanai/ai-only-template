#!/bin/bash
# PreToolUse フック（.claude/settings.json の hooks.PreToolUse。matcher は Bash と GitHub MCP の書き込みツール）。
# 文章で禁止していた git 操作（サブエージェントの commit / push / PR 作成・マージ、main への直接 commit / push、
# force push、フックの飛ばし、squash / rebase マージ）を、Claude Code がツールを実行する前に拒否する。
# WHAT / WHY と誤検知の扱いは .claude/rules/git-guard.md、決定は ADR docs/adr/workflow/20260928-git-operations-enforced-by-hooks.md。
#
# 入力: stdin の JSON（公式 hooks の「PreToolUse input」。tool_name・tool_input・cwd、サブエージェントの中では agent_id・agent_type）。
# 出力: 拒否するときだけ stdout に
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}
#   を出して exit 0。許可するときは何も出さずに exit 0（通常の権限の判定に任せる）。
# WHY exit 2 ではなく JSON で拒否する: exit 2 は stderr が理由になり、フックの失敗（node が無いなど）と区別しにくい。
#   JSON の deny なら、拒否は「意図した判定」のときだけになる。
# WHY 読めないときは拒否しない（fail open）: 判定できない入力で全コマンドを止めると作業が止まり、フックを外したくなる。
#   permissions.deny（settings.json）が同じ主な操作を二重に止めている。理由は stderr に出す。
set -u

if ! command -v node >/dev/null 2>&1; then
  echo "guard-git: node が見つからないため、git 操作の検査をしませんでした" >&2
  exit 0
fi

# WHY 判定を node で書く: JSON の読み取りと正規表現の判定を 1 つの処理で行うため（jq はクラウド VM にあるか未確認で、
#   依存を足さない）。node は Claude Code 自身の実行に使われているので、フックの環境にもある前提。
# shellcheck disable=SC2016 # JS のテンプレートリテラルの ${} を bash に展開させないため、シングルクォートで囲む。
GUARD_JS='
const { execFileSync } = require("node:child_process");
const path = require("node:path");

// サブエージェントには許さない MCP の書き込みツール（PR 作成・マージ・ブランチへの直接の書き込み）。
const SUBAGENT_DENIED_MCP = new Set([
  "mcp__github__create_pull_request",
  "mcp__github__merge_pull_request",
  "mcp__github__push_files",
  "mcp__github__create_or_update_file",
  "mcp__github__delete_file",
  "mcp__github__update_pull_request_branch",
]);
// branch を引数に取り、そのブランチに直接コミットを作る MCP のツール。main 宛てはメインでも拒否する。
const BRANCH_WRITING_MCP = new Set([
  "mcp__github__push_files",
  "mcp__github__create_or_update_file",
  "mcp__github__delete_file",
]);

// サブエージェントに許さない git のサブコマンド（コミットや履歴を作る・変える操作。オーケストレータだけが行う。
// .claude/general/orchestration.md）。pull はマージコミットを作りうるので含める。
const SUBAGENT_DENIED_GIT = new Set([
  "commit", "push", "merge", "rebase", "tag", "cherry-pick", "revert", "am", "pull",
  // 低レベルのコマンドでコミットを作る・ブランチを動かす書き方（commit-tree + update-ref）。
  "commit-tree", "update-ref",
]);

// 危険な長いオプションと、git が一意な接頭辞として受け付ける最短の書き方（git は長いオプションの省略形を受け付ける）。
// 最短の接頭辞の根拠は git 2.43.0 の builtin/commit.c・push.c・merge.c のオプション定義（.claude/rules/git-guard.md）:
// - --no-v: --no-verify（commit / push / merge）。--no-v〜--no-ver は --no-verbose とも一致して git では曖昧（エラー）だが、
//   止めても害はないので止める側に倒す。
// - --for: push の --force 系（--fo は --follow-tags と曖昧）。--m: push の --mirror（m で始まるのはこれだけ）。
// - --sq: merge の --squash（--s は --stat / --summary / --strategy / --signoff と曖昧）。
const NO_VERIFY = [["--no-verify", "--no-v"]];
const FORCE_PUSH = [
  ["--force", "--for"],
  ["--force-with-lease", "--for"],
  ["--force-if-includes", "--for"],
  ["--mirror", "--m"],
];
const SQUASH = [["--squash", "--sq"]];
// push の --all / --branches はローカルのすべてのブランチ（main を含む）を送る（--a は --atomic と曖昧、--b は branches だけ）。
const ALL_BRANCHES = [
  ["--all", "--al"],
  ["--branches", "--b"],
];

// コマンドの区切り（捕獲して、サブシェルの ( ) で cd の効く範囲を戻すのに使う）。シェルの構文解析はせず、文字列をこれで切る
// （`&&` / `;` / `|` / 改行 / サブシェルの後ろにあるものも拾う）。
const SEPARATOR = /(&&|\|\||[;|&\n`()])/;
const PLACEHOLDER = "__SUBST__";
// git の呼び出し。git の前は行頭・空白・/（/usr/bin/git）・=（x=git）。1 つ目の捕獲はサブコマンドの前のグローバルオプション
// （引数を取る -C <dir> / -c <key=value> / --git-dir <dir> / --work-tree <dir> / --namespace <ns> / --config-env <k=v> と、
// それ以外の -x / --xxx[=v]）、2 つ目はサブコマンド。
const GIT_CALL =
  /(?:^|[\s\/=])git((?:\s+(?:-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|config-env)\s+\S+|-\S+))*)\s+([A-Za-z][\w-]*)(?=\s|$)/g;
const GH_PR = /(?:^|[\s\/=])gh\s+pr\s+(create|merge)(?=\s|$)(.*)$/;
// Lefthook のフックを飛ばす・差し替える環境変数（lefthook 2.1.12 のバイナリに含まれる名前と、.git/hooks/pre-commit の
// LEFTHOOK / LEFTHOOK_BIN の扱い）。LEFTHOOK_VERBOSE / LEFTHOOK_OUTPUT は表示だけなので許す。
const LEFTHOOK_BYPASS =
  /(?:^|[\s;&|(])(?:export\s+)?(?:LEFTHOOK=(?:0|false)(?=\s|$|;)|LEFTHOOK_(?:EXCLUDE|BIN|CONFIG)=)/;
// pflag（gh）の bool の値で false になるもの（Go の strconv.ParseBool）。
const GH_FALSE = new Set(["false", "0", "f", "F", "FALSE", "False"]);

// WHY クォートとバックスラッシュを消す: `bash -c "git push"` や `git "push"`、`git \<改行> commit` のように、
//   クォートやエスケープで区切りを変えた書き方も同じ文字列として見るため。文字列の中の git も拾う（誤検知は受け入れる。
//   .claude/rules/git-guard.md の「誤検知」）。
function normalize(command) {
  return command.replace(/\\\n/g, " ").replace(/[\\"\x27]/g, "");
}

// コマンド置換（$(...) と `...`）の中身を取り出し、外側では 1 語の PLACEHOLDER に置き換える（内側から順に）。
// WHY: `git -C "$(pwd)" commit` の ( ) を区切りとして扱うと、git と commit が別の区切りに分かれて見逃す。
//   中身も別のコマンドとして検査する（`echo $(git commit)` を拾うため）。
function splitSubstitutions(text) {
  const inner = [];
  let outer = text;
  let previous;
  do {
    previous = outer;
    outer = outer.replace(/\$\(([^()]*)\)|`([^`]*)`/g, (_match, paren, tick) => {
      inner.push(paren ?? tick);
      return ` ${PLACEHOLDER} `;
    });
  } while (outer !== previous);
  return { outer, inner };
}

// cd / pushd / git -C / --git-dir の行き先。分からないとき（変数・コマンド置換・cd -、相対パスで元の場所が分からない）は null。
function resolveDir(base, target) {
  if (target === undefined) return process.env.HOME || null;
  if (target === "-" || target.includes("$") || target.includes(PLACEHOLDER)) return null;
  const expanded = target.replace(/^~(?=\/|$)/, process.env.HOME || "~");
  if (path.isAbsolute(expanded)) return expanded;
  return base ? path.resolve(base, expanded) : null;
}

// 区切りで切ったコマンドを順に返し、それぞれが実行される場所（cd / pushd を追う）を付ける。
// サブシェルの ( ) では、閉じたときに cd の前の場所に戻す。
function* walk(text, cwd) {
  let current = cwd;
  const stack = [];
  for (const part of text.split(SEPARATOR)) {
    if (part === "(") {
      stack.push(current);
    } else if (part === ")") {
      if (stack.length > 0) current = stack.pop();
    } else if (!SEPARATOR.test(part)) {
      const cd = /^\s*(?:cd|pushd)(?:\s+(\S+))?\s*$/.exec(part);
      if (cd) current = resolveDir(current, cd[1]);
      else yield { text: part, cwd: current };
    }
  }
}

function* commandSegments(command, cwd) {
  const { outer, inner } = splitSubstitutions(normalize(command));
  for (const text of inner) yield* walk(text, cwd);
  yield* walk(outer, cwd);
}

function parseGlobalOptions(text, cwd) {
  const tokens = text.split(/\s+/).filter(Boolean);
  let dir = cwd;
  let gitDir = null;
  const configs = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const valueOf = (name) => (token === name ? tokens[++i] ?? "" : token.slice(name.length + 1));
    if (token === "-C") dir = resolveDir(dir, tokens[++i] ?? "");
    else if (token === "-c") configs.push(tokens[++i] ?? "");
    else if (token === "--config-env" || token.startsWith("--config-env=")) configs.push(valueOf("--config-env"));
    else if (token === "--git-dir" || token.startsWith("--git-dir=")) gitDir = valueOf("--git-dir");
    else if (token === "--work-tree" || token === "--namespace") i += 1;
  }
  return { dir, gitDir: gitDir === null ? null : resolveDir(dir, gitDir) ?? "", configs };
}

function* gitCalls(command, cwd) {
  for (const segment of commandSegments(command, cwd)) {
    for (const match of segment.text.matchAll(GIT_CALL)) {
      const rest = segment.text.slice(match.index + match[0].length);
      yield {
        ...parseGlobalOptions(match[1], segment.cwd),
        sub: match[2],
        args: rest.split(/\s+/).filter(Boolean),
      };
    }
  }
}

function* ghPrCalls(command, cwd) {
  for (const segment of commandSegments(command, cwd)) {
    const match = GH_PR.exec(segment.text);
    if (match) yield { sub: match[1], args: match[2].split(/\s+/).filter(Boolean) };
  }
}

// gitDir: --git-dir の行き先（無ければ null、分からなければ ""）。dir: -C / cd を反映した場所（分からなければ null）。
function currentBranch(dir, gitDir) {
  if (gitDir === "" || (gitDir === null && !dir)) return null;
  try {
    // WHY symbolic-ref: rev-parse --abbrev-ref HEAD は、コミットの無いブランチ（git init 直後）で失敗する。
    //   detached HEAD では失敗し、判定しない（ブランチに commit しないため）。
    const location = gitDir ? [`--git-dir=${gitDir}`] : ["-C", dir];
    return execFileSync("git", [...location, "symbolic-ref", "--short", "-q", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

// 短いオプションの束（-fu など）に letter があるか。argLetters の文字の後ろはその引数なので見ない（-mnew は -m "new"）。
function shortFlagHas(arg, letter, argLetters) {
  if (!/^-[A-Za-z]+$/.test(arg)) return false;
  for (const ch of arg.slice(1)) {
    if (ch === letter) return true;
    if (argLetters.includes(ch)) return false;
  }
  return false;
}

// 引数に、危険な長いオプション（またはその省略形）があるか。= の後ろの値は見ない。
function hasLongOption(args, options) {
  return args.some((arg) => {
    const flag = arg.split("=")[0];
    return options.some(([name, shortest]) => flag.startsWith(shortest) && name.startsWith(flag));
  });
}

// gh pr merge の引数に squash / rebase の指定があるか（--squash、--squash=true、-s、-sd のような束）。
// 束は引数を取る短いオプション（-b / -t / -F / -A / -R）の後ろを見ない（-tsubject の s は件名）。
function ghMergeRewritesHistory(args) {
  return args.some((arg) => {
    const long = /^--(?:squash|rebase)(?:=(.*))?$/.exec(arg);
    if (long) return long[1] === undefined || !GH_FALSE.has(long[1]);
    return shortFlagHas(arg, "s", "btFAR") || shortFlagHas(arg, "r", "btFAR");
  });
}

// git push の引数から、プッシュ先のブランチ名を並べる（リモート名を除く）。
// 引数なし・リモートだけのときは、カレントブランチへの push とみなす（push.default の simple / current）。
// 値を取るオプション（-o / --push-option など）の値は、ブランチ名として数えない。
function pushTargets(args, branchOf) {
  const positionals = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-o" || arg === "--push-option" || arg === "--repo" || arg === "--receive-pack" || arg === "--exec") {
      i += 1;
    } else if (!arg.startsWith("-")) {
      positionals.push(arg);
    }
  }
  const refspecs = positionals.slice(1);
  if (refspecs.length === 0) return [branchOf()];
  return refspecs.map((refspec) => {
    const dest = refspec.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, "");
    // ワイルドカード（refs/heads/*:refs/heads/*）は main を含みうるので main とみなす。
    if (dest.includes("*")) return "main";
    return dest === "HEAD" || dest === "@" ? branchOf() : dest;
  });
}

function denyForSubagent(command, cwd) {
  for (const call of gitCalls(command, cwd)) {
    // WHY alias を止める: 別名（git ci など）はサブコマンドの名前から判定できない。この場で作る別名（-c alias.* と
    //   git config alias.*）だけは止められる。既に設定にある別名は見逃す（限界。.claude/rules/git-guard.md）。
    if (call.configs.some((c) => /^alias\./i.test(c))) return "git -c alias.*（別名）";
    if (call.sub === "config" && call.args.some((a) => /^alias\./i.test(a))) return "git config alias.*（別名の定義）";
    if (SUBAGENT_DENIED_GIT.has(call.sub)) return `git ${call.sub}`;
    if (call.sub === "reset" && call.args.includes("--hard")) return "git reset --hard";
    if (call.sub === "checkout" && call.args.filter((a) => !a.startsWith("-"))[0] === "main") {
      return "git checkout main";
    }
  }
  for (const call of ghPrCalls(command, cwd)) return `gh pr ${call.sub}`;
  return null;
}

function denyForEveryone(command, cwd) {
  const normalized = normalize(command);
  if (LEFTHOOK_BYPASS.test(normalized)) {
    return "LEFTHOOK=0 / LEFTHOOK_EXCLUDE / LEFTHOOK_BIN / LEFTHOOK_CONFIG でフックを飛ばす・差し替えることはできません（緊急時の扱いは .claude/rules/git-guard.md）";
  }
  // WHY 文字列のどこにあっても止める: -c core.hooksPath=、--config-env、git config core.hooksPath、GIT_CONFIG_PARAMETERS /
  //   GIT_CONFIG_KEY_<n> など、フックの場所を変える書き方が多いため。読むだけ（git config --get）も止まる（誤検知として受け入れる）。
  if (/core\.hookspath/i.test(normalized)) {
    return "core.hooksPath でフックの場所を変えることはできません";
  }
  // 同じコマンドの中の checkout / switch で切り替えた先のブランチ（フックはコマンドを実行する前に動くので、
  // git checkout main && git commit の commit は、今のブランチではなく切り替えた先で判定する）。undefined なら今のブランチ。
  let switchedTo;
  for (const call of gitCalls(command, cwd)) {
    const branchOf = () => switchedTo ?? currentBranch(call.dir, call.gitDir);
    if (call.sub === "checkout" || call.sub === "switch") {
      const target = call.args.find((a) => !a.startsWith("-"));
      const creates = call.args.some((a) => /^-[bBcC]$/.test(a) || a.startsWith("--orphan"));
      // 新しいブランチを作るならその名前、main に切り替えるなら main、それ以外（ファイルの checkout など）は今のブランチ。
      switchedTo = creates ? target : target === "main" && !call.args.includes("--") ? "main" : undefined;
    }
    if (hasLongOption(call.args, NO_VERIFY)) {
      return `git ${call.sub} --no-verify（省略形を含む）でフックを飛ばすことはできません`;
    }
    if (call.sub === "commit" && call.args.some((a) => shortFlagHas(a, "n", "mFCctSu"))) {
      return "git commit -n（--no-verify）でフックを飛ばすことはできません";
    }
    if (call.sub === "merge" && hasLongOption(call.args, SQUASH)) {
      return "git merge --squash は使いません（マージは merge commit だけ。.claude/general/workflow.md）";
    }
    if ((call.sub === "commit" || call.sub === "merge") && branchOf() === "main") {
      return `main ブランチでの git ${call.sub} はできません。<type>/<Issue番号>-<内容> のブランチを切って作業してください`;
    }
    if (call.sub === "push") {
      if (hasLongOption(call.args, FORCE_PUSH) || call.args.some((a) => shortFlagHas(a, "f", "o") || /^\+/.test(a))) {
        return "force push（--mirror を含む）はできません";
      }
      if (hasLongOption(call.args, ALL_BRANCHES) || pushTargets(call.args, branchOf).includes("main")) {
        return "main への直接の push（削除を含む）はできません。PR を作ってマージしてください";
      }
    }
  }
  for (const call of ghPrCalls(command, cwd)) {
    if (call.sub === "merge" && ghMergeRewritesHistory(call.args)) {
      return "gh pr merge の squash / rebase は使いません（--merge を使う。.claude/general/workflow.md）";
    }
  }
  return null;
}

function decide(input) {
  const tool = input.tool_name;
  const toolInput = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  // WHY agent_id と agent_type のどちらかがあればサブエージェントとみなす: 公式では agent_id はサブエージェントの中だけ、
  //   agent_type は --agent で起動したメインにも付く。Issue #64 の実測ではサブエージェントで agent_type に型名が入った。
  //   片方しか来なくても止める側に倒す（--agent でメインを起動すると、メインもサブエージェント扱いになる。このリポジトリでは使わない）。
  const isSubagent = Boolean(input.agent_id) || Boolean(input.agent_type);

  if (tool === "Bash") {
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (isSubagent) {
      const hit = denyForSubagent(command, cwd);
      if (hit) {
        return `サブエージェントは ${hit} を実行できません（commit / push / PR 作成・マージはオーケストレータが行う）`;
      }
    }
    return denyForEveryone(command, cwd);
  }

  if (tool.startsWith("mcp__github__")) {
    if (isSubagent && SUBAGENT_DENIED_MCP.has(tool)) {
      return `サブエージェントは ${tool} を使えません（PR 作成・マージ・ブランチへの書き込みはオーケストレータが行う）`;
    }
    if (tool === "mcp__github__merge_pull_request" && ["squash", "rebase"].includes(toolInput.merge_method)) {
      return `merge_method: ${toolInput.merge_method} は使いません（merge commit だけ。.claude/general/workflow.md）`;
    }
    if (BRANCH_WRITING_MCP.has(tool) && toolInput.branch === "main") {
      return `${tool} で main に直接書き込むことはできません`;
    }
  }
  return null;
}

let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch (error) {
    process.stderr.write(`guard-git: 入力の JSON を読めないため、検査をしませんでした: ${error.message}\n`);
    return;
  }
  const reason = decide(input || {});
  if (reason) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `guard-git: ${reason}`,
      },
    }));
  }
});
'

if ! node -e "$GUARD_JS"; then
  echo "guard-git: 検査の途中で失敗したため、検査をしませんでした" >&2
fi
exit 0

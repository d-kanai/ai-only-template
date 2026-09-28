#!/bin/bash
# PreToolUse フック（.claude/settings.json の hooks.PreToolUse。matcher は Bash と GitHub MCP の書き込みツール）。
# 文章で禁止していた git 操作（サブエージェントの commit / push / PR 作成・マージ、main への直接 commit / push、
# force push、フックの飛ばし、squash / rebase マージ）を、Claude Code がツールを実行する前に拒否する。
# WHAT / WHY と誤検知の扱いは .claude/rules/git-guard.md、実測は docs/git-guard.md。
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

// サブエージェントに許さない git のサブコマンド（オーケストレータだけが行う。.claude/general/orchestration.md）。
const SUBAGENT_DENIED_GIT = new Set(["commit", "push", "merge", "rebase", "tag"]);

// コマンドの区切り。シェルの構文解析はせず、文字列をこれで切ってそれぞれを見る
// （`&&` / `;` / `|` / 改行 / サブシェル / コマンド置換の後ろにあるものも拾う）。
const SEPARATOR = /&&|\|\||[;|&\n`()]/;
// git の呼び出し。git の前は行頭・空白・/（/usr/bin/git）・=（x=git）。サブコマンドの前のグローバルオプションは、
// 引数を取る -C <dir> / -c <key=value> / --git-dir <dir> などと、それ以外の -x / --xxx[=v] を読み飛ばす。
const GIT_CALL =
  /(?:^|[\s\/=])git(?:\s+(?:-C\s+(\S+)|-c\s+\S+|--(?:git-dir|work-tree|namespace|exec-path)\s+\S+|-\S+))*\s+([A-Za-z][\w-]*)(?=\s|$)/g;
const GH_PR = /(?:^|[\s\/=])gh\s+pr\s+(create|merge)(?=\s|$)/;

// WHY クォートとバックスラッシュを消す: `bash -c "git push"` や `git "push"`、`git \<改行> commit` のように、
//   クォートやエスケープで区切りを変えた書き方も同じ文字列として見るため。文字列の中の git も拾う（誤検知は受け入れる。
//   .claude/rules/git-guard.md の「誤検知」）。
function normalize(command) {
  return command.replace(/\\\n/g, " ").replace(/[\\"\x27]/g, "");
}

function* gitCalls(command) {
  for (const segment of normalize(command).split(SEPARATOR)) {
    for (const match of segment.matchAll(GIT_CALL)) {
      const rest = segment.slice(match.index + match[0].length);
      yield {
        dir: match[1],
        sub: match[2],
        args: rest.split(/\s+/).filter(Boolean),
        segment,
      };
    }
  }
}

function currentBranch(dir) {
  try {
    // WHY symbolic-ref: rev-parse --abbrev-ref HEAD は、コミットの無いブランチ（git init 直後）で失敗する。
    //   detached HEAD では失敗し、判定しない（ブランチに commit しないため）。
    return execFileSync("git", ["-C", dir, "symbolic-ref", "--short", "-q", "HEAD"], {
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

// git push の引数から、プッシュ先のブランチ名を並べる（リモート名を除く）。
// 引数なし・リモートだけのときは、カレントブランチへの push とみなす（push.default の simple / current）。
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
    return dest === "HEAD" || dest === "@" ? branchOf() : dest;
  });
}

function denyForSubagent(command) {
  for (const call of gitCalls(command)) {
    if (SUBAGENT_DENIED_GIT.has(call.sub)) return `git ${call.sub}`;
    if (call.sub === "reset" && call.args.includes("--hard")) return "git reset --hard";
    if (call.sub === "checkout" && call.args.filter((a) => !a.startsWith("-"))[0] === "main") {
      return "git checkout main";
    }
  }
  const gh = GH_PR.exec(normalize(command));
  if (gh) return `gh pr ${gh[1]}`;
  return null;
}

function denyForEveryone(command, cwd) {
  if (/(?:^|[\s;&|(])(?:export\s+)?LEFTHOOK=(?:0|false)(?=\s|$|;)/.test(normalize(command))) {
    return "LEFTHOOK=0 でフックを飛ばすことはできません（緊急時の扱いは .claude/rules/git-guard.md）";
  }
  for (const call of gitCalls(command)) {
    const dir = call.dir ? path.resolve(cwd, call.dir) : cwd;
    const branchOf = () => currentBranch(dir);
    if (call.args.includes("--no-verify")) {
      return `git ${call.sub} --no-verify でフックを飛ばすことはできません`;
    }
    if (call.sub === "commit" && call.args.some((a) => shortFlagHas(a, "n", "mFCct"))) {
      return "git commit -n（--no-verify）でフックを飛ばすことはできません";
    }
    if (call.sub === "merge" && call.args.includes("--squash")) {
      return "git merge --squash は使いません（マージは merge commit だけ。.claude/general/workflow.md）";
    }
    if ((call.sub === "commit" || call.sub === "merge") && branchOf() === "main") {
      return `main ブランチでの git ${call.sub} はできません。<type>/<Issue番号>-<内容> のブランチを切って作業してください`;
    }
    if (call.sub === "push") {
      if (call.args.some((a) => /^--force(?:-with-lease|-if-includes)?(?:=|$)/.test(a) || shortFlagHas(a, "f", "o") || /^\+/.test(a))) {
        return "force push はできません";
      }
      if (pushTargets(call.args, branchOf).includes("main")) {
        return "main への直接の push（削除を含む）はできません。PR を作ってマージしてください";
      }
    }
  }
  const merge = /(?:^|[\s\/=])gh\s+pr\s+merge\b(.*)$/m.exec(normalize(command));
  if (merge && /(?:^|\s)(?:--squash|--rebase|-s|-r)(?=\s|$)/.test(merge[1])) {
    return "gh pr merge の squash / rebase は使いません（--merge を使う。.claude/general/workflow.md）";
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
      const hit = denyForSubagent(command);
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

#!/usr/bin/env bash
# Claude Code の InstructionsLoaded フック（.claude/settings.json の hooks.InstructionsLoaded から呼ぶ）。Issue #64。
#
# WHAT: CLAUDE.md / .claude/rules/*.md などの指示ファイルが読み込まれるたびに、
#   <リポジトリ直下>/.claude/state/instructions-loaded.jsonl に 1 行の JSON を追記する。
#   {"ts": 実行時刻（ISO 8601 の UTC）, "file_path", "load_reason", "trigger_file_path", "memory_type"}（入力に無い項目は null）。
# WHY: 実際にどの指示ファイルが、いつ・何をきっかけに読まれたか（session_start / path_glob_match / nested_traversal /
#   include / compact）を後から確かめるため（Issue #64 の完了条件「読めているかを実証する」）。rules の paths の書き間違いで
#   ルールが黙って読まれない、を記録で見つけられるようにする。
# WHY .claude/state/: セッションごとの一時的な記録で、コミットしない（.gitignore 済み）。logs/ に書かない理由は
#   pre-compact.sh と同じ（Stop フックの判定が素通りになる）。
# 見方: .claude/rules/work-log.md。
#
# 入力（stdin の JSON。公式 https://code.claude.com/docs/en/hooks.md の InstructionsLoaded input）:
#   file_path, memory_type, load_reason, trigger_file_path（遅延読み込みのとき）, cwd。
# 出力: なし。終了コードは常に 0（このイベントは読み込みを止められない。公式: decision control なし）。
# 書く先: cwd の git リポジトリの直下。git リポジトリでなければ cwd。
set -u

input=$(cat)
cwd=$(
  printf '%s' "$input" | node -e '
    let raw = "";
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", () => {
      try {
        const hook = JSON.parse(raw);
        process.stdout.write(typeof hook.cwd === "string" && hook.cwd !== "" ? hook.cwd : process.cwd());
      } catch {
        console.error("instructions-loaded: 入力を読めない（stdin が JSON ではない）");
        process.exit(3);
      }
    });
  '
) || exit 0

root=$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null) || root=$cwd
state_dir="$root/.claude/state"
mkdir -p "$state_dir" || { echo "instructions-loaded: $state_dir を作れない" >&2; exit 0; }

# 1 行を 1 回の appendFileSync で書く（O_APPEND。複数のファイルがほぼ同時に読み込まれても行が混ざらないようにする）。
printf '%s' "$input" | OUT="$state_dir/instructions-loaded.jsonl" node -e '
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    const hook = JSON.parse(raw);
    const pick = (key) => (hook[key] === undefined ? null : hook[key]);
    const record = {
      ts: new Date().toISOString(),
      file_path: pick("file_path"),
      load_reason: pick("load_reason"),
      trigger_file_path: pick("trigger_file_path"),
      memory_type: pick("memory_type"),
    };
    require("node:fs").appendFileSync(process.env.OUT, `${JSON.stringify(record)}\n`);
  });
' || echo "instructions-loaded: $state_dir/instructions-loaded.jsonl に書けない" >&2
exit 0

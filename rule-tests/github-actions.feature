# GitHub Actions のワークフローの決まり（.claude/rules/tooling/github-actions.md）を検査するルール検査テストの仕様（Issue #351）。step の実装は対の github-actions.test.ts。
# 規則の WHY と限界は github-actions.test.ts の冒頭。
Feature: GitHub Actions のワークフロー
  Scenario: action の参照の判定（isPinnedUses）
    * 40 桁の commit SHA で固定した参照は許可する（owner/repo・サブディレクトリ・再利用ワークフロー・同じリポジトリの ./ ・digest で固定した docker://）
    * commit SHA で固定していない参照は拒否する（メジャーのタグ・完全なタグ・ブランチ・短い SHA・41 桁・大文字・16 進でない文字・式・@ の無い参照・空文字・タグの docker://・digest の無い docker://・owner が .. の参照）
  Scenario: action の参照の抽出（readUses）
    * steps と job の uses を行の番号つきで取り出し、行末のコメントと引用符を外す
    * コメントアウトした uses の行と、uses を値に含むだけの行は取り出さない
  Scenario: job の timeout-minutes の判定（readJobs）
    * job の直下に正の整数の timeout-minutes がある job は違反なし
    * timeout-minutes の無い job・コメントアウトした timeout-minutes・step にだけある timeout-minutes・0 と式の値は、job の違反になる
    * jobs の外の同じ名前のキーは job として数えない
  Scenario: job の見出しの読み方（readJobs）
    * job と同じインデントの行は、引用符の名前・アンカー付き・フロー形式も job の見出しとして読み、中身の無いフロー形式は違反になる
  Scenario: ワークフローの実ファイル
    * 一時ディレクトリの .github/workflows の yml と yaml から、規則ごとの違反をすべて検出する
    * リポジトリの .github/workflows のワークフローを ci・deploy・mutation を含めて列挙し、uses と job を 1 件以上取り出せる
    * リポジトリのワークフローの uses はすべて commit SHA で固定し、すべての job に timeout-minutes がある
  Scenario: 依存の脆弱性の検査（auditsDependencies。Issue #112）
    * ci.yml の ci job が pnpm audit --audit-level high を、PR と main への push の両方で失敗で止まる形で実行するワークフローは許可する
    * pnpm audit が無い・しきい値が high でない・失敗を打ち消す・if で飛ばす・continue-on-error で無視するワークフローは拒否する
  Scenario: コードの静的解析（scansWithCodeQL。Issue #112）
    * CodeQL の init と analyze を使い、javascript-typescript と actions を解析し、PR と main への push で動くワークフローは許可する
    * init か analyze が無い・解析する言語が足りない・PR か push で動かないワークフローは拒否する
  Scenario: リポジトリのセキュリティスキャン（Issue #112）
    * リポジトリの ci.yml は pnpm audit を、codeql.yml は CodeQL を、上の形で実行する

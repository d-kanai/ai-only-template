---
name: dependency-update
description: npm パッケージの追加・更新・移動と lockfile の作り直し、pnpm patch の作成・削除。package.json / pnpm-lock.yaml / pnpm-workspace.yaml / patches/ を変えるとき、版を決めるとき、ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION などで install が通らないときに使う。
---

# dependency-update（依存の追加・更新・パッチ）

方針（完全固定、`workspace:*` だけ例外、どのパッケージに置くか、現状の例外の版）は `.claude/rules/dependencies.md`。ここは手順。
Node / pnpm 本体の版（`.tool-versions`・`packageManager`）は `.claude/rules/env.md`。

## 1. 版を決める
1. 原則 **latest**。npm レジストリの dist-tags を 1 次情報にする: `curl -s https://registry.npmjs.org/<pkg> | jq -r '.["dist-tags"].latest'`
2. 公開日時を見る: `curl -s https://registry.npmjs.org/<pkg> | jq '.time'`。**公開から 5 日以上経った版のうち最新**を選ぶ。
   - WHY: `pnpm-workspace.yaml` の `minimumReleaseAge: 7200`（分 = 5 日）で、それより新しい版は推移的依存も含めて入らない（`pnpm-workspace.test.ts` が値を検査）。
   - 開発機の safe-chain は 14 日（`~/.aikido/config.json`）。pnpm 側を 14 日に揃えないのは、Next.js などへの追随が 2 週間遅れになるため（Issue #32 のユーザー判断）。
   - latest を入れられなかったときは、入れた版とその理由を PR に書く。
   - `packageManager`（pnpm 本体）の解決は対象外で、5 日未満の pnpm でも拒否されない（2026-09-28 実測。公式仕様は未確認）。pnpm の版は `.tool-versions` と `packageManager` で明示する。
3. 版は `x.y.z` の数字 3 つだけ。`^` `~` `>=` `*` `latest`・プレリリース（`-beta.1`）・ビルドメタ（`+build`）・`=1.2.3` / `v1.2.3` は使わない。
4. 例外（`.claude/rules/dependencies.md`）: React / React DOM は create-next-app の版、`@types/node` は `.tool-versions` の Node メジャーに合わせた最新。

## 2. 追加・更新する
1. 置き場所を決める: そのパッケージのコードが import するものはそのパッケージ（`next` / `react` は frontend、`drizzle-orm` / `pg` は backend）。ツールとテストだけが使うものはリポジトリ直下。
2. 版を明示して追加する（リポジトリ直下で実行）:
   ```sh
   pnpm --filter @repo/backend add <pkg>@<x.y.z>       # apps/backend の dependencies
   pnpm --filter @repo/frontend add -D <pkg>@<x.y.z>   # apps/frontend の devDependencies
   pnpm add -D <pkg>@<x.y.z>                           # リポジトリ直下（ツール）
   ```
   - `--filter` はパッケージ名（`@repo/backend` / `@repo/frontend`）で指定する。リポジトリ直下では `-w` なしの `pnpm add` でも直下の `package.json` に入った（pnpm 12.7.0、2026-09-28 実測）。
   - `savePrefix: ''` で完全固定で書かれるが、版は必ず明示する。WHY: `pnpm add <pkg>@2` のように範囲を渡すと範囲のまま書かれる。
   - workspace の中のパッケージへの依存は `"<name>": "workspace:*"` と書いて `pnpm install`。
3. 同じパッケージを複数の `package.json` に置くなら、すべて同じ版にする。
4. DB のパッケージを足したら `architecture.test.ts` の `PERSISTENCE_PACKAGES` にも足す（domain / application から使えないようにする）。
5. `pnpm test` で `package.test.ts`（完全固定・`workspace:*` だけ許す・同名は同じ版）と `pnpm-workspace.test.ts` が通ることを確かめ、`pnpm lint` / `pnpm typecheck` / `pnpm build` も通す。

## 3. 依存を別の package.json に移す
1. 版を変えずに `package.json` を書き換え、`pnpm install`（`--frozen-lockfile` なし）で lockfile を更新する。
2. lockfile の差分が `importers` だけで、`packages:` 以降（解決した版）が変わっていないことを更新前と比べる。
3. `CI=true pnpm install --frozen-lockfile` が通ることを確かめる。

## 4. lockfile を作り直す
lockfile にポリシー（5 日）を満たさないエントリがあると、`--frozen-lockfile` / `pnpm update` は `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`、`pnpm add <pkg>@<x.y.z>` / `pnpm update <pkg>` は `ERR_PNPM_NO_MATURE_MATCHING_VERSION` になり、部分的に直せない（pnpm 12.7.0 で確認）。
1. 直接依存の版を `package.json` で直す。
2. `pnpm clean --lockfile` → `pnpm install` で作り直す。
3. `pnpm install --frozen-lockfile` が通ることを確かめ、lockfile の差分に意図しない版の変化が無いかを見る。
- 拒否されたエントリを入れ替えるには、それを要求している親パッケージも条件を満たす版である必要がある。開発機では safe-chain が 14 日未満の親を隠して再解決できないことがある（Issue #32）。その場合はクラウドセッション（safe-chain なし）で再解決する。

## 5. pnpm patch（依存パッケージへのパッチ）
- 使ってよい条件（すべて）: 上流の不具合で設定や使い方では避けられない / 修正が数行で差分を読めば分かる / 上流の Issue・PR を確認してリンクを書く（無い・確認できないならその旨と理由）/ 当てる前に不具合を再現し、当てて直ることを実測する。
1. `pnpm patch <pkg>@<x.y.z> --edit-dir <作業用ディレクトリ>` で展開し、中身を編集する。
2. `pnpm patch-commit <作業用ディレクトリ>` で `patches/<pkg>@<版>.patch`（スコープの `/` は `__`）を作り、`patchedDependencies` と lockfile を更新する。
3. 何を・なぜ直したかを `pnpm-workspace.yaml` の `patchedDependencies` のコメントと、そのパッケージを使う設定ファイルのコメントに書く（パッチファイルにはコメントを書けない）。
4. `patches/`・`pnpm-workspace.yaml`・`pnpm-lock.yaml` を**同じコミット**に入れる。WHY: lockfile にパッチのハッシュが入るので、片方だけだと `--frozen-lockfile` が「"patchedDependencies" configuration doesn't match ...」で失敗する。
5. 確認: `CI=true pnpm install --frozen-lockfile` が通る / `node_modules/<pkg>/` の該当ファイルに変更が入っている（grep）/ 直したい挙動が直っている（最初の実測と同じ方法で）。
- 外す: 上流が直した版が出たら、その版に上げてパッチと `patchedDependencies` の行を消す。キーは版まで固定なので、版を上げるたびにパッチの要否を見直す。
- 現在のパッチ: `@stryker-mutator/vitest-runner@10.0.0`（Issue #52。`mutation-testing` スキル）。

## 注意
- `package.json` の依存の版を書き換えた後（戻した直後も）に `pnpm exec` を実行すると install が走り、lockfile と共有フック `.git/hooks/pre-commit` が書き換わる（LEARNINGS.md）。worktree では `CI=true` を付ける。
- 更新は Issue → PR で行う（`pr-flow`）。

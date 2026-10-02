---
name: infra-diagram
description: Terraform（infra/）からシステム構成・IAM・Cloud SQL の図を、GitHub Actions（.github/workflows/deploy.yml）からデプロイの流れの図を起こし、docs/diagrams/ の .mmd と .png を一括で最新にする。構成図を作る・見せる・更新するとき、infra/ や deploy.yml を変えたときに使う。
---

# infra-diagram（Terraform と GitHub Actions から構成図を作り直す）

図は `docs/diagrams/`。元が `<名前>.mmd`（Mermaid）、画像が `<名前>.png`、一覧と説明が `README.md`。
WHY Mermaid を AI が書く（自動生成ツールを使わない）: 2026-10-02 に試した結果、Inframap v0.8.1 は HCL の `ephemeral` ブロック（`sql.tf` の write-only パスワード）を読めずに失敗し、`terraform graph` は IAM や API の有効化まで全部の依存を並べるだけで人が読む図にならなかった。Mermaid なら GitHub でもそのまま表示でき、サービス単位にまとめられる（2026-10-02 の work-logs）。
WHY .png も置く: ユーザーの指示（Issue #324）。画像はエディタやチャットでもそのまま見られる。

## 図と元のファイル
| 図 | 読むもの | 描くもの |
| --- | --- | --- |
| `system.mmd` | `infra/modules/app/*.tf`、`.github/workflows/deploy.yml` | 外の利用者・GitHub Actions・Data Studio・MCP から、Cloud Run（service / job）・Secret Manager・Cloud SQL（database ごと）へのつながり。どの Secret をどれが読むか |
| `deploy.mmd` | `.github/workflows/deploy.yml`、`ci.yml` | きっかけ（PR・main への push・手動実行）、job の step の順、分岐（スキップ・失敗で止まる所） |
| `iam.mmd` | `infra/modules/app/iam.tf`・`github_wif.tf`・`run.tf` の `*_iam_member` | だれが（主体）→ どの役割で → 何に。役割は `roles/` を省いて辺のラベルにする |
| `database.mmd` | `infra/modules/app/sql.tf`、`infra/README.md`（psql で作るユーザー） | インスタンスの設定（tier・可用性）、database、ユーザーとつなぐ database |

環境の差（stg / prod）は `infra/envs/<環境>/variables.tf` の既定値だけなので、図は 1 環境分で描き、見出しか README に「stg / prod で 1 つずつ」と書く。

## 手順
1. 元のファイルを読む（上の表）。`grep -nE '^(resource|ephemeral|data|module)' -r infra/` で resource の一覧を出し、図に入れるもの・入れないものを分ける。
   - 入れる: 実行するもの（Cloud Run・job）、データ（Cloud SQL・Secret・Artifact Registry）、主体と権限（SA・WIF・`*_iam_member`）、外からの入口（`allUsers`・authorized networks）。
   - 入れない: API の有効化（`google_project_service`）、Secret の版、パスワードの `ephemeral`。`README.md` の説明か図の注記に数だけ書く。
2. `.mmd` を書き直す。今の図との差分が分かるように、消す・足すノードは resource と 1 対 1 で対応させる。
   - 1 行目は `%% <何の図>。元: <読んだファイル>（作り直しはスキル infra-diagram）`。
   - 色は `classDef` で種類ごとに固定する（今の `.mmd` の classDef をそのまま使う）。文字色を明示し、白背景で読めるようにする。
   - 線が交差して読めないときは、主体ごとに `subgraph`（`direction LR`）へ分け、同じ resource を各 subgraph に置いてよい（`iam.mmd` の形）。
   - Terraform に無いもの（運用の想定・手作業のユーザー）を描くときは、ラベルに「手作業」「想定」などと書き、コードにあるものと区別する。
3. 一括で画像にする: `bash scripts/render-diagrams.sh`。すべての `.mmd` を `.png` にし、元の無い `.png` を消す（mermaid-cli は `pnpm dlx` で版を固定して取得する。WHY と版はスクリプトの冒頭）。
   - Chromium は E2E の Playwright のものを使う。見つからない（クラウドセッションなど）ときは `PUPPETEER_EXECUTABLE_PATH=<chrome のパス>` を付ける（クラウドセッションは `/opt/pw-browsers/chromium`）。
4. できた `.png` を全部開いて見る（Read で画像を読む）。ラベルの重なり・線の交差で読めない所があれば 2 に戻る。
5. 図を足した・消したときは `docs/diagrams/README.md` の見出しと説明も直す。
6. `.mmd`・`.png`・`README.md` を同じコミットに入れる（PR の手順はスキル `pr-flow`）。

## 限界
- 図が最新かどうかは機械で検査していない（infra/ や deploy.yml を変えても CI は落ちない）。変えた PR でこのスキルを使う。
- 描くのは Terraform と workflow に書かれたものだけ。GCP のコンソールで手で変えたもの（drift）は図に出ない。

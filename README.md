# ai-only-template

AI（Claude Code）が Issue → ブランチ → PR → マージ の流れで開発を進めるためのテンプレートリポジトリ。
運用ルールは `CLAUDE.md` と `rules/` にまとめている。

## Tech Stack

| 領域 | 技術 | 備考 |
| --- | --- | --- |
| バージョン管理 | [asdf](https://asdf-vm.com/) | ツールのバージョンを `.tool-versions` でピン留めし、人間・AI が同じ環境で動かす |
| ランタイム | [Node.js](https://nodejs.org/) | 現行 LTS を使う |
| パッケージマネージャ | [pnpm](https://pnpm.io/) | latest を使う。npm / yarn は使わない |
| フレームワーク | [Next.js](https://nextjs.org/) | App Router を使う |
| UI ライブラリ | [React](https://react.dev/) | Next.js（create-next-app）が指定するバージョンに合わせる |
| 言語 | [TypeScript](https://www.typescriptlang.org/) | 最新版を使う |
| テスト | [Vitest](https://vitest.dev/) | React Testing Library + jsdom でコンポーネントをテストする |
| Lint / Format | [Biome](https://biomejs.dev/) | typescript-eslint が TypeScript 7 未対応のため ESLint ではなく Biome を使う（`rules/code/lint.md`） |
| Git フック | [Lefthook](https://github.com/evilmartians/lefthook) | pre-commit でステージ済みファイルを Biome で検査する |

ツールのバージョンは `.tool-versions` が正（決め方と更新手順は `rules/code/env.md`）。npm パッケージのバージョンは `package.json` / `pnpm-lock.yaml` が正。pnpm のサプライチェーン保護設定は `pnpm-workspace.yaml` を参照。

## ディレクトリ構成

機能（feature）単位で置く。`src/` は使わず、ルート直下に置く（例は Todo）。

```
app/                  # ルーティングだけ（page.tsx は screen を返すだけ、api/**/route.ts はコントローラを公開するだけ）
features/todo/        # 画面側
  screens/todo-screen/  # todo-screen.tsx（見た目）+ todo-screen.hook.ts（状態・データ取得）+ テスト
  api/                  # /api/... を fetch する薄いラッパー
  index.ts              # 公開 API（外から import してよいのはここだけ）
server/todo/          # API 側（DDD 4 層）
  presentation/         # Request → 入力検証 → use case → Response、dto.ts（画面側と共有する型）
  application/          # 1 ユースケース = 1 ファイル
  domain/               # Entity / Value Object / Repository の interface
  infra/                # Repository の実装（当面 InMemory）、container.ts（DI）
shared/               # 画面側で feature をまたぐ共通部品（必要になったら作る）
```

- 画面は SSR を前提にせず、データは hook から `/api/...` を呼んで取る。サーバの処理はすべて `server/` に置く。
- 画面側からサーバ側へは `dto.ts` の型を `import type` で参照するだけ。
- テストは対象の隣に置く（`app/` には置かない）。

詳細（依存の向き、命名、テストの置き方、採用しなかった案）は `rules/code/architecture.md` を参照。

## セットアップ

```sh
asdf plugin add nodejs
asdf plugin add pnpm
asdf install
```

バージョンの確認方法や更新手順の詳細は `rules/code/env.md` を参照。

Claude Code のクラウドセッション（asdf が無い環境）では、`scripts/cloud-session-start.sh` で `.tool-versions` どおりの Node.js / pnpm を用意する（環境設定の setup script に `bash scripts/cloud-session-start.sh --install-only` を書くと初回だけで済む）。`.tool-versions` の版を上げたら setup script も更新してキャッシュを作り直す。詳細は `rules/code/env.md` の「クラウドセッション」を参照。

## 開発

```sh
pnpm install   # 依存をインストール
pnpm dev       # 開発サーバを起動（http://localhost:3000）
pnpm test      # テストを実行（Vitest）
pnpm lint      # lint + format の違反を検査（Biome。変更しない）
pnpm check     # 安全な自動修正を適用して再検査（Biome）
pnpm format    # format だけを適用（Biome）
pnpm build     # 本番ビルド
```

`pnpm install` で pre-commit フック（Lefthook）も入り、コミット時にステージ済みファイルが Biome で検査される。詳細は `rules/code/lint.md` を参照。

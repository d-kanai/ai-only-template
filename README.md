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
| 言語 | [TypeScript](https://www.typescriptlang.org/) | |
| テスト | [Vitest](https://vitest.dev/) | React Testing Library + jsdom でコンポーネントをテストする |

ツールのバージョンは `.tool-versions` が正（決め方と更新手順は `rules/env.md`）。npm パッケージのバージョンは `package.json` / `pnpm-lock.yaml` が正。pnpm のサプライチェーン保護設定は `pnpm-workspace.yaml` を参照。

## セットアップ

```sh
asdf plugin add nodejs
asdf plugin add pnpm
asdf install
```

バージョンの確認方法や更新手順の詳細は `rules/env.md` を参照。

## 開発

```sh
pnpm install   # 依存をインストール
pnpm dev       # 開発サーバを起動（http://localhost:3000）
pnpm test      # テストを実行（Vitest）
pnpm build     # 本番ビルド
```

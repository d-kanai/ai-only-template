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

## セットアップ

```sh
asdf plugin add nodejs
asdf plugin add pnpm
asdf install
```

バージョンの確認方法や更新手順の詳細は `rules/code/env.md` を参照。

Claude Code のクラウドセッション（asdf が無い環境）では、`scripts/cloud-session-start.sh` で `.tool-versions` どおりの Node.js / pnpm を用意する（環境設定の setup script に `bash scripts/cloud-session-start.sh --install-only` を書くと初回だけで済む）。ただし 2026-09-28 時点では、クラウド環境が nodejs.org を拒否するため SessionStart フックでの Node / pnpm の導入を一時停止しており、フックは VM 既定の Node 22 / pnpm で `pnpm install` だけを行う。`.tool-versions` の版を上げたら setup script も更新してキャッシュを作り直す。詳細は `rules/code/env.md` の「クラウドセッション」を参照。

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

# 実行環境ルール

ツールのバージョンは asdf で管理し、`.tool-versions` をリポジトリにコミットして全員（人間・AI）が同じ環境で動かす。

## Node.js
- 現行の **LTS** を使う。Current（奇数メジャー・LTS 前）は使わない。
- バージョンの決め方: 1次情報（nodejs.org の公式リリース一覧）で最新 LTS を確認する。
  ```
  curl -s https://nodejs.org/dist/index.json | jq -r '[.[] | select(.lts != false)][0] | .version + " " + .lts'
  ```
  その具体的なバージョン（例: `24.x.y`）を `.tool-versions` に書く。`lts` のようなエイリアスは書かない（時間で解決先が変わるため）。
- `asdf nodejs resolve lts --latest-available` には頼らない（2026-09-28 時点、最新 LTS が 24.21.0 なのに 22.x を返した。実行時刻で 22.21.1 / 22.23.3 と値も変わる）。
- 新しい LTS が出たら Issue → PR で `.tool-versions` を上げる。

## pnpm
- パッケージマネージャは **pnpm** のみ。npm / yarn は使わない（`package-lock.json` / `yarn.lock` を作らない）。
- バージョンは **latest**。次のコマンドで最新を確認し、その具体的なバージョンを `.tool-versions` に書く。
  ```
  asdf list all pnpm | tail -1
  ```
- `package.json` を作るときは、`packageManager` フィールドにも同じバージョンを書く（`pnpm@x.y.z`）。

## 手順（初回・更新時）
```
asdf plugin add nodejs   # 未追加なら
asdf plugin add pnpm     # 未追加なら
asdf install             # .tool-versions のとおりに入れる
node --version && pnpm --version   # .tool-versions と一致することを確認
```

- `.tool-versions` を変えたら `asdf install` を実行し、`node --version` / `pnpm --version` の出力が一致することを確認してからコミットする。
- 一致しないときは `which node` を見る。`~/.asdf/shims/node` 以外（例: `~/.asdf/installs/nodejs/<別バージョン>/bin/node`）を指していたら PATH の問題であり、`.tool-versions` は正しい。`asdf which node` と `~/.asdf/shims/node --version` で確認する。
- Claude Code から実行するシェルではこの不一致が必ず起きる。Claude Code は asdf 管理の Node（2026-09-28 時点 22.12.0）配下にグローバルインストールされており、asdf の shim が起動時にその Node の bin を PATH の先頭に入れるため、子プロセスの素の `node` は `.tool-versions` を無視してその Node になる。AI が確認するときは `asdf which node` / `~/.asdf/shims/node --version` を使う。

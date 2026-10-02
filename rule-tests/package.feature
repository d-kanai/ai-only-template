# 依存の版を package.json 上でも完全固定する決まり（.claude/rules/dependencies.md）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の package.test.ts。
# 規則の WHY と限界は package.test.ts の冒頭。
Feature: package.json の依存の版
  Scenario: 版の判定（isPinnedVersion）
    * 完全固定の版は許可する（1.2.3・0.0.1・10.20.30）
    * 完全固定でない書き方は拒否する（キャレット・チルダ・比較演算子・範囲・x・メジャーだけ・先頭が 0・任意の版・dist-tag・workspace プロトコル・npm: の別名・パス・git・URL・空文字・= と v 付き・空白・プレリリース・ビルドメタ）
  Scenario: 許可する書き方の判定（isAllowedVersion）
    * 完全固定の版と workspace: の星印は許可する（1.2.3・0.0.1・workspace: の星印）
    * 星印以外の workspace: と完全固定でない版は拒否する（workspace: の ^・~・版・範囲・空・星印 2 つ・前後の空白、キャレット、任意の版）
  Scenario: 範囲指定の検出（findNonPinnedVersions）
    * dependencies の範囲指定を検出する
    * devDependencies の範囲指定を検出する
    * すべて完全固定なら何も検出しない
    * workspace: の星印は検出せず、それ以外の workspace: は検出する
    * dependencies / devDependencies が無い package.json は依存 0 件として扱う
  Scenario: workspace の中での版のずれの検出（findInconsistentVersions）
    * 同じ名前の依存が、すべての package.json で同じ版なら何も検出しない
    * 名前が違えば版が違っても検出しない（前方一致だけが同じ別パッケージも別名）
    * 片方の package.json にだけある依存は検出しない
    * リポジトリ直下と app で版が違う依存を、出てくる場所ごとに検出する
    * 同じ package.json の dependencies と devDependencies で版が違う依存も検出する
  Scenario: package.json の実ファイル
    * 範囲指定を含む package.json からは、違反の依存をすべて検出する
    * pnpm-workspace.yaml の packages に当たり package.json を持つディレクトリを、リポジトリ直下の package.json と合わせて列挙する
    * pnpm-workspace.yaml の packages が <ディレクトリ>/ の後が星印 1 つの形以外なら、読み落とさずに例外にする
    * リポジトリ直下と apps の下の package.json をすべて列挙できる
    * workspace の package.json の dependencies と devDependencies のそれぞれから 1 件以上の依存を列挙できる
    * workspace の package.json をまたいで、同じ名前の依存は同じ版で書かれている
    * 2 つ以上の package.json に出てくる依存（pg）を、比べる対象として列挙できる
    * workspace のすべての package.json の dependencies / devDependencies は完全固定（x.y.z）か workspace: の星印で書かれている

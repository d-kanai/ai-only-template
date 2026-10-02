# テストだけが使うコード test-support の置き場所と除外（Issue #181）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の test-support.test.ts。
# 規則の WHY と限界は test-support.test.ts の冒頭。
Feature: test-support の置き場所と除外
  Scenario: .dockerignore の行（hasDockerignoreEntry）
    * .dockerignore に test-support の行があれば違反なし（前後に空白・途中の行）
    * .dockerignore に test-support の行が無ければ違反（行が無い・コメントアウト・末尾の / 付き・! で戻す行・前方一致の別の名前・空など）
  Scenario: .dockerignore のパターンの解釈（isExcludedByDockerignore）
    * .dockerignore の行で除外されるパス（名前のパターンと拡張子のパターンに一致・コメントと空行を挟む・解釈できない ! の後ろで除外し直す・別の名前の ! は戻さないなど）
    * .dockerignore の行で除外されないパス（行が無い・最初の要素でない・前方一致や後方一致だけ・コメントアウト・後ろの ! で戻す・解釈できない除外の行・空など）
  Scenario: 本番のソースか（isProductionSource）
    * apps の下のテストでも test-support でもないソースは本番のソース（ts・tsx・mts・cjs・名前の一部に test-support を含むもの・.test-helper など）
    * test-support の下・テスト・ソースでないファイルは本番のソースではない（test-support/ の下・.test.ts / .test.tsx / .test.mjs・README.md・package.json）
  Scenario: 本番のコードからの test-support の import（findTestSupportImports）
    * test-support を import しない本番のコードは違反なし（関係の無い import・前方一致や後方一致だけの別のモジュール・コメントの中・文字列・空）
    * 本番のコードの test-support の import は、その行の番号で違反になる（相対パス・alias・サブパス・import type・副作用だけ・dynamic import()・export … from など）
  Scenario: package.json の exports（findTestSupportInExports）
    * exports に test-support が無ければ違反なし（exports が無い・条件付きの入れ子・文字列だけ・配列の値は見ない）
    * exports のキーか値の test-support は違反（キー・値・両方・条件付きの入れ子の値・文字列だけの exports・以前の置き方の名前）
  Scenario: InMemory の実装の置き場所（isMisplacedInMemory）
    * apps/backend/test-support/ の下の .in-memory のソースと、.in-memory のソースでないものは違反なし（名前の一部だけが in-memory・テスト・.md・frontend・apps/backend の外）
    * apps/backend/test-support/ の外の apps/backend の .in-memory のソースは違反（features の infra・shared の infra・application・features の下の test-support・前方一致の test-support-x など）
  Scenario: 列挙と検査（fixture）
    * 違反の無いツリーは違反 0 件（列挙は test-support/ のファイル・本番のソース・apps/<app>/package.json）
    * すべての規則の違反を「規則: パス」で返す
    * 行があっても、後ろの ! の行で戻したファイルは除外されない
    * test-support の行があっても、test-support を import するテストの拡張子の行が無ければそのテストだけが違反
    * in-memory-placement: apps/backend の下の .in-memory のソースを列挙し、test-support/ の外にあるものだけが違反
    * apps/ も .dockerignore も無ければ、列挙は 0 件で行が無い違反だけ（本番の検査は 0 件を失敗にする）
  Scenario: deploy.yml のイメージの検査のステップ（findDeployVerifyViolations）
    * runtime と migrate のイメージを検査するステップがあれば違反なし（間に別のステップ・コメント・run が 1 行）
    * イメージの検査のステップが欠けていれば違反（ステップが無い・migrate のステップが無い・コメントアウト・run に find のパターンが無いなど）
  Scenario: test-support（実ファイル）
    * dockerignore-entry: .dockerignore に test-support をすべての階層で除外する行がある
    * dockerignore-excludes: apps/<app>/test-support/ のすべてのファイルと test-support を import するテストが .dockerignore で除外される
    * production-imports-test-support: 本番のコードは test-support を import しない
    * deploy-verifies-images: deploy.yml が runtime と migrate のイメージに test-support が無いことを確かめる
    * exports-test-support: apps/<app>/package.json の exports に test-support が無い
    * in-memory-placement: apps/backend の .in-memory のソースは apps/backend/test-support/ の下だけにある

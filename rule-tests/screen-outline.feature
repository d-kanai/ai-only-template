# 画面のファイルを骨組み（Layout の下に Section と Form を並べるだけ）にする 6 規則 screen-outline-placement /
# screen-outline-single-export / screen-outline-layout-root / screen-outline-layout-children / screen-outline-single-return /
# screen-outline-use-client を検査するルール検査テストの仕様（Issue #292。screen-outline-use-client は Issue #332）。
# step の実装は対の screen-outline.test.ts。規則の WHY と限界は screen-outline.test.ts の冒頭。
Feature: 画面の骨組み
  Scenario: 画面のファイル（isScreenFile・screenFunctionName）
    * must pass: features の下の screens の、ディレクトリと同じ名前の -screen.tsx は画面のファイルで、画面の関数の名前はファイル名の PascalCase
    * must reject: テスト・hook・辞書・ディレクトリと名前の違うファイル・入れ子・screens の外・features の外・拡張子の違うファイルは画面のファイルでない
  Scenario: screens の下の置き方（findPlacementViolations）
    * must pass: screens の下の、ディレクトリと同じ名前の -screen.tsx と hook と辞書とテストと、コード以外のファイルと screens の外は違反にしない
    * must reject: screens の直下のファイル・名前のそろっていないディレクトリ・-screen で終わらないディレクトリ・入れ子・ほかの名前のファイル・拡張子の違うファイルは違反
  Scenario: export する値（findSingleExportViolations）
    * must pass: 画面の関数だけを export function で export し、型の export と export しない部品はあってよい
    * must reject: ほかの値の export・名前の違う画面の関数・export default・export const の画面・画面の関数が無いのは違反
  Scenario: Layout の根（findLayoutRootViolations）
    * must pass: return の根が atom の Layout で、かっこで包んでも中身が無くてもよい
    * must reject: 根が Layout でない要素・Fragment・式・別の場所から取り込んだ Layout・取り込んでいない Layout は違反
  Scenario: Layout の直下（findLayoutChildrenViolations）
    * must pass: 同じファイルの export しない Section と Form の部品の要素に、props と空白とコメントだけなら違反にしない
    * must reject: 文字列・式・Fragment・atom・素の要素・import した部品・export した部品・名前が Section か Form で終わらない部品は違反
  Scenario: return の数（findSingleReturnViolations）
    * must pass: 画面の関数の return が 1 つなら違反にせず、中で定義した関数とほかの関数の return は数えない
    * must reject: 早期 return を含む複数の return と、return の無い画面の関数は違反
  Scenario: 最初の文の "use client"（findUseClientViolations）
    * must pass: 最初の文が "use client" のディレクティブなら、一重引用符でも、前にコメントがあってもよい
    * must reject: "use client" が無い・import の後・ほかのディレクティブの後・バッククォート・かっこで包んだもの・式の一部・別の文字列・空のファイルは違反
  Scenario: 列挙と検査（fixture）
    * 列挙は features の画面のファイルだけで、違反の無いツリーは違反 0 件
    * すべての規則の違反を「規則: パス:行 内容」で、置き方の違反は「規則: パス」で返す
    * apps/frontend_customer が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: 画面の骨組み（実ファイル）
    * 列挙: features の画面のファイルが 1 件以上ある
    * screen-outline-placement: screens の下のテスト以外のコードは、ディレクトリと同じ名前の画面と hook と辞書だけ
    * screen-outline-single-export: 画面のファイルが export する値は画面の関数 1 つだけ
    * screen-outline-layout-root: 画面の関数の return の根は atom の Layout
    * screen-outline-layout-children: Layout の直下は同じファイルの export しない Section と Form の部品の要素だけ
    * screen-outline-single-return: 画面の関数の return は 1 つだけ
    * screen-outline-use-client: 画面のファイルの最初の文は "use client" のディレクティブ

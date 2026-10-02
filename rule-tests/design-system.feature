# デザインシステム（Mantine。Issue #292）の 3 規則 design-system-no-direct-style / design-system-css-placement / design-system-themed-components を
# 検査するルール検査テストの仕様。step の実装は対の design-system.test.ts。規則の WHY と限界は design-system.test.ts の冒頭。
Feature: デザインシステム
  Scenario: 見た目を直接書く JSX 属性（findDirectStyles）
    * must pass: 部品を置くだけの JSX・見た目と関係の無い属性・コメントと文字列の中の style は違反にしない
    * must reject: style / className / classNames / styles / vars・style props・見た目を選ぶ props は、要素・値の形・拡張子を問わず違反
    * must pass: 余白の props と並べ方の間隔 gap など は、値が段階名 xs・sm・md・lg・xl の文字列リテラルなら違反にしない（属性の文字列と式の中の文字列の両方）
    * must reject: 余白の props と並べ方の間隔に、数値・段階名でない文字列・テンプレート・変数・式・オブジェクト・値の無い属性を書くと、段階名だけ書けることを添えて違反
    * must reject: 余白でない style props の幅・色など と見た目を選ぶ props は、値が段階名でも違反
  Scenario: 余白の props の一覧（spacingProps）
    * STYLE_PROPS_DATA のうち type が spacing で margin か padding の props と、gap などの並べ方の間隔だけを余白として読み、幅と高さは読まない
  Scenario: テーマの部品の一覧（themedComponents）
    * 型 ThemedComponent の union の文字列リテラルを書かれた順に読み、ほかの型・コメント・文字列は読まない
    * ファイルが無い・型が無ければ空
  Scenario: @mantine/core の部品の取り込み（findUnthemedMantineImports）
    * must pass: 一覧にある名前の値の import・型だけの import・ほかのパッケージ・サブパスは違反にしない
    * must reject: 一覧に無い名前（別名の元の名前で見る）、既定・名前空間・export と星印・import()・require() は違反
  Scenario: .css の import（findCssImports）
    * must pass: .css 以外の import・コメントと文字列の中の .css は違反にしない
    * must reject: 副作用・既定・名前空間の import、export … from、import()、require()、import x = require() の .css は違反
  Scenario: 対象のソースと .css の置き場所（isCheckedSource・isMisplacedCss）
    * must pass: テスト・shared/ui/ の中・ソースでないファイルは検査の対象外、shared/ui/ の下の .css は置いてよい
    * must reject: shared/ui/ の外（前方一致の境界 shared/ui-x/・shared/uix/ も）のソースは対象、.css は置き場所の違反
  Scenario: 列挙と検査（fixture）
    * 違反の無いツリーは違反 0 件（列挙はテスト以外のソース）
    * すべての規則の違反を「規則: パス:行」で返す（置き場所の違反は「規則: パス」）
    * theme-definition.ts が無ければ一覧は空で、@mantine/core の値の import はすべて違反
    * apps/frontend_customer が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: デザインシステム（実ファイル）
    * Mantine の style props の一覧と余白の props を @mantine/core の STYLE_PROPS_DATA から読める（空でない、幅と高さは余白に入れない）
    * テーマの部品の一覧（theme-definition.ts の ThemedComponent）を読める（空でない）
  Scenario: デザインシステム（実ファイル）: 規則ごとの検査
    * 列挙: apps/frontend_customer のテスト以外のソース（shared/ui/ の外）が 1 件以上ある
    * design-system-no-direct-style: shared/ui/ の外で style・className・Styles API・Mantine の style props を書かない（余白は段階名だけ）
    * design-system-css-placement: .css は shared/ui/ の下だけに置き、shared/ui/ の外から import しない
    * design-system-themed-components: shared/ui/ の外で @mantine/core から値で取り込むのは ThemedComponent にある部品だけ

# 指示ファイル（CLAUDE.md・.claude/general・.claude/rules・スキル・エージェント・ADR。Issue #86）の構成と形式を検査するルール検査テストの仕様（Issue #282）。step の実装は対の instructions.test.ts。
# 規則の WHY と限界は instructions.test.ts の冒頭。
Feature: 指示ファイルの構成と形式
  Scenario: CLAUDE.md の行数と @ import の抽出
    * 行数は末尾の改行を数えない（wc -l と同じ）
    * CLAUDE.md は 200 行まで、.claude/general は 25 行までを許し、超えたら違反にする
    * 行頭か空白の直後の @path を import として拾う（must reject 側の入力）
    * コードブロック・コードスパン・メールアドレスの @ は拾わない（must pass 側の入力）
    * @ で読んでよいのは LEARNINGS.md と .claude/general の直下の .md だけ
    * 無いファイル・許可外のファイルへの @ を違反にし、読んだファイルの @ も辿る
    * 許可されたファイルだけを指す @ は違反にしない
  Scenario: .claude/rules のフロントマター
    * paths のリストを読み、クォートを外す
    * すべての glob がファイルに一致すれば違反にしない（must pass）
    * フロントマターの paths が無い・閉じていない・空・スカラー・コメントアウトなら違反にする（must reject）
    * どのファイルにも一致しない glob（typo）を違反にする（must reject）
  Scenario: スキルのフロントマター
    * name と description があれば違反にしない（must pass）
    * フロントマターが無い・name が無い・description が空なら、欠けたキーを違反にする（must reject）
  Scenario: サブエージェントの model
    * 許可したフル ID なら違反にしない（must pass）（許可したフル ID のそれぞれ）
    * model が別名・古い ID・空・無い・フロントマターが無いなら違反にする（must reject）
  Scenario: 旧 rules/ への参照
    * 旧 rules/ の code と general への参照（文中・括弧の中・@ の import・コードスパン）を違反にする（must reject）
    * .claude/rules/ の下・旧 rules/ の削除の説明・名前の一部・別の rules は違反にしない（must pass）
    * docs/work-logs/ とこのファイルは検査しない
  Scenario: ADR（docs/adr/<分類>/）の形式
    * テンプレートどおり・廃止・同じ分類や別の分類への置き換え・必須の見出しの間の別の見出しは違反にしない（must pass）
    * ファイル名が yyyymmdd-topic.md（topic は英小文字・数字の kebab-case）でなければ違反にする（must reject）（日付の書き方・区切り・大文字・下線・空の topic・連続や末尾のハイフン・拡張子・README.md）
    * 1 行目が「# 」の見出しでなければ違反にする（must reject）（見出しが無い・## ・# の後に空白が無い・見出しが空）
    * 3 行目が「- 日付: YYYY-MM-DD」でなければ違反にする（must reject）（区切りが /・全角のコロン・日付が無い）
    * 日付がファイル名の日付と違えば違反にする（must reject）
    * 4 行目の状態が決まった形でなければ違反にする（must reject）（決まった語でない・英語・置き換え先が無い・置き換えの括弧が半角）
    * 置き換え先が docs/adr に無いか、分類/ファイル名 の形でなければ違反にする（must reject）（存在しない・分類なし・分類が違う・./ 付き・相対パス・リポジトリ相対のパス）
    * 5 行目の関連が空・空白だけ・別の項目なら違反にする（must reject）
    * 必須の見出しのどれか 1 つが無ければ、その見出しを違反にする（must reject）（必須の見出しのそれぞれ）
    * 見出しの段が違う・後ろに文字がある見出しは、無いものとして違反にする（must reject）
    * 必須の見出しの順が違えば違反にする（must reject）
    * ADR が docs/adr/README.md の一覧にリンクで載っていなければ違反にする（must reject）（README.md が無い・リンクが無い・文字だけ・別の名前・分類が無い・分類が違う）
  Scenario: ADR の一覧の状態とリンク先（adr-index-state）
    * 状態が ADR と一致し、リンク先がすべてあれば違反にしない（must pass。見出し・区切り・表の外の行は読まない）
    * README.md が無ければ、この検査は違反を出さない（一覧に無いことは adr-index が出す）
    * 一覧の状態が ADR の状態と違えば違反にする（must reject）（置き換えた ADR を採用のまま・置き換え先の名前が違う・分類が無い・状態が空）
    * ADR の状態の行が崩れていれば、その行と比べて違反にする（must reject）
    * 一覧のリンク先が docs/adr に無ければ違反にする（must reject）（存在しない・分類なし・分類が違う・./ 付き・README.md 自身）
  Scenario: ADR の分類ディレクトリ（adr-category）
    * 4 つの分類の直下のファイルと、分類の外のファイルは違反にしない（must pass。直下のファイルは adr-only が見る）
    * 4 つ以外の分類（大文字・前方一致・旧案の名前を含む）と、分類の下のディレクトリを 1 項目ずつ違反にする（must reject）
    * 形式の検査（adr-name ほか）の対象は、4 つの分類の直下のファイルだけ
  Scenario: docs/ には adr/ と work-logs/ だけ、docs/adr/ の直下には README.md と分類だけ（adr-only）
    * docs/adr/ の下のディレクトリのファイル・docs/adr/README.md・docs/work-logs/ の下のファイル・docs/ の外のファイルだけなら違反にしない（must pass）
    * docs/adr/ の直下の README.md 以外のファイル（ADR・大文字違いの readme・分類名のファイルを含む）を違反にする（must reject）
    * docs/ の直下のファイル・ディレクトリ（adr / work-logs の前方一致と、その名前のファイルを含む）を 1 項目ずつ違反にする（must reject）
  Scenario: ルール検査テストの一覧（rule-tests-index）
    * rule-tests の直下の .feature の名前をルール検査テストとして読み、入れ子とほかの拡張子は読まない
    * CLAUDE.md の本数と名前、.claude/rules/testing.md の rule-tests/<名前>.test.ts がそろっていれば違反にしない（must pass）
    * CLAUDE.md の本数が違う・本数の記載が無い・名前が無い、testing.md に rule-tests/<名前>.test.ts が無ければ違反にする（must reject。名前は CLAUDE.md の本数の後ろの（…。と testing.md の「今あるもの:」の行の中だけを見る）
    * ルール検査テストが 0 件なら、この検査は違反を出さない
  Scenario: fixture のリポジトリを検査したときに検出される違反
    * 許可される構成では違反 0 件（must pass。.gitignore の中と docs/work-logs/ の旧参照は数えない）
    * 違反を入れた構成では、すべての違反を検出する（must reject）
  Scenario: リポジトリの指示ファイル
    * 列挙が空でない（対象 0 件で緑にならない）
    * CLAUDE.md・.claude/general・.claude/rules・スキル・エージェント・ADR に違反が無く、旧 rules/ も残っていない
    * docs/ の直下には adr/ と work-logs/ しか無い

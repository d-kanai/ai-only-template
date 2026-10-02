# domain 仕様（apps/backend/spec/domain の .feature と step の実装。Issue #318）を検査するルール検査テストの仕様。step の実装は対の domain-spec.test.ts。
# 規則の WHY と限界は domain-spec.test.ts の冒頭。
Feature: domain 仕様の置き場所と書き方
  Scenario: domain 仕様の置き場所（isMisplacedDomainSpecFile）
    * spec/domain/<feature>/ の直下の .feature と step の実装、domain 仕様でないファイルは違反なし（API 仕様・層の下の単体テストなど）
    * spec/domain/<feature>/ の直下でないファイル・ほかの種類のファイルと、spec/domain/ の外の step の実装は違反（spec/domain/ の直下・入れ子・support.ts など）
  Scenario: .feature と step の実装の対（findPairViolations）
    * 同じ名前の .feature と step の実装がそろえば違反なし
    * 片方だけ・名前の違う組は、対の無いほうの違反になる
  Scenario: .feature のキーワードとタグ（findFeatureContentViolations）
    * Feature・Rule・Scenario の見出し・箇条書きの step・説明の行・コメント・空行だけなら違反なし（行の区切りが CRLF でも）
    * Background・Scenario Outline・Example などのキーワード、Given などの step、言語の指定、タグの行は、行の番号で違反になる
  Scenario: .feature の仕様メモの構造（findFeatureContentViolations）
    * Feature の後と各 Rule の後に説明の行があり、Scenario がすべて Rule の下で、箇条書きの step を持てば違反なし（説明が複数行・Scenario の中の説明の行など）
    * Feature や Rule の後に説明の行が無い（コメントと空行だけ・表と docstring だけも）と、見出しの行の違反になる
    * Rule が無い・Rule より前の Scenario・Scenario の無い Rule・step の無い Scenario・Scenario の外の step・Feature の見出しの欠けと重なりは違反になる
  Scenario: .feature の業務の言葉（findFeatureContentViolations）
    * 見出し・説明・step の行の禁止語は行の番号で違反になり、コメントの行の禁止語は違反なし
  Scenario: step の実装の loadFeature と skip（findStepContentViolations）
    * 対の .feature を第 2 引数なしで読めば違反なし（単一引用符・名前空間・文字列やコメントの中の skip など）
    * loadFeature の無い・describeFeature に渡さない・対でない・第 2 引数のある読み方、ほかの読み込み口と設定、skip・only とタグの絞り込みは違反
  Scenario: step の実装の import（findStepContentViolations の domain-spec-pure）
    * 同じ feature の domain のモジュールを相対パスで値として import すれば違反なし（複数行・type の混じった import・拡張子付き・domain の下の入れ子など）
    * InMemory と実 DB の import（型だけ・dynamic import・再公開も）は行の違反、同じ feature の domain の値の import が無ければファイルの違反になる
  Scenario: 列挙と検査（fixture）
    * spec/domain/ の下と外の domain 仕様の step を対象にし、違反を「規則: パス(:行)（理由）」で返す
    * apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: domain 仕様（実ファイル）
    * apps/backend/spec/domain/ の下に domain 仕様があり、置き場所・対・.feature の形・step の実装の規則に違反が無い

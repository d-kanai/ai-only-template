# API 仕様（apps/backend/spec/api の .feature・step の実装・support.ts。Issue #219）を検査するルール検査テストの仕様（Issue #282）。step の実装は対の api-spec.test.ts。
# 規則の WHY と限界は api-spec.test.ts の冒頭。
Feature: API 仕様の置き場所と書き方
  Scenario: API 仕様の置き場所（isMisplacedApiSpecFile）
    * API 仕様の置き場所にある .feature・step・support.ts と、API 仕様でないファイルは違反なし（presentation の api ファイル・API ジャーニーなど）
    * spec/api/<feature>/ の直下でない .feature・step・support.ts と、spec/api/ の外の API 仕様は違反（spec/api/ の直下・サブディレクトリなど）
  Scenario: api ファイルと API 仕様の対（findPairViolations）
    * api と .feature と step の 3 つがそろえば違反なし
    * 3 つのどれかが欠けると、欠けた側の違反になる（api に .feature や step が無い・api の無い .feature や step など）
  Scenario: .feature の中身（findApiSpecViolations）: must pass
    * .feature のコメント・空行・Feature の見出し・固定の見出しの Scenario と箇条書きの step は違反なし（説明の行・表の行・Scenario の無い .feature など）
  Scenario: .feature の中身（findApiSpecViolations）: must reject
    * .feature の見出し・キーワード・禁止語の違反を行で返す（一覧に無い見出し・空の見出し・同じ見出しの 2 つ目など）
  Scenario: step の実装の中身（findApiSpecViolations）: must pass
    * step の実装が実 DB と対の api を値で import すれば違反なし（複数行・type の混じった import・@repo/backend/ の書き方・拡張子付きなど）
    * api ファイルは中身を見ない
  Scenario: step の実装の中身（findApiSpecViolations）: must reject
    * step の実装の vi・InMemory・api の参照の違反を行で返す（vitest から vi・vi の別名・名前空間・既定の import・dynamic import() など）
    * 置き場所が違えば置き場所の違反だけを返す（中身は見ない）
  Scenario: step の実装が呼べる API（findApiSpecViolations の api-spec-own-api-only）
    * step の実装が support.ts から対の組み立てのクラスと補助のクラスを import すれば違反なし（別名・拡張子付き・複数行も）
    * step の実装がほかの API の組み立てのクラスを import すれば違反（対のクラスと一緒・別名・複数行・名前の取り違えなど）
    * 対の組み立てのクラスの名前は api ファイルの名前の PascalCase に ApiAssembly を足したもの（change-x-completion → ChangeXCompletionApiAssembly）
  Scenario: step の実装の loadFeature と skip（findApiSpecViolations）
    * 対の .feature を第 2 引数なしで読めば違反なし（単一引用符・括弧の内側の空白・名前空間の import 経由など）
    * loadFeature の無い・対でない・第 2 引数のある読み方と skip は違反（loadFeature が無い・language を渡す・別の api のパスなど）
  Scenario: 補助 support.ts の中身（findApiSpecViolations）
    * support.ts が自 feature の api を値で import すれば違反なし（vitest の expect・drizzle など api 以外の import もあってよい）
    * support.ts が api を値で import しなければ違反（import が何も無い・api を型だけで import など）
    * dynamic import()・export … from・コメントの中の import は数えない（dynamic import() と export … from は no-api-call にも当たる）
    * vitest から vi を import すれば、その行の違反（step と同じ判定。api を組み立てていても）
    * console の差し替えだけに使う vi も違反（step だけの例外）
  Scenario: 補助 support.ts の組み立て（findApiSpecViolations）: must pass
    * support.ts が API ごとの組み立てのクラスで api を 1 つだけ new して handle を返せば違反なし（export の有無・abstract も）
  Scenario: 補助 support.ts の組み立て（findApiSpecViolations）: must reject
    * support.ts の組み立ての違反を行で返す（handler を呼ぶ・空白を挟む・.handle.call など）
  Scenario: API 仕様の列挙と検査（fixture）
    * spec/api/ の下・外の .api-spec.test のファイル・api ファイルを対象にし、違反を「規則: パス(:行)（無いファイル）」で返す
    * apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: API 仕様（実ファイル）
    * presentation の api ファイルごとに apps/backend/spec/api/<feature>/ に <api>.feature と <api>.api-spec.test.ts があり、.feature は固定の見出しの Scenario と箇条書きの step を業務の言葉だけで書き、step の実装は vi と InMemory を使わず、実 DB を使って対の api を参照し、対象でない API の handler を手に入れず、support.ts が api を値で API ごとに組み立て、handler を呼ばない

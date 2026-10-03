# ディレクトリ構成ルールの依存の向き・置き場所・exports・環境変数・console・現在時刻・文言などを検査するルール検査テストの仕様（Issue #282）。step の実装は対の architecture.test.ts。
# 規則の WHY と限界は architecture.test.ts の冒頭（規則の一覧は .claude/rules/code/architecture-check.md）。
Feature: ディレクトリ構成ルール（依存の向き）
  Scenario: 依存の向き（rules の code/architecture-check.md）
    * 検査の対象から参照を取り出せている（抽出が壊れて 0 件になり、すべての規則が素通りするのを防ぐ）
    * apps/backend/ のソースファイルは apps/backend/features/<f>/internal/ の domain/・application/・presentation/・infra/ のどれかの下か、apps/backend/shared/ の error/・transaction/・http/・drizzle/・change-log/ のどれかの下か、モジュールの公開の入口 apps/backend/features/<f>/expose/ の直下か、テストだけが使う apps/backend/test-support/ の下か、API 仕様の補助 apps/backend/spec/api/<feature>/support.ts に置く
    * apps/frontend_customer/ のソースファイルは app/・features/・shared/・test-support/ の下か、直下の next.config.ts・instrumentation.ts・instrumentation-node.ts・proxy.ts・next-env.d.ts だけに置く
    * apps/shared/ に置いてよいのは env.ts・logger.ts・log-event.ts・now.ts とそのテスト（env.test.ts・logger.test.ts・log-event.test.ts・now.test.ts）、env.ts と log-event.ts から分けたクラスのファイル（env-reader.ts・log-field-marks.ts・free-text-mask.ts・request-log-schema.ts・log-severity.ts）、package.json・tsconfig.json だけ
    * apps/shared の全ファイル（ソース・テスト・package.json・tsconfig.json）を列挙できている（列挙が壊れて素通りするのを防ぐ）
    * apps/frontend_customer/・apps/e2e/・リポジトリ直下のファイルから apps/backend/ への参照は "@repo/backend/..." の書き方だけ（相対パスや "@/../backend/" を使わない。例外は vitest.global-setup.ts → test-support/database の相対パスだけ）
    * apps/frontend_customer/・apps/e2e/・リポジトリ直下のファイルから apps/shared/ への参照は "@repo/shared/..." の書き方だけ（相対パスや "@/../shared/" を使わない）
    * apps/backend/ は apps/frontend_customer/ を参照しない
    * apps/backend/ の中の自前コードへの import は相対パスだけで（"@/" と "@repo/backend/" を使わない）、apps/shared へは "@repo/shared/..." だけ（相対パスは使わない）
    * apps/frontend_customer/ 直下のファイルは apps/backend/ を参照しない（env・logger は apps/shared から使う）
    * apps/frontend_customer/features/<f>/ の api/ 以外と apps/frontend_customer/shared/ は apps/backend/ を参照しない
    * apps/frontend_customer の app/・features/・shared/ は apps/shared/ を参照しない（env・logger をブラウザのバンドルに持ち込まない）
    * apps/frontend_customer/features/<f>/api/ から apps/backend/ への参照は型だけで、参照先は自 feature の apps/backend/features/<f>/internal/presentation/<名前>.api か apps/backend/shared/http/ だけ
    * 別の feature を参照するときは apps/frontend_customer/features/<other>（index）だけ
    * apps/frontend_customer の features/ と shared/ は app/ を参照しない
    * apps/frontend_customer/shared/ は features/ を参照しない
    * apps/backend/features/<f>/internal/domain/ が参照してよい自前コードは自 feature の domain/ と apps/backend/shared/ の単位（error・transaction・http・drizzle・change-log のどれも）と apps/shared/ の now だけで、next・react も参照しない
    * apps/backend/features/<f>/internal/ の domain/・application/ は DB のパッケージ（drizzle-orm とそのサブパス、pg）を直接参照しない（型だけでも。apps/backend/shared/ を経由した参照は縛らない）
    * apps/backend/features/<f>/internal/application/ が参照してよい自前コードは自 feature の domain/・application/ と apps/backend/shared/ の単位（どれも）と apps/shared/ の now だけで、next・react も参照しない
    * apps/backend/features/<f>/internal/presentation/ が参照してよい自前コードは自 feature の application/・domain/（型と UPPER_SNAKE_CASE の定数だけ）・presentation/・infra/<名前>-repository.postgres と apps/backend/shared/ の単位（どれも）と他のモジュールの expose/ と apps/shared/ の logger・now だけで、next・react も参照しない
    * apps/backend/features/<f>/internal/infra/ が参照してよい自前コードは自 feature の domain/・infra/ と apps/backend/shared/ の単位（どれも）と apps/shared/ の env・logger・now だけで、next・react も参照しない
    * apps/backend/shared/ が参照してよい自前コードは apps/backend/shared/ の中と apps/shared/ だけで、next・react も参照しない
    * apps/frontend_customer/app/（app/api 以外）が features/・apps/backend/・shared/ を参照するときは features/<f>（index）か shared/ だけ
    * apps/frontend_customer/app/api/ は apps/backend/features/<f>/internal/presentation/<名前>.api（と apps/backend/shared/http/<名前>.api）だけを参照する
    * apps/shared/ の中は apps/shared/ の自前コードと Node の組み込み（node:）と zod だけを参照する（backend・frontend、next・react、DB、ほかのパッケージを参照しない）
    * <名前>.messages（画面・部品の辞書）を参照してよいのは同じディレクトリのファイルだけ（apps/frontend_customer/shared/i18n/common.messages は apps/frontend_customer/ のどこからでも可）。re-export（export ... from）はどこからでも不可
    * apps/backend/features/<a>/ の下のファイルは、他のモジュール（apps/backend/features/<b>/、b ≠ a）の internal/ を参照しない（型だけ・re-export も）
    * 他のモジュールの apps/backend/features/<b>/expose/ を参照してよいのは、apps/backend/features/<a>/internal/presentation/ の下のファイルだけ（application・domain・infra・expose からは不可）
    * apps/backend/features/<f>/expose/ が参照してよい自前コードは、自モジュールの internal/・expose/、apps/backend/shared/、apps/shared/ の env・logger・now だけで（他のモジュールは不可）、next・react も参照しない
    * モジュールの境界の規則は、本物の expose（notification の notifier.ts）の参照と、それを使う todo の presentation の参照を取り出せている（列挙が壊れて素通りするのを防ぐ）
    * process.env を直接読んでよいのは apps/shared/env.ts だけ（例外は apps/frontend_customer/instrumentation.ts の NEXT_RUNTIME だけ。apps/frontend_customer・apps/backend・apps/shared・apps/e2e/ とルート直下の設定ファイルが対象。テストは除く）
    * console を直接書いてよいのは apps/shared/logger.ts だけ（apps/frontend_customer・apps/backend・apps/shared・apps/e2e/・scripts/ とルート直下の設定ファイルが対象。テストは除く）
    * 現在時刻（引数の無い new Date・Date.now・new の無い Date()）を読んでよいのは apps/shared/now.ts だけ（apps/frontend_customer・apps/backend・apps/shared が対象。テストとテストの補助は除く）
    * 現在時刻の読み取りの検査は、apps/frontend_customer・apps/backend・apps/shared のソースを対象にし、テスト・テストの補助・apps/e2e/・ルート直下は対象にしない（列挙が壊れて素通りするのを防ぐ）
    * 画面（apps/frontend_customer）に文言をハードコードしない: JSX のテキスト、利用者に見える属性（aria-label・placeholder・title・alt・label・aria-description）の文字列、日本語の文字列は違反（辞書 apps/frontend_customer/<階層>/<名前>.messages.ts の defineMessages(...) の引数の中とテストは除く）
    * apps/backend と apps/shared の非テストコードは日本語のリテラルを持たない（エラーは ErrorKey と params で表し、運用者向けの文言は英語。テストは除く。例外なし）
    * apps/backend の presentation と shared/http の api ファイル（<名前>.api.ts）のクラスの handle は ProblemResponse.wrap(...) の呼び出しで初期化する（try / catch の手書き・素の async・別の関数で包むのは違反。features/feature-flag の presentation の OFREP の api だけは OfrepResponse.wrap(...) も可。テストは除く）
    * handle を ProblemResponse.wrap で包む規則は、本物の api ファイル 8 本を対象にし、テストは対象にしない（列挙が壊れて素通りするのを防ぐ）
    * apps/backend の presentation と shared/http の api ファイル（<名前>.api.ts）のクラスの handle の中に try / catch を書かない（エラーの変換は ProblemResponse.wrap に任せる。try / finally は可。テストは除く）
    * ProblemResponse.from を書いてよいのは apps/backend/shared/http/problem.ts だけ（api は ProblemResponse.wrap 経由で使う。apps/backend の本番コードが対象で、テストは除く）
    * ProblemResponse.from の規則は、本物の api ファイル 8 本を対象にし、problem.ts とテストは対象にしない（列挙が壊れて素通りするのを防ぐ）
    * apps/backend と apps/shared の本番コードとテストの補助（apps/backend の test-support/・spec/ の support.ts、apps/e2e の <名前>.spec.<名前> 以外）と apps/frontend_customer の features/・shared/・test-support/ の React 以外のモジュール（<名前>.tsx・<名前>.jsx・<名前>.hook.<名前> 以外）はファイルの最上位に関数を置かない（テストと E2E の <名前>.spec.<名前>、frontend の app/ と直下のファイルは除く。function 宣言・関数を入れた変数・export default の関数は違反。クラスのメソッド・クラスフィールドのアロー関数・メソッドの中の関数は可）
    * 規則 class-based の対象のファイルでは、インスタンスのメンバー（コンストラクタ・static でないメソッド・フィールド・アクセサ）を持つクラスに static のメンバーを置かない（自分のクラスか Promise<自分のクラス> を返す static のファクトリは可。static だけのクラスは対象外）
    * 最上位に関数を置かない規則は、apps/backend の本番コード（層・expose・drizzle.config.ts）・apps/shared の本番コード・テストの補助（test-support/・spec/ の support.ts・apps/e2e/ の spec 以外）・frontend の React 以外のモジュール（features/・shared/ の .ts）を対象にし、テスト・E2E の .spec.ts・リポジトリ直下・frontend の .tsx・.hook.ts・app/・直下のファイルは対象にしない（列挙が壊れて素通りするのを防ぐ）
    * apps/backend/package.json の exports は、外（apps/frontend_customer・apps/e2e/・リポジトリ直下）が "@repo/backend/..." で参照するものをすべて含み、参照されないキーを持たず、各キーはそのパスの .ts を指す
    * apps/shared/package.json の exports は、外（apps/frontend_customer・apps/backend・apps/e2e/・リポジトリ直下）が "@repo/shared/..." で参照するものをすべて含み、参照されないキーを持たず、各キーはそのパスの .ts を指す
    * apps/backend の exports を 1 件以上読め、apps/frontend_customer の @repo/backend の参照を取り出せている（読み込みや列挙が壊れて素通りするのを防ぐ）
    * apps/shared の exports を読め、apps/frontend_customer 直下・apps/backend・apps/e2e/・リポジトリ直下の @repo/shared の参照を取り出せている（読み込みや列挙が壊れて素通りするのを防ぐ）
    * 環境変数の直参照の検査は、各ディレクトリとルート直下の設定ファイルを対象にし、テストは対象にしない（列挙が壊れて素通りするのを防ぐ）
    * console の直接の呼び出しの検査は、各ディレクトリ・scripts/・ルート直下の設定ファイルを対象にし、テストは対象にしない（列挙が壊れて素通りするのを防ぐ）
    * ハードコードの文言の検査は、apps/frontend_customer・apps/backend・apps/shared のソース（辞書 .messages.ts を含む）を対象にし、テスト・生成物は対象にしない（列挙が壊れて素通りするのを防ぐ）
    * logger.ts の中の console は拾えている（抽出が壊れて 0 件になり、規則が素通りするのを防ぐ）
    * env.ts の中の process.env は拾えている（抽出が壊れて 0 件になり、規則が素通りするのを防ぐ）
  Scenario: backend の置き場所の判定
    * 違反例（PLACEMENT_EXAMPLES.misplaced）はすべて置き場所の違反になる
    * 許可例（PLACEMENT_EXAMPLES.placed）はどれも置き場所の違反にならない
  Scenario: apps/shared の置き場所の判定
    * 違反例（SHARED_PLACEMENT_EXAMPLES.misplaced）はすべて置き場所の違反になる
    * 許可例（SHARED_PLACEMENT_EXAMPLES.placed）はどれも置き場所の違反にならない
  Scenario: frontend の置き場所の判定
    * 違反例（FRONTEND_PLACEMENT_EXAMPLES.misplaced）はすべて置き場所の違反になる
    * 許可例（FRONTEND_PLACEMENT_EXAMPLES.placed）はどれも置き場所の違反にならない
  Scenario: 環境変数の直参照の判定
    * 違反例・許可例はそれぞれ 4 件以上ある
    * 違反例（ENV_ACCESS_EXAMPLES.violating）はすべて違反になる
    * 許可例（ENV_ACCESS_EXAMPLES.allowed）はどれも違反にならない
  Scenario: 環境変数の直参照の抽出（findProcessEnvAccesses）
    * 参照ごとに、読んだ変数の名前を返す（.NAME / ?.NAME の形だけ。取れない形は undefined）
    * 参照ごとに、書かれた行番号を返す（コメントを消しても行はずれない）
    * 分割代入・別名・Reflect.get・node:process の default import 経由の参照は拾わない（見逃す方向の限界。Biome の noProcessEnv も検出しない）
    * node:process の名前付き import（env を取り出す形）は拾わない（見逃す方向の限界。Biome の noProcessEnv が検出する）
    * テンプレートリテラルの埋め込み式の中の参照は拾わない（見逃す方向の限界。Biome の noProcessEnv が検出する）
  Scenario: console を直接書く規則の判定
    * 違反例・許可例はそれぞれ 4 件以上ある
    * 違反例（CONSOLE_ACCESS_EXAMPLES.violating）はすべて違反になる
    * 許可例（CONSOLE_ACCESS_EXAMPLES.allowed）はどれも違反にならない
  Scenario: console の参照の抽出（findConsoleAccesses）
    * 参照ごとに、書かれた行番号を返す（コメントを消しても行はずれない）
    * node:console の import（名前付きの import と default import）は拾わない（見逃す方向の限界。Biome の noConsole も検出しない）
    * テンプレートリテラルの埋め込み式の中の console は拾わない（見逃す方向の限界。Biome の noConsole が検出する）
  Scenario: 現在時刻を読む規則の判定
    * 違反例・許可例はそれぞれ 4 件以上ある
    * 違反例（NOW_ACCESS_EXAMPLES.violating）はすべて違反になる
    * 許可例（NOW_ACCESS_EXAMPLES.allowed）はどれも違反にならない
  Scenario: 現在時刻の読み取りの抽出（findCurrentTimeAccesses）
    * 読み取りごとに、書かれた行番号を返す（1 行に 2 つあれば 2 件。コメントを消しても行はずれない）
    * 別名・分割代入・括弧で囲んだ Date・空のスプレッド・Reflect.construct は拾わない（見逃す方向の限界）
    * テンプレートリテラルの埋め込み式の中は拾わない（見逃す方向の限界）
    * Date という名前のメソッドの呼び出し（calendar.Date()）も new の無い Date() として数える（多く検出する方向の限界）
  Scenario: ハードコードの文言の判定（frontend-hardcoded-text）
    * 違反例・許可例はそれぞれ 4 件以上ある
    * 違反例（HARDCODED_TEXT_EXAMPLES の violating）はすべて違反になる
    * 許可例（HARDCODED_TEXT_EXAMPLES の allowed）はどれも違反にならない
  Scenario: ハードコードの文言の判定（server-hardcoded-text）
    * 違反例・許可例はそれぞれ 4 件以上ある
    * 違反例（HARDCODED_TEXT_EXAMPLES の violating）はすべて違反になる
    * 許可例（HARDCODED_TEXT_EXAMPLES の allowed）はどれも違反にならない
  Scenario: ハードコードの文言の抽出（findHardcodedTexts）
    * 文言ごとに、書かれた行番号を返す（JSX のテキストは最初の文字の行。属性と日本語の両方に当たる値は 1 件）
    * ASCII の文字列を変数に入れてから JSX に渡す・JSX の子に式で書く・一覧に無い props・三項演算子の中は拾わない（見逃す方向の限界。日本語なら拾う）
    * 辞書（.messages.ts）では defineMessages(...) の引数の中だけを通し、引数の外の文言は行番号で返す
    * 構文解析の結果に無いファイルを渡すと例外にする（黙って飛ばして素通りさせない）
  Scenario: handle を ProblemResponse.wrap で包む規則の判定（presentation-with-problem-response）
    * 違反例（PROBLEM_RESPONSE_EXAMPLES.violating）はすべて違反になる
    * 許可例（PROBLEM_RESPONSE_EXAMPLES.allowed）はどれも違反にならない
  Scenario: ProblemResponse.wrap で包んでいない handle の抽出（findUnwrappedHandles）
    * 包んでいない handle ごとに、メンバーの書き出しの行番号を返す（包んだ handle・ほかの名前のメンバーは返さない）
  Scenario: handle の中に try / catch を書かない規則の判定（handle-without-try-catch）
    * 違反例（HANDLE_TRY_CATCH_EXAMPLES.violating）はすべて違反になる
    * 許可例（HANDLE_TRY_CATCH_EXAMPLES.allowed）はどれも違反にならない
  Scenario: ProblemResponse.from を problem.ts だけに書く規則の判定（problem-response-from-only-in-problem）
    * 違反例（PROBLEM_RESPONSE_FROM_EXAMPLES.violating）はすべて違反になる
    * 許可例（PROBLEM_RESPONSE_FROM_EXAMPLES.allowed）はどれも違反にならない
  Scenario: backend と apps/shared の本番コードとテストの補助、frontend の React 以外のモジュールの最上位に関数を置かない規則の判定（class-based）
    * 違反例（CLASS_BASED_EXAMPLES.violating）はすべて違反になる
    * 許可例（CLASS_BASED_EXAMPLES.allowed）はどれも違反にならない
  Scenario: インスタンスで使うクラスに static を置かない規則の判定（no-static-in-instance-class）
    * 違反例（NO_STATIC_IN_INSTANCE_CLASS_EXAMPLES.violating）はすべて違反になる
    * 許可例（NO_STATIC_IN_INSTANCE_CLASS_EXAMPLES.allowed）はどれも違反にならない
  Scenario: 最上位の関数の抽出（findTopLevelFunctions）
    * 最上位の関数ごとに宣言の書き出しの行番号を返す（オーバーロードは宣言ごと、1 つの文の変数は関数のものだけ、クラスの中は返さない）
  Scenario: 規則ごとの判定
    * RULES のすべての規則に判定の例があり、RULES に無い規則の例は無い
    * どの規則も違反例・許可例がそれぞれ 3 件以上ある
  Scenario: 規則ごとの判定（frontend-to-backend-specifier）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（frontend-to-shared-specifier）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（backend-to-frontend）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（backend-relative-only）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（frontend-root-to-backend）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（screen-to-backend）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（screen-to-shared）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（feature-api-to-backend）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（feature-to-feature）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（screen-to-app）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（shared-to-features）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（domain）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（core-to-persistence）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（application）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（presentation）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（infra）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（backend-shared）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（app）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（shared-self-contained）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（messages-colocation）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（module-internal）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（module-expose-only-from-presentation）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（expose-imports）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: 規則ごとの判定（app-api）
    * 違反例（RULE_EXAMPLES の violating）はすべて違反になる
    * 許可例（RULE_EXAMPLES の allowed）はどれも違反にならない
  Scenario: exports のキーの照合（resolveExportKey）
    * 当たる例・当たらない例はそれぞれ 3 件以上ある
    * 当たる例（EXPORT_KEY_EXAMPLES.resolved）は、それぞれ例に書いたキーに当たる
    * 当たらない例（EXPORT_KEY_EXAMPLES.unresolved）はどのキーにも当たらない
  Scenario: exports の違反の検出（findExportsViolations）
    * すべての参照がキーに当たり、すべてのキーが使われ、値がキーのパスの .ts でファイルがあれば、違反は 0 件
    * キーに当たらない参照、使われないキー、キーと違う値、ファイルの無いキーを、それぞれ検出する
    * キーが "./" で始まらないものは、値の形の違反にする
  Scenario: apps/shared の exports の違反の検出（findExportsViolations と SHARED_EXPORTS。Issue #90）
    * frontend 直下・backend・apps/e2e/・リポジトリ直下の参照がすべてキーに当たり、すべてのキーが使われていれば、違反は 0 件
    * キーに当たらない参照（backend からのものも）、使われないキー、キーと違う値、ファイルの無いキーを検出し、apps/shared/package.json の名前で出す
  Scenario: ファイルの列挙（walkFiles・listSourceFiles・listAllFiles）
    * 除外するディレクトリ（node_modules・.next）は、どの階層でも読まない（中に入ってから除くのではない）
    * 除外するディレクトリの中に循環する symlink（.next/standalone/node_modules/x -> ../..）があっても、中に入らずに完走する
    * listSourceFiles・listAllFiles は、除外するディレクトリの中に自分を指す symlink があっても、その外のファイルだけを返す
    * 除外しないディレクトリの symlink は、先のディレクトリの中も列挙し、ファイルへの symlink もファイルとして返す
    * 除外の外に置いた循環する symlink（apps/backend/loop -> ..）は、ELOOP の例外で止まる（無限に回らない）
    * ディレクトリが無ければ空を返す
  Scenario: fixture のツリーを検査したときに検出される違反
    * must-reject: 置いた違反がすべて、置いたとおりの規則で検出され、それ以外は検出されない
    * must-pass: 許可される参照だけのツリーでは違反が 0 件
  Scenario: 参照の抽出（extractImports）
    * 複数行にまたがる import を 1 つの参照として取り出す
    * import type / export type は型だけの参照、名前を並べた export ... from は値の参照になる。export ... from は re-export の印を持つ
    * inline の type は、すべての名前に付いているときだけ型だけの参照になる
    * 名前がすべて UPPER_SNAKE_CASE の定数の import だけが、定数だけの印を持つ
    * 副作用だけの import と dynamic import を値の参照として取り出す
    * コメントの中の import は拾わず、文字列の中の // でその後ろを消さない
    * セミコロンの無い文の直後の import type を、前の文とつなげずに型だけの参照として取り出す
    * 文字列リテラル（テンプレートリテラルを含む）の中の import 風の文字列は拾わない
    * 埋め込み式（ドル記号と波かっこ）を含むテンプレートリテラルの import() は、参照先を静的に決められないので拾わない（見逃す方向の限界）
    * from を持たない export 文から、後ろの文の from まで一致を伸ばさない
  Scenario: 参照先の正規化（toReference）
    * "@/" は apps/frontend_customer からのパスにする（tsconfig の paths で "@/" の下は apps/frontend_customer の下）
    * "@repo/backend/" と "@repo/backend" は apps/backend からのパスにする
    * "@repo/shared/" と "@repo/shared" は apps/shared からのパスにし、"@repo/shared-extra/x" は自前のコードにしない（Issue #90）
    * "@/" と "@repo/backend/" の後ろの ".." は解決する（"@/../backend/x" は apps/backend/x）
    * 名前の前方一致だけが同じ別パッケージ（"@repo/backend-extra/x"）は自前のコードにしない
    * 相対パスは参照元の位置から解決し、拡張子を外す
    * それ以外はパッケージとして specifier のまま扱う

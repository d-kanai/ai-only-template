# API ジャーニーテスト（Issue #187 / #200）の置き場所と形を検査するルール検査テストの仕様（Issue #282）。step の実装は対の api-journey.test.ts。
# 規則の WHY と限界は api-journey.test.ts の冒頭。
Feature: API ジャーニーテスト
  Scenario: API ジャーニーの置き場所（isMisplacedApiJourneyFile）
    * spec/journey/ の直下の API ジャーニーと .feature、層の下のテストとソース、名前の一部だけが同じファイル、spec/api/ の下の .feature は違反なし
    * spec/journey/ の名前の違うテスト・テスト以外・サブディレクトリの中、spec/journey/ の外のジャーニーと .feature、spec/api/ の下の API ジャーニーは違反
  Scenario: API ジャーニーの中身（findApiJourneyViolations）: must pass
    * 実 DB と 2 つ以上の api を値で import し、InMemory と vi を使わない API ジャーニーは違反なし（複数行・type の混じった import・別の feature の api・Postgres の Repository・コメントの中・vi 以外の vitest の import など）
    * API ジャーニーでないファイル（層の下のテスト）は中身を見ない
  Scenario: API ジャーニーの中身（findApiJourneyViolations）: must reject
    * InMemory の import・vi の import・実 DB や 2 つ以上の api の欠け・変更系の API の後に DB を読まないことは、規則と行で違反になる
    * 置き場所が違えば置き場所の違反だけを返す（中身は見ない）
  Scenario: Gherkin の .feature と step の対（findFeaturePairViolations）
    * .feature と同じ名前の step があるもの・対象外のファイルは違反なし
    * .feature か step の片方だけ・名前の違い・旧名の step・サブディレクトリの対は違反
  Scenario: .feature の業務の言葉と仕切り（findApiJourneyViolations）: must pass
    * 業務の言葉だけで、API を呼ぶ step の直前ごとに仕切りのある .feature は違反なし（コメント行と空行・語の一部・仕切りの後の空行とコメントなど）
    * spec/journey/ の外の .feature は置き場所の違反だけを返す（中身は見ない）
  Scenario: .feature の業務の言葉（api-journey-business-language）: must reject
    * step（Then）に DB・SQL・表名・API や HTTP の言葉（返り値・状態コード・Problem Details・JSON など）があれば違反
    * 見出し（Feature / Background / Scenario / Rule / Scenario Outline / Example）と各 step（Given / When / And / But / 星印）・説明の行・表の行も見る（1 行 1 件、行番号付き）
    * 仕切りの見出しに禁止語があれば、仕切りの行を違反にする
    * 禁止語と仕切りの違反が同じ When の行にあれば、両方を行の順に返す
  Scenario: .feature の仕切り（api-journey-section-divider）: must reject
    * When の直前の行が仕切りの形でなければ違反（仕切りが無い・普通のコメント・罫線の数・見出しの空・空白の数・罫線の文字・後ろの文字・別のコメントの書き方）
    * 仕切りと When の間に空行・コメント行がある、シナリオの見出しの直後の When、Background の後・2 つ目のシナリオ・Rule の中の When も見る
  Scenario: タグ・skip・行の区切り（api-journey-tag / api-journey-no-skip。Issue #219 の reviewer の指摘）
    * 行の途中の @・単独の CR の改行・コメントや文字列の中の skip と only・名前の一部は違反なし
    * .feature のタグの行と、step の skip・only・skipIf・runIf は、規則と行で違反になる（単独の CR で区切った行も 1 行ずつ見る）
  Scenario: API ジャーニーの列挙と検査（fixture）
    * spec/journey/ の下と、外に置くと違反になる名前（.api-journey.test.・.journey.test. を含む名前と .feature）を対象にし、違反を「規則: パス(:行)」で返す
    * apps/ が無ければ対象は 0 件（本番の検査は 0 件を失敗にする）
  Scenario: API ジャーニー（実ファイル）
    * apps/backend/spec/journey/ には対になった .feature と .api-journey.test.ts だけがあり、.feature は業務の言葉だけで API を呼ぶ step の前に仕切りがあり、各 API ジャーニーは InMemory と vi を使わず、実 DB と 2 つ以上の API を使い、変更系の API の後に DB を読む

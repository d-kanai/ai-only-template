# API ジャーニーの実行で全 API が 1 回は呼ばれることを API 網羅率として測り、100% を CI のゲートにする

- 日付: 2026-10-02
- 状態: 採用
- 関連: Issue #281 / `.claude/rules/testing.md`（「API 網羅率」） / `apps/backend/test-support/api-coverage.ts` / `apps/backend/test-support/api-coverage-reporter.ts` / quality/20260930-backend-journey-tests.md

## 背景
API ジャーニー（`apps/backend/spec/journey/`）は業務の流れに沿って複数の API を呼ぶが、どの API が流れに現れているかは測っていなかった。daiki が「API は必ずどこかのジャーニーにあるはず」という観点で、実行で全 API が 1 回は呼ばれていることを API 網羅率として取り、100% を CI のゲートにするよう求めた（2026-10-02）。

## 決定
- 全 API = `apps/frontend_customer/app/api/**/route.ts` が re-export する HTTP メソッド（`GET /api/todos` など）。re-export の参照先の api ファイルの `export const <METHOD> = new <クラス名>(` で Api のクラス名に結ぶ。読めない形（re-export 以外のコード・HTTP メソッドでない名前・`@repo/backend/` の外・クラス名が読めない）は例外にする。
- 記録: ジャーニーは各 Api を `ApiCoverage.track(new XxxApi(...))` で包む。handler を呼ぶと、呼んだテスト（step）の `meta.apiCalls` に Api のクラス名が残る。
- 判定: Vitest の reporter（`vitest.config.mts` の `reporters` に足す）が実行の終わりに、ジャーニーのテストの meta を集め、全 API のうち呼ばれた数を出す。すべてのジャーニーを含む実行で 100% 未満なら終了コードを 1 にする（`pnpm test` = CI の ci ジョブが失敗する）。一部のジャーニーだけ・`-t` で絞った実行では判定しない。ジャーニーが 1 つも無ければ失敗にする。
- 数えるのはジャーニーの中の呼び出しだけ（単体テスト・API 仕様の呼び出しは数えない）。

## 理由
- 分母を route.ts から取ると、利用者から呼べる API だけを数えられる（ルーティングにつながっていない Api を分母に入れない）。クラス名で結ぶと、ジャーニーが本番と同じクラスを db だけ変えて組み立てる形のまま、記録と一覧を突き合わせられる（handler の変数名や要求のパスはジャーニーが自由に書け、本番と結べない）。
- テストの meta は Vitest がテストの結果と一緒に本体のプロセスへ送り、reporter が読める（Vitest 5.0.1 で実測）。ファイルや環境変数を介さないので、後始末も `process.env` の例外（`.claude/rules/env.md`）も要らない。
- reporter は全テストの後に 1 回呼ばれ、どのファイルが実行されたかを知っているので、一部の実行を判定から外せる。終了コードは `process.exitCode = 1` で、全テストが通った実行でも 1 になることを実測した。

## 採用しなかった案
- V8 のカバレッジ（`*.api.ts` の関数の 100%）で代える: 単体テストの実行と混ざり、ジャーニーだけの実行に絞ると別の設定が要る。関数の網羅は「API が呼ばれた」と一致しない（失敗の分岐の補助など）。
- globalSetup の teardown で判定する: 実行されたファイルが分からず、一部の実行でも落ちる。teardown の例外は「error during close」になり、何が足りないかが読みにくい。
- ファイルに呼び出しを書き出して後で集計する: worker の数だけファイルができ、置き場所を `process.env` で渡すか固定のパスにする必要がある。
- `*.api.ts` を分母にする: ルーティングにつながっていない Api も数える。

## 影響
- 良い点: API を足したら、それを使う業務の流れをジャーニーに書かないと CI が落ちる。網羅率と呼ばれていない API（✗）が `pnpm test` の最後に出る。
- 悪い点: 呼んだかだけを見て、流れの中で意味のある使い方か（応答や DB を確かめているか）は見ない（`rule-tests/api-journey.test.ts` と reviewer が見る）。ジャーニーが `ApiCoverage.track` で包まずに呼んだ API は数えない（網羅率が下がって落ちる側に働く）。
- 見直す条件: ルートグループ・catch-all のルートや、re-export でない route.ts が要るようになったら、全 API の読み方を見直す。

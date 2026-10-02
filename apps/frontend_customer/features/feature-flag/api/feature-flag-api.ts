import { OFREPWebProvider } from "@openfeature/ofrep-web-provider";
import type { Provider } from "@openfeature/web-sdk";

// 画面が読んでよいフラグの key（backend の一覧 FEATURE_FLAGS の key の集合。Issue #156）。hook（useFeatureFlag）の引数の型にし、
//   打ち間違いをコンパイルエラーにする。backend が一覧を変えると、ここを直さずに型が変わる。
// WHY backend から import type で読む: 画面とサーバで同じ集合を使い、ずれを型チェックで検出する。import type はビルドで消えるので
//   サーバのコードがバンドルに入らない（.claude/rules/code/frontend.md の「依存の向き」。参照してよいのは api/ だけ）。
export type { FeatureFlagKey } from "@repo/backend/features/feature-flag/internal/presentation/evaluate-feature-flags.api";

// OFREP の web provider に渡す baseUrl のパス。provider は `${baseUrl}/ofrep/v1/evaluate/flags` に POST する
//   （@openfeature/ofrep-core 2.3.0 の OFREPApi.postBulkEvaluateFlags。2026-10-02 に node_modules の index.esm.js で確認）ので、
//   Route Handler の app/api/ofrep/v1/evaluate/flags/route.ts に届くよう "/api" にする。
// WHY 同じオリジン: 画面と API は同じ Next のサーバが返す（todo-api.ts の "/api/todos" と同じ）。オリジンを設定に持つと
//   環境（ローカル・E2E のポート・Cloud Run）ごとに値が要る。
const OFREP_BASE_PATH = "/api";

// フィーチャーフラグの評価を backend の OFREP の API から読む provider を作る。
// WHY 状態を持たない static のクラス: frontend の React 以外のモジュールはクラスのメソッドにする（規則 class-based）。テストは
//   vi.mock でこのクラスを差し替え、provider を InMemoryProvider にする（todo-api.ts の TodoApi と同じ）。
// WHY 呼ぶたびに作る（モジュールで 1 つを持たない）: provider は fetch・タイマー・localStorage を使うブラウザ側のものなので、
//   作るのはブラウザで provider を登録するとき（FeatureFlagProvider の useEffect）だけにし、サーバでの描画（SSR）では作らない。
// 設定を既定のままにするもの（@openfeature/ofrep-web-provider 0.4.3 の README）:
//   - pollInterval（既定 0 = 定期的な再取得なし）: フラグはデプロイでしか変わらない（ハードコード。ADR
//     docs/adr/architecture/20261002-feature-flag-ofrep-hardcoded.md）。画面が表示に戻ったときの再取得（既定で有効）だけで足りる。
//   - cacheMode（既定 local-cache-first）: 前回の評価が localStorage にあれば、初期化はネットワークを待たずにそれで終わり、
//     裏で取り直す（README の「Cache modes」）。2 回目以降の表示で既定値（off）で描く時間が短くなる。デプロイ直後は前の値で
//     描いてから取り直した値で描き直す（README の記述による。描き直しの実測は未確認）。
export class FeatureFlagApi {
  static createProvider(): Provider {
    // WHY 相対パスではなく今のページのオリジンを付ける: provider は fetch(new Request(url)) で送る。ブラウザは相対パスを
    //   ページの URL で解決するが、Node の Request（undici。Vitest の jsdom 環境の Request も同じ）は相対パスを
    //   「Failed to parse URL」で拒む（2026-10-02 にテストで確認）。作るのはブラウザ（useEffect の中）だけなので window を読める。
    return new OFREPWebProvider({
      baseUrl: `${window.location.origin}${OFREP_BASE_PATH}`,
    });
  }
}

import { DomainError } from "../../../../shared/error/domain-error";

// フィーチャーフラグの一覧と評価（Issue #156）。値は on / off（boolean）だけ。
// WHY 一覧をコードにハードコードする（DB・設定ファイル・環境変数にしない）: フラグの追加・切り替えをコードの変更と同じ PR で
//   レビューでき、環境ごとの値のずれも起きない。運用で切り替えたくなったら Repository を足して DB に移す（このファイルの
//   FeatureFlags はコンストラクタで一覧を受け取るので、評価の規則は変えずに済む）。決定と採らなかった案は ADR
//   docs/adr/architecture/20261002-feature-flag-ofrep-hardcoded.md。
// WHY satisfies Record<string, boolean>: boolean 以外の値（文字列・数値のフラグ）を型で止める（今は on / off だけ。ユーザー判断）。
//   as const で key をリテラルの型に残し、FeatureFlagKey で画面が使える key を型で縛れるようにする。
// WHY UPPER_SNAKE_CASE の定数: presentation の組み立て（api ファイルの最下部）が値で import する。presentation が domain から値で
//   import してよいのは UPPER_SNAKE_CASE の定数だけ（rule-tests/architecture.test.ts の presentation。Issue #144）。
export const FEATURE_FLAGS = {
  // Todo の詳細画面（一覧から詳細へのリンク）を出すか。
  "todo-detail-screen": true,
} as const satisfies Record<string, boolean>;

// 本番の一覧にある key。画面がフラグの key を打ち間違えたら型エラーにする。
export type FeatureFlagKey = keyof typeof FEATURE_FLAGS;

// 評価に使うフラグの一覧（key → on / off）。テストは自分の一覧を渡す。
export type FeatureFlagSet = Readonly<Record<string, boolean>>;

// 評価の文脈（OpenFeature の evaluation context）。誰に対する評価か（targetingKey）と、利用者・要求の属性。
// WHY 今は使わないのに受け取る: OpenFeature は属性ごとの出し分け（targeting）を仕様に持つ。評価の形を最初から
//   evaluate(key, context) にしておき、規則を足すときに呼び出し側を変えずに済ませる（Issue #156 のユーザー指示）。
// WHY 属性の値を unknown にする: OFREP の context は任意の JSON の値を持てる（service/openapi.yaml の context は
//   additionalProperties: true）。使うときに属性ごとに形を確かめる。
// 注意: クライアントが送る context は偽れる。ログインが入って属性で出し分けるときは、属性を backend が認証情報から決める（Issue #156）。
export type EvaluationContext = {
  readonly targetingKey?: string;
  readonly [attribute: string]: unknown;
};

// 1 つのフラグを評価した結果。
export type FeatureFlagEvaluation = {
  readonly key: string;
  readonly value: boolean;
};

// フラグの一覧を持ち、key ごとに評価する。
export class FeatureFlags {
  constructor(private readonly flags: FeatureFlagSet) {}

  // key のフラグを評価する。一覧に無い key は DomainError(not_found)（API では OFREP の FLAG_NOT_FOUND の 404）。
  // WHY _context を受け取って使わない: 上の EvaluationContext の WHY（形だけを先に決める）。
  // WHY Object.hasOwn で引く（in や flags[key] にしない）: 一覧は素のオブジェクトなので、toString・constructor などの継承した
  //   プロパティが「ある」ことになり、関数が value として返ってしまう。
  evaluate(key: string, _context: EvaluationContext): FeatureFlagEvaluation {
    if (!Object.hasOwn(this.flags, key)) {
      throw new DomainError("not_found", "featureFlag.notFound", { key });
    }
    return { key, value: this.flags[key] };
  }

  // 一覧のすべてのフラグを、一覧の順に評価する（OFREP の一括評価）。
  // WHY evaluate を通す: 1 件の評価と一括の評価で規則を 1 か所にし、属性ごとの出し分けを足したときに両方へ効かせる。
  evaluateAll(context: EvaluationContext): FeatureFlagEvaluation[] {
    return Object.keys(this.flags).map((key) => this.evaluate(key, context));
  }
}

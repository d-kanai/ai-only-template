// @vitest-environment node
import { describe, expect, test } from "vitest";
import { DomainError } from "../../../../shared/error/domain-error";
import { FEATURE_FLAGS, FeatureFlags } from "./feature-flags";

// フラグの評価（FeatureFlags）の単体テスト。一覧はテストごとに渡し、本番の一覧（FEATURE_FLAGS）の中身に依存しない。
// WHY 本番の一覧に依存しない: フラグを足す・消すたびにこのテストを直すことになり、評価の規則の仕様と一覧の中身が混ざる。
//   本番の一覧の形（boolean だけ）は FEATURE_FLAGS の satisfies が型で、値は下の 1 件のテストが確かめる。

// action が投げた値を返す（投げなければ undefined）。
// WHY toThrow を使わない: 例外の code・key・params を丸ごと確かめるため、投げた値そのものを取り出して比べる。投げなければ
//   undefined になり、toBeInstanceOf で落ちる。
function thrownBy(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("FeatureFlags.evaluate", () => {
  test("一覧にある key なら、その key と値を返す（on と off のどちらも）", () => {
    // given
    const flags = new FeatureFlags({ "flag-on": true, "flag-off": false });

    // when
    const on = flags.evaluate("flag-on", {});
    const off = flags.evaluate("flag-off", {});

    // then
    expect(on).toStrictEqual({ key: "flag-on", value: true });
    expect(off).toStrictEqual({ key: "flag-off", value: false });
  });

  // WHY 属性を渡しても値が変わらないことを確かめる: 今は属性ごとの出し分けをしない（Issue #156。規則の評価は後で足す）。
  //   受け取った context で値を変える実装を入れたら、この仕様を変える。
  test("評価の文脈（targetingKey と属性）を渡しても、値は一覧のまま", () => {
    // given
    const flags = new FeatureFlags({ "flag-off": false });

    // when
    const evaluation = flags.evaluate("flag-off", {
      targetingKey: "user-123",
      plan: "premium",
    });

    // then
    expect(evaluation).toStrictEqual({ key: "flag-off", value: false });
  });

  test("一覧に無い key なら、その key を params に持つ DomainError(not_found, featureFlag.notFound) を投げる", () => {
    // given
    const flags = new FeatureFlags({ "flag-on": true });

    // when
    const action = () => flags.evaluate("missing", {});

    // then
    const error = thrownBy(action);
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({
      code: "not_found",
      key: "featureFlag.notFound",
      params: { key: "missing" },
    });
  });

  // WHY Object の prototype の名前を確かめる: 一覧は素のオブジェクトなので、in や flags[key] で引くと toString などの
  //   継承したプロパティが「ある」ことになり、関数が値として返る（OFREP の value が boolean でなくなる）。
  test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "Object から継承した名前 %s も一覧に無い key として not_found にする",
    (key) => {
      // given
      const flags = new FeatureFlags({ "flag-on": true });

      // when
      const action = () => flags.evaluate(key, {});

      // then
      const error = thrownBy(action);
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({
        code: "not_found",
        key: "featureFlag.notFound",
        params: { key },
      });
    },
  );
});

describe("FeatureFlags.evaluateAll", () => {
  test("一覧のすべての key を、一覧の順に評価して返す", () => {
    // given
    const flags = new FeatureFlags({ b: false, a: true, c: true });

    // when
    const evaluations = flags.evaluateAll({ targetingKey: "user-123" });

    // then
    expect(evaluations).toStrictEqual([
      { key: "b", value: false },
      { key: "a", value: true },
      { key: "c", value: true },
    ]);
  });

  test("一覧が空なら空の配列を返す", () => {
    // given
    const flags = new FeatureFlags({});

    // when
    const evaluations = flags.evaluateAll({});

    // then
    expect(evaluations).toStrictEqual([]);
  });
});

describe("FEATURE_FLAGS", () => {
  // WHY 本番の一覧の中身を 1 か所で固定する: 一覧を変えるとここが落ち、フラグの追加・削除・値の変更がレビューで見える
  //   （画面の出し分けが変わる。E2E は todo-detail-screen が on の前提で書いてある）。
  test("本番の一覧は todo-detail-screen が on の 1 件", () => {
    // given: 本番の一覧
    // when
    const flags = { ...FEATURE_FLAGS };

    // then
    expect(flags).toStrictEqual({ "todo-detail-screen": true });
  });
});

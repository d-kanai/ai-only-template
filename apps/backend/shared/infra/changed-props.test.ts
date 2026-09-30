// @vitest-environment node
import { describe, expect, test } from "vitest";
import { changedProps } from "./changed-props";

type Props = {
  id: string;
  title: string;
  completed: boolean;
  createdAt: Date;
  count: number;
};

const ORIGIN: Props = {
  id: "8d0f4f39-6f0b-4a39-9d53-0a3f8b1c2d4e",
  title: "牛乳を買う",
  completed: false,
  createdAt: new Date("2026-09-30T00:00:00.000Z"),
  count: 1,
};

describe("changedProps", () => {
  test("origin と違う key だけを、今の値で返す（同じ key は含めない）", () => {
    const current = { ...ORIGIN, title: "卵を買う" };

    expect(changedProps(ORIGIN, current)).toStrictEqual({ title: "卵を買う" });
  });

  test("複数の key が変わっていれば、変わった key をすべて返す", () => {
    const current = { ...ORIGIN, title: "卵を買う", completed: true };

    expect(changedProps(ORIGIN, current)).toStrictEqual({
      title: "卵を買う",
      completed: true,
    });
  });

  test("何も変わっていなければ空のオブジェクトを返す", () => {
    expect(changedProps(ORIGIN, { ...ORIGIN })).toStrictEqual({});
  });

  test("current に無い項目は、origin にあっても比べない（返さない）", () => {
    expect(changedProps(ORIGIN, { completed: ORIGIN.completed })).toStrictEqual(
      {},
    );
  });

  test("current に持たせた項目だけを比べる（origin の一部でよい）", () => {
    expect(changedProps(ORIGIN, { completed: true })).toStrictEqual({
      completed: true,
    });
  });

  // WHY: Object.is は同じ時刻でも別のインスタンスの Date を別と見る。DB から読み直した Date は毎回別のインスタンス。
  test("Date は同じ時刻なら別のインスタンスでも変わっていないとみなす", () => {
    const current = {
      ...ORIGIN,
      createdAt: new Date(ORIGIN.createdAt.getTime()),
    };

    expect(changedProps(ORIGIN, current)).toStrictEqual({});
  });

  test("Date は違う時刻なら変わったとみなし、今の Date を返す", () => {
    const createdAt = new Date("2026-09-30T00:00:00.001Z");

    expect(changedProps(ORIGIN, { ...ORIGIN, createdAt })).toStrictEqual({
      createdAt,
    });
  });

  // 片方だけが Date のときは Date どうしの比較ではない（Object.is で比べる）。型を偽ったときだけ起きる。
  test("片方だけが Date なら（getTime が同じ数でも）変わったとみなす", () => {
    const origin = { value: new Date(0) as Date | number };

    expect(changedProps(origin, { value: 0 })).toStrictEqual({
      value: 0,
    });
    expect(
      changedProps({ value: 0 as Date | number }, { value: new Date(0) }),
    ).toStrictEqual({ value: new Date(0) });
  });

  // Object.is の仕様どおり: NaN は NaN と同じ、0 と -0 は別（=== とは逆）。
  test("NaN から NaN は変わっていない（Object.is で比べる）", () => {
    expect(
      changedProps({ ...ORIGIN, count: Number.NaN }, { count: Number.NaN }),
    ).toStrictEqual({});
  });

  test("0 から -0 は変わったとみなす（Object.is で比べる）", () => {
    expect(changedProps({ ...ORIGIN, count: 0 }, { count: -0 })).toStrictEqual({
      count: -0,
    });
  });

  test("current が空なら空のオブジェクトを返す", () => {
    expect(changedProps(ORIGIN, {})).toStrictEqual({});
  });
});

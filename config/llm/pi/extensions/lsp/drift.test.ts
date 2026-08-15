import { describe, expect, test } from "bun:test";
import { collapseRanges } from "./drift";

describe("collapseRanges", () => {
  test("empty", () => {
    expect(collapseRanges([])).toBe("");
  });

  test("single line", () => {
    expect(collapseRanges([7])).toBe("7");
  });

  test("consecutive lines collapse to a range", () => {
    expect(collapseRanges([2, 3, 4])).toBe("2-4");
  });

  test("mixed ranges and singles", () => {
    expect(collapseRanges([2, 3, 4, 7, 12, 13])).toBe("2-4, 7, 12-13");
  });

  test("full-document reformat stays one range", () => {
    expect(collapseRanges([1, 2, 3, 4, 5])).toBe("1-5");
  });

  test("order-independent", () => {
    expect(collapseRanges([13, 12, 7, 4, 3, 2])).toBe("2-4, 7, 12-13");
  });

  test("duplicates collapse into their range", () => {
    expect(collapseRanges([2, 2, 3, 3, 5])).toBe("2-3, 5");
  });
});

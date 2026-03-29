import { describe, expect, test } from "bun:test";
import { ScrollableText } from "./scrollable-text";

const theme = {
  scrollHint: (t: string) => `[hint:${t}]`,
  border: (t: string) => `[border:${t}]`,
};

describe("ScrollableText", () => {
  test("renders all lines when they fit", () => {
    const lines = ["line 1", "line 2", "line 3"];
    const s = new ScrollableText(lines, 5, theme);
    const output = s.render(80);
    expect(output).toEqual(["line 1", "line 2", "line 3"]);
  });

  test("truncates and shows scroll hint when lines overflow", () => {
    const lines = ["a", "b", "c", "d", "e", "f", "g"];
    const s = new ScrollableText(lines, 4, theme);
    const output = s.render(80);
    // 3 visible lines + 1 hint line = 4
    expect(output.length).toBe(4);
    expect(output[0]).toBe("a");
    expect(output[2]).toBe("c");
    expect(output[3]).toContain("4 below");
  });

  test("scrolls down on down key", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const s = new ScrollableText(lines, 3, theme);

    // Initial: a, b visible + hint
    expect(s.render(80)[0]).toBe("a");

    // Scroll down
    const consumed = s.handleInput("\x1b[B"); // down arrow
    expect(consumed).toBe(true);
    const output = s.render(80);
    expect(output[0]).toBe("b");
  });

  test("does not consume input when not scrollable", () => {
    const lines = ["a", "b"];
    const s = new ScrollableText(lines, 5, theme);
    expect(s.scrollable).toBe(false);
    expect(s.handleInput("\x1b[B")).toBe(false);
  });

  test("scrollable property reflects overflow", () => {
    const lines = ["a", "b", "c"];
    const s = new ScrollableText(lines, 2, theme);
    expect(s.scrollable).toBe(true);
  });

  test("setLines resets scroll offset", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const s = new ScrollableText(lines, 3, theme);
    s.handleInput("\x1b[B"); // scroll down
    s.handleInput("\x1b[B");
    s.setLines(["x", "y", "z", "w"]);
    expect(s.render(80)[0]).toBe("x");
  });

  test("setMaxHeight changes viewport", () => {
    const lines = ["a", "b", "c", "d", "e"];
    const s = new ScrollableText(lines, 3, theme);
    expect(s.render(80).length).toBe(3); // 2 lines + hint

    s.setMaxHeight(5);
    expect(s.render(80).length).toBe(5); // all lines fit
    expect(s.scrollable).toBe(false);
  });
});

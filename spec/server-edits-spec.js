const path = require("path");
const { TextBuffer } = require("lumine");

describe("Ruff server edits", () => {
  let apply;
  beforeEach(async () => {
    await lumine.packages.activatePackage(path.resolve(__dirname, ".."));
    apply = require("../lib/server-edits");
  });
  const edit = (first, last, newText) => ({
    range: {
      start: { line: first[0], character: first[1] },
      end: { line: last[0], character: last[1] },
    },
    newText,
  });

  it("applies arbitrary single edits with scalar geometry and no native buffer", () => {
    const source = "#%% Header\r\nvalue='😀'\r\nnext=1\rlast=2\n";
    const constructed = spyOn(TextBuffer.prototype, "setHistoryProvider").and.callThrough();
    const changes = [
      edit([1, 7], [1, 9], "😁"),
      edit([2, 4], [2, 11], " = 3\rlast"),
      edit([0, 0], [0, 0], "prefix\n"),
      edit([3, 0], [3, 0], "tail"),
    ];
    for (const change of changes) {
      const reference = new TextBuffer({ text: source });
      try {
        reference.setTextInRange(
          [
            [change.range.start.line, change.range.start.character],
            [change.range.end.line, change.range.end.character],
          ],
          change.newText,
          { normalizeLineEndings: false },
        );
        const before = constructed.calls.count();
        expect(apply(source, [change])).toBe(reference.getText());
        expect(constructed.calls.count()).toBe(before);
      } finally {
        reference.destroy();
      }
    }
  });

  it("rejects malformed, reversed, out-of-bounds and CRLF columns", () => {
    const source = "a😀\r\nb\n";
    for (const change of [
      edit([-1, 0], [0, 0], "x"),
      edit([0, 0.5], [0, 1], "x"),
      edit([1, 0], [0, 1], "x"),
      edit([0, 3], [0, 2], "x"),
      edit([0, 4], [1, 0], "x"),
      edit([3, 0], [3, 0], "x"),
      edit([1, 2], [1, 2], "x"),
      edit([0, 0], [0, 1], null),
      { newText: "x" },
    ])
      expect(apply(source, [change])).toBeNull();
    expect(apply(source, [edit([0, 1], [0, 3], "😁")])).toBe("a😁\r\nb\n");
  });

  it("keeps the safe atomic fallback for multiple edits", () => {
    const source = "first=1\nlast=2\n";
    expect(apply(source, [edit([0, 5], [0, 5], " "), edit([1, 4], [1, 4], " ")])).toBe(
      "first =1\nlast =2\n",
    );
    expect(apply(source, [edit([0, 0], [0, 4], "x"), edit([0, 2], [0, 5], "y")])).toBeNull();
    expect(apply(source, [edit([0, 0], [0, 1], "x"), edit([99, 0], [99, 0], "y")])).toBeNull();
    expect(apply(source, null)).toBe(source);
    expect(apply(source, [])).toBe(source);
    expect(apply(source, {})).toBeNull();
  });
});

const { TextBuffer, Point, Range } = require("lumine");

function applyServerEdits(text, edits) {
  if (edits === null || edits === undefined) return text;
  if (!Array.isArray(edits)) return null;
  if (!edits.length) return text;
  if (edits.length === 1) {
    const edit = edits[0],
      { start, end } = edit?.range || {};
    if (
      typeof edit?.newText !== "string" ||
      ![start?.line, start?.character, end?.line, end?.character].every(
        (value) => Number.isInteger(value) && value >= 0,
      ) ||
      start.line > end.line ||
      (start.line === end.line && start.character > end.character)
    )
      return null;
    const endings = /\r?\n/g;
    let next = endings.exec(text),
      row = 0,
      lineStart = 0;
    const indexFor = (point) => {
      while (row < point.line) {
        if (!next) return null;
        row++;
        lineStart = next.index + next[0].length;
        next = endings.exec(text);
      }
      return point.character <= (next?.index ?? text.length) - lineStart
        ? lineStart + point.character
        : null;
    };
    const first = indexFor(start),
      last = indexFor(end);
    return first === null || last === null
      ? null
      : text.slice(0, first) + edit.newText + text.slice(last);
  }
  const buffer = new TextBuffer({ text });
  try {
    const parsed = [];
    for (const edit of edits) {
      const start = edit?.range?.start,
        end = edit?.range?.end;
      if (
        typeof edit?.newText !== "string" ||
        ![start?.line, start?.character, end?.line, end?.character].every(
          (value) => Number.isInteger(value) && value >= 0,
        )
      )
        return null;
      const first = new Point(start.line, start.character),
        last = new Point(end.line, end.character);
      if (first.compare(last) > 0) return null;
      const oldRange = new Range(first, last);
      if (!buffer.clipPosition(first).isEqual(first) || !buffer.clipPosition(last).isEqual(last))
        return null;
      if (parsed.some((previous) => previous.oldRange.intersectsWith(oldRange, true))) return null;
      parsed.push({ oldRange, newText: edit.newText });
    }
    for (const edit of parsed.sort((a, b) => b.oldRange.start.compare(a.oldRange.start))) {
      buffer.setTextInRange(edit.oldRange, edit.newText);
    }
    return buffer.getText();
  } finally {
    buffer.destroy();
  }
}

module.exports = applyServerEdits;

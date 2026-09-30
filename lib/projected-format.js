const path = require("path");
const { pathToFileURL } = require("url");
const { TextBuffer, Point, Range } = require("lumine");

const queues = new WeakMap();
let nextDocument = 0;

function diffEdits(before, after) {
  if (before === after) return [];
  const buffer = new TextBuffer({ text: before });
  try {
    const checkpoint = buffer.createCheckpoint();
    buffer.setTextViaDiff(after);
    return buffer.getChangesSinceCheckpoint(checkpoint).map(({ oldRange, newText }) => ({
      oldRange: Range.fromObject(oldRange),
      newText,
    }));
  } finally {
    buffer.destroy();
  }
}

function applyServerEdits(text, edits) {
  if (edits === null || edits === undefined) return text;
  if (!Array.isArray(edits)) return null;
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

async function formatBlocks(editor, projection, context) {
  const { session, signal, range, options } = context;
  if (!session?.withTemporaryDocument) return null;
  const selections = editor.getSelectedBufferRanges().map((selection) => selection.copy());
  const originalPath = editor.getPath();
  const current = () =>
    projection.isCurrent() &&
    !signal?.aborted &&
    !editor.isDestroyed() &&
    editor.getPath() === originalPath &&
    editor.getSelectedBufferRanges().length === selections.length &&
    editor
      .getSelectedBufferRanges()
      .every((selection, index) => selection.isEqual(selections[index]));
  const requested = range ? Range.fromObject(range).copy() : null;
  const edits = [];
  for (const block of projection.getFormattingBlocks()) {
    if (requested && !requested.intersectsWith(block.range)) continue;
    if (!current()) return null;
    const filePath = editor.getPath() || path.join(session.rootPath, `untitled-${editor.id}.ipy`);
    // A query gives the wire document its own identity while retaining the
    // real pathname used by Ruff's per-file configuration. Live server specs
    // verify that the real host document remains independent.
    const uri = pathToFileURL(filePath);
    uri.searchParams.set("lumine-ruff-format", String(++nextDocument));
    const formatted = await session.withTemporaryDocument(
      { uri: uri.href, languageId: "python", text: block.text },
      async (temporaryUri) => {
        const returned = await session.request(
          "textDocument/formatting",
          { textDocument: { uri: temporaryUri }, options },
          { signal },
        );
        return applyServerEdits(block.text, returned);
      },
      { signal },
    );
    if (!current() || formatted === null) return null;
    const restored = block.restore(formatted);
    if (restored === null) return null;
    const original = editor.getTextInBufferRange(block.range);
    for (const edit of diffEdits(original, restored)) {
      const toSource = (point) =>
        new Point(
          block.range.start.row + point.row,
          point.column + (point.row === 0 ? block.range.start.column : 0),
        );
      const oldRange = new Range(toSource(edit.oldRange.start), toSource(edit.oldRange.end));
      if (!block.range.containsRange(oldRange) || (requested && !requested.containsRange(oldRange)))
        return null;
      edits.push({ oldRange, newText: edit.newText });
    }
  }
  return current() ? edits : null;
}

module.exports = function formatProjectedDocument(editor, projection, context) {
  const previous = queues.get(context.session) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => formatBlocks(editor, projection, context));
  queues.set(context.session, pending);
  return pending.finally(() => {
    if (queues.get(context.session) === pending) queues.delete(context.session);
  });
};

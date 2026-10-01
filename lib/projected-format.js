const path = require("path");
const { pathToFileURL } = require("url");
const { TextBuffer, Point, Range } = require("lumine");

const queues = new WeakMap();
let nextDocument = 0;

function applyServerEdits(text, edits) {
  if (edits === null || edits === undefined) return text;
  if (!Array.isArray(edits)) return null;
  if (!edits.length) return text;
  if (edits.length === 1 && typeof edits[0]?.newText === "string") {
    const { start, end } = edits[0].range || {};
    if (start?.line === 0 && start?.character === 0) {
      let row = 0,
        lineStart = 0;
      const endings = /\r\n|\r|\n/g;
      while (endings.exec(text)) {
        row++;
        lineStart = endings.lastIndex;
      }
      if (end?.line === row && end?.character === text.length - lineStart) return edits[0].newText;
    }
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

async function formatBlocks(editor, projection, context) {
  const { session, signal, range, options } = context;
  if (!session?.withTemporaryDocument) return null;
  const selections = editor.getSelectedBufferRanges().map((selection) => selection.copy());
  const originalPath = editor.getPath();
  const current = () =>
    projection.isCurrent() &&
    (context.isInvocationCurrent?.() ?? true) &&
    !signal?.aborted &&
    !editor.isDestroyed() &&
    editor.getPath() === originalPath &&
    editor.getSelectedBufferRanges().length === selections.length &&
    editor
      .getSelectedBufferRanges()
      .every((selection, index) => selection.isEqual(selections[index]));
  const requested = range ? Range.fromObject(range).copy() : null;
  if (!current()) return null;
  const batch = await projection.getFormattingBatch(requested);
  if (!current()) return null;
  if (!batch) return [];
  const filePath = editor.getPath() || path.join(session.rootPath, `untitled-${editor.id}.ipy`);
  // A query gives the wire document its own identity while retaining the
  // real pathname used by Ruff's per-file configuration. Live server specs
  // verify that the real host document remains independent.
  const uri = pathToFileURL(filePath);
  uri.searchParams.set("lumine-ruff-format", String(++nextDocument));
  const formatted = await session.withTemporaryDocument(
    { uri: uri.href, languageId: "python", text: batch.text },
    async (temporaryUri) => {
      const returned = await session.request(
        "textDocument/formatting",
        { textDocument: { uri: temporaryUri }, options },
        { signal },
      );
      return applyServerEdits(batch.text, returned);
    },
    { signal },
  );
  if (!current() || formatted === null) return null;
  const plan = await batch.getEditPlan(formatted);
  return plan && current() ? plan.edits : null;
}

module.exports = function formatProjectedDocument(editor, projection, context) {
  const previous = queues.get(context.session) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => formatBlocks(editor, projection, context));
  queues.set(context.session, pending);
  return pending.finally(() => {
    if (queues.get(context.session) === pending) queues.delete(context.session);
  });
};

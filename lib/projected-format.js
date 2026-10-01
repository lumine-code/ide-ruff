const path = require("path");
const { pathToFileURL } = require("url");
const { Range } = require("lumine");
const applyServerEdits = require("./server-edits");

const queues = new WeakMap();
let nextDocument = 0;

async function formatBlocks(editor, projection, context) {
  const { session, signal, range, options } = context;
  if (!session?.request) return null;
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
  let formatted;
  if (
    !requested &&
    ["file", "save"].includes(context.method) &&
    context.uri &&
    projection.isIdentity &&
    projection.text === projection.source &&
    batch.text === projection.text
  ) {
    const returned = await session.request(
      "textDocument/formatting",
      { textDocument: { uri: context.uri }, options },
      { signal },
    );
    formatted = applyServerEdits(batch.text, returned);
  } else {
    if (!session.withTemporaryDocument) return null;
    const filePath = editor.getPath() || path.join(session.rootPath, `untitled-${editor.id}.ipy`);
    // A query gives the wire document its own identity while retaining the
    // real pathname used by Ruff's per-file configuration. Live server specs
    // verify that the real host document remains independent.
    const uri = pathToFileURL(filePath);
    uri.searchParams.set("lumine-ruff-format", String(++nextDocument));
    formatted = await session.withTemporaryDocument(
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
  }
  if (!current() || formatted === null) return null;
  const plan = await batch.getEditPlan(
    formatted,
    selections.flatMap((selection) => [selection.start, selection.end]),
  );
  if (!plan || !current()) return null;
  if (plan.replaceWholeDocument && ["file", "save"].includes(context.method))
    return { text: plan.text, edits: plan.edits, isCurrent: current };
  return plan.edits;
}

module.exports = function formatProjectedDocument(editor, projection, context) {
  const previous = queues.get(context.session) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => formatBlocks(editor, projection, context));
  queues.set(context.session, pending);
  return pending.finally(() => {
    if (queues.get(context.session) === pending) queues.delete(context.session);
  });
};

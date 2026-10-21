const HIDDEN_NOQA = "\uE000\uE001\uE002\uE003";
const HIDDEN_NOQA_UPPER = "\uE004\uE005\uE006\uE007";
const NOQA_DIRECTIVE = /(#\s*(?:(?:ruff|flake8)\s*:\s*)?)(noqa)\b/gi;

function* directives(text) {
  const breaks = /\r\n|\n|\r/g;
  let row = 0,
    lineStart = 0,
    next = breaks.exec(text);
  for (const match of text.matchAll(NOQA_DIRECTIVE)) {
    while (next && next.index < match.index) {
      row++;
      lineStart = next.index + next[0].length;
      next = breaks.exec(text);
    }
    yield {
      start: match.index,
      end: match.index + match[0].length,
      prefix: match[1],
      directive: match[2],
      position: [row, match.index - lineStart],
    };
  }
}

function replace(text, entries, accept) {
  const parts = [];
  let offset = 0,
    index = 0;
  for (const entry of entries) {
    if (accept && !accept(entry, index++)) continue;
    parts.push(
      text.slice(offset, entry.start),
      entry.prefix +
        (entry.directive === entry.directive.toUpperCase() ? HIDDEN_NOQA_UPPER : HIDDEN_NOQA),
    );
    offset = entry.end;
  }
  if (!parts.length) return text;
  parts.push(text.slice(offset));
  return parts.join("");
}

exports.transform = (text, { useNoqa, isComment }) =>
  useNoqa
    ? text
    : replace(text, directives(text), isComment && ((entry) => isComment(entry.position)));

exports.transformScoped = async function (
  text,
  editor,
  { signal, mapPosition = (position) => position } = {},
) {
  signal?.throwIfAborted();
  const entries = [...directives(text)];
  if (!entries.length) return text;
  const positions = [],
    indices = [];
  for (let i = 0; i < entries.length; i++) {
    const position = mapPosition(entries[i].position);
    if (position) {
      positions.push(position);
      indices.push(i);
    }
  }
  const scopes = editor.getScopeDescriptorsForBufferPositions
    ? await editor.getScopeDescriptorsForBufferPositions(positions, { signal })
    : positions.map((position) => editor.scopeDescriptorForBufferPosition(position));
  signal?.throwIfAborted();
  if (!scopes) {
    const error = new Error("Source changed while resolving Noqa comments");
    error.name = "AbortError";
    throw error;
  }
  const comments = new Set();
  for (let i = 0; i < scopes.length; i++)
    if (scopes[i].getScopesArray().some((scope) => scope.includes("comment")))
      comments.add(indices[i]);
  return replace(text, entries, (_entry, index) => comments.has(index));
};

exports.restoreNoqa = (text) =>
  text.replaceAll(HIDDEN_NOQA_UPPER, "NOQA").replaceAll(HIDDEN_NOQA, "noqa");

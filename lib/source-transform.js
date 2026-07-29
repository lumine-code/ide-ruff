const MAGIC_PLACEHOLDER_PREFIX = "ide-ruff-magic:";
const HIDDEN_NOQA = "\uE000\uE001\uE002\uE003";
const HIDDEN_NOQA_UPPER = "\uE004\uE005\uE006\uE007";

// Ruff's native server has no equivalent of `ruff check --ignore-noqa`.
// Hide the directive without changing its width, so every diagnostic and edit
// position still addresses the original editor text.
const NOQA_DIRECTIVE = /(#\s*(?:(?:ruff|flake8)\s*:\s*)?)(noqa)\b/gi;

const pointAt = (text, offset) => {
  const lines = text.slice(0, offset).split(/\r\n|\n|\r/);
  return [lines.length - 1, lines[lines.length - 1].length];
};

const hideNoqa = (text, isComment) =>
  text.replace(NOQA_DIRECTIVE, (match, prefix, directive, offset) => {
    if (isComment && !isComment(pointAt(text, offset))) return match;
    const suffix = directive === directive.toUpperCase() ? HIDDEN_NOQA_UPPER : HIDDEN_NOQA;
    return `${prefix}${suffix}`;
  });

const restoreNoqa = (text) =>
  text.replaceAll(HIDDEN_NOQA_UPPER, "NOQA").replaceAll(HIDDEN_NOQA, "noqa");

const maskMagicLines = (text, magicLines) => {
  const parts = text.split(/(\r\n|\n|\r)/);

  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const introspectionMatch = line.match(/^(\s*)(\?\??[\w.]+|\S+\?\??)(\s*)$/);
    if (!line.startsWith("%") && !introspectionMatch) continue;

    const indentation = introspectionMatch ? introspectionMatch[1] : "";
    parts[index] = `${indentation}# ${MAGIC_PLACEHOLDER_PREFIX}${magicLines.length}`;
    magicLines.push(line);
  }

  return parts.join("");
};

const restoreMagicLines = (text, magicLines) => {
  if (!magicLines.length) return text;

  const parts = text.split(/(\r\n|\n|\r)/);
  const placeholder = new RegExp(`^\\s*# ${MAGIC_PLACEHOLDER_PREFIX}(\\d+)\\s*$`);

  for (let index = 0; index < parts.length; index += 2) {
    const match = parts[index].match(placeholder);
    if (match && magicLines[Number(match[1])] != null) {
      parts[index] = magicLines[Number(match[1])];
    }
  }

  return parts.join("");
};

exports.transform = (text, { allowMagic, useNoqa, isComment }) => {
  let transformed = text;
  if (allowMagic) transformed = maskMagicLines(transformed, []);
  if (!useNoqa) transformed = hideNoqa(transformed, isComment);
  return transformed;
};

exports.restore = (text, originalText) => {
  const magicLines = [];
  maskMagicLines(originalText, magicLines);
  return restoreMagicLines(restoreNoqa(text), magicLines);
};

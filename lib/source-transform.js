const HIDDEN_NOQA = "\uE000\uE001\uE002\uE003";
const HIDDEN_NOQA_UPPER = "\uE004\uE005\uE006\uE007";
const NOQA_DIRECTIVE = /(#\s*(?:(?:ruff|flake8)\s*:\s*)?)(noqa)\b/gi;

const pointAt = (text, offset) => {
  const lines = text.slice(0, offset).split(/\r\n|\n|\r/);
  return [lines.length - 1, lines[lines.length - 1].length];
};

exports.transform = (text, { useNoqa, isComment }) =>
  useNoqa
    ? text
    : text.replace(NOQA_DIRECTIVE, (match, prefix, directive, offset) => {
        if (isComment && !isComment(pointAt(text, offset))) return match;
        return prefix + (directive === directive.toUpperCase() ? HIDDEN_NOQA_UPPER : HIDDEN_NOQA);
      });

exports.restoreNoqa = (text) =>
  text.replaceAll(HIDDEN_NOQA_UPPER, "NOQA").replaceAll(HIDDEN_NOQA, "noqa");

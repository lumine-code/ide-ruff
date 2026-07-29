const fs = require("fs");
const path = require("path");

// Locates an executable on PATH; on Windows the PATHEXT extensions are tried
// because spawn() with shell:false does not resolve .cmd/.bat shims.
exports.findOnPath = (name, env = process.env) => {
  const extensions =
    process.platform === "win32" ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of ["", ...extensions]) {
      const candidate = path.join(dir, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
};

// Ruff's language server is a subcommand of the ruff binary itself; there is no
// separate server distribution to fall back on, so an absent binary resolves to
// null and the caller reports it.
exports.resolveServer = async (configuredPath) => {
  if (configuredPath) {
    await fs.promises.access(configuredPath, fs.constants.X_OK);
    return { command: configuredPath, args: ["server"] };
  }
  const command = exports.findOnPath("ruff");
  return command ? { command, args: ["server"] } : null;
};

exports.configurationArgs = ({ fixable = [], unfixable = [] }) => {
  const args = [];
  const append = (key, value) => args.push("--config", `${key} = ${JSON.stringify(value)}`);

  if (fixable.length) append("lint.fixable", fixable);
  if (unfixable.length) append("lint.unfixable", unfixable);
  // A project session can receive an IPython editor later, so its history
  // variables need to be recognized from startup even if Python opens first.
  append("builtins", ["_", "__", "___"]);

  return args;
};

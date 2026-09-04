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

// Ruff publishes one archive per Rust target through cargo-dist. The name is
// computed rather than searched for: the release carries other assets, and a
// prefix match would fetch one of those.
const TARGETS = {
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

exports.assetFor = ({ platform, arch }) => {
  const target = TARGETS[`${platform}-${arch}`];
  if (!target) return null;
  return `ruff-${target}.${platform === "win32" ? "zip" : "tar.gz"}`;
};

// Where the editor can fetch ruff itself, so a machine without one is a command
// away from having it rather than a trip to a shell.
exports.managedServer = {
  source: "github-release",
  displayName: "Ruff",
  repository: "astral-sh/ruff",
  assetFor: exports.assetFor,
  checksum: "sha256-sidecar",
  binary: process.platform === "win32" ? "ruff.exe" : "ruff",
};

// Ruff's language server is a subcommand of the ruff binary itself, so there is
// no separate server distribution: either a ruff exists or nothing runs.
//
// The configured path wins because it is the only setting that says which copy
// to use. A managed install comes next — it exists only because the user asked
// for one — and PATH last, which is also where uninstalling lands.
exports.resolveServer = async (configuredPath, managed = null) => {
  if (configuredPath) {
    await fs.promises.access(configuredPath, fs.constants.X_OK);
    return { command: configuredPath, args: ["server"] };
  }
  if (managed?.binaryPath) {
    return { command: managed.binaryPath, args: ["server"], version: managed.version };
  }
  const command = exports.findOnPath("ruff");
  return command ? { command, args: ["server"] } : null;
};

exports.configurationArgs = ({ fixable = [], unfixable = [] }) => {
  const args = [];
  const append = (key, value) => args.push("--config", `${key} = ${JSON.stringify(value)}`);

  if (fixable.length) append("lint.fixable", fixable);
  if (unfixable.length) append("lint.unfixable", unfixable);

  return args;
};

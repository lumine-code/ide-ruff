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
exports.resolveServer = async (context, configuredPath = "") => {
  const selection = await context.resolver.select({
    kind: "executable",
    configuredPath,
    managed: () => {
      const installed = context.getManagedServer();
      return installed ? { path: installed.binaryPath, version: installed.version } : null;
    },
    env: context.env,
    cwd: context.rootPath,
    names: ["ruff"],
    signal: context.signal,
  });
  return selection
    ? context.resolver.launch(selection, { signal: context.signal, args: ["server"] })
    : null;
};

exports.configurationArgs = ({ fixable = [], unfixable = [] }) => {
  const args = [];
  const append = (key, value) => args.push("--config", `${key} = ${JSON.stringify(value)}`);

  if (fixable.length) append("lint.fixable", fixable);
  if (unfixable.length) append("lint.unfixable", unfixable);

  return args;
};

const path = require("path");
const { resolveServer, findOnPath } = require("../lib/server");
const main = require("../lib/main");

// The package is not activated in these specs, so its configSchema defaults are
// not registered; every setting the adapter reads is set explicitly first.
const defaults = {
  serverPath: "",
  configuration: "",
  lineLength: 0,
  fixAll: true,
  organizeImports: true,
  showSyntaxErrors: true,
  disableRuleComment: true,
  fixViolation: true,
};

const registerAdapter = () => {
  let adapter;
  const disposable = main.consumeIdeClient({
    registerAdapter(registered) {
      adapter = registered;
      return { dispose() {} };
    },
  });
  return { adapter, disposable };
};

describe("ide-ruff server resolution", () => {
  it("prefers the configured path", async () => {
    const launch = await resolveServer(process.execPath);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["server"]);
  });
  it("finds executables on a synthetic PATH", () => {
    const dir = path.dirname(process.execPath);
    const name = path.basename(process.execPath, path.extname(process.execPath));
    expect(findOnPath(name, { PATH: dir, PATHEXT: ".EXE" })).toBeTruthy();
    expect(findOnPath("definitely-not-a-real-binary", { PATH: dir })).toBeNull();
  });
  it("resolves to null when ruff is nowhere on PATH", async () => {
    spyOn(require("../lib/server"), "findOnPath").and.returnValue(null);
    expect(await resolveServer("")).toBeNull();
  });
});

describe("ide-ruff adapter", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(defaults)) atom.config.set(`ide-ruff.${key}`, value);
  });

  it("registers with the language-server service", () => {
    const { adapter, disposable } = registerAdapter();
    expect(adapter.id).toBe("ide-ruff");
    expect(adapter.displayName).toBe("Ruff Language Server");
    expect(adapter.grammarScopes).toEqual(["source.python", "source.python.ipy"]);
    expect(adapter.languageId).toBe("python");
    expect(adapter.sessionScope).toBe("project-root");
    expect(adapter.settingsKeyPaths).toEqual(["ide-ruff"]);
    disposable.dispose();
  });

  it("launches `ruff server` in the resolution context's root", async () => {
    const { adapter, disposable } = registerAdapter();
    atom.config.set("ide-ruff.serverPath", process.execPath);
    const launch = await adapter.resolveServer({ rootPath: __dirname });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["server"]);
    expect(launch.cwd).toBe(__dirname);
    expect(launch.transport).toBe("stdio");
    disposable.dispose();
  });

  it("maps editor settings into the ruff configuration section", () => {
    const { adapter, disposable } = registerAdapter();
    atom.config.set("ide-ruff.lineLength", 120);
    atom.config.set("ide-ruff.organizeImports", false);
    atom.config.set("ide-ruff.disableRuleComment", false);

    const { ruff } = adapter.getSettings();
    expect(ruff.lineLength).toBe(120);
    expect(ruff.fixAll).toBe(true);
    expect(ruff.organizeImports).toBe(false);
    expect(ruff.showSyntaxErrors).toBe(true);
    expect(ruff.codeAction.disableRuleComment.enable).toBe(false);
    expect(ruff.codeAction.fixViolation.enable).toBe(true);

    expect(adapter.getWorkspaceConfiguration("ruff").lineLength).toBe(120);
    expect(adapter.getWorkspaceConfiguration().ruff.lineLength).toBe(120);
    // The startup handshake carries the same settings, unwrapped.
    expect(adapter.getInitializationOptions().settings.lineLength).toBe(120);
    disposable.dispose();
  });

  it("omits the settings Ruff should take from its own configuration file", () => {
    const { adapter, disposable } = registerAdapter();
    const { ruff } = adapter.getSettings();
    expect(ruff.lineLength).toBeUndefined();
    expect(ruff.configuration).toBeUndefined();

    atom.config.set("ide-ruff.configuration", "/etc/ruff.toml");
    expect(adapter.getSettings().ruff.configuration).toBe("/etc/ruff.toml");
    disposable.dispose();
  });
});

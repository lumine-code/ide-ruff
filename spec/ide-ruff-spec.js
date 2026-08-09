const path = require("path");
const { resolveServer, findOnPath, configurationArgs } = require("../lib/server");
const main = require("../lib/main");
const sourceTransform = require("../lib/source-transform");

const registerAdapter = () => {
  let adapter;
  const disposable = main.consumeIdeClient({
    registerAdapter(registered) {
      adapter = registered;
      return { dispose() {} };
    },
    getSessions: () => [],
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
  it("maps fix policy and IPython names to native-server configuration overrides", () => {
    expect(
      configurationArgs({
        fixable: ["F401"],
        unfixable: ["B"],
      }),
    ).toEqual([
      "--config",
      'lint.fixable = ["F401"]',
      "--config",
      'lint.unfixable = ["B"]',
      "--config",
      'builtins = ["_","__","___"]',
    ]);
    expect(configurationArgs({})).toEqual(["--config", 'builtins = ["_","__","___"]']);
  });
});

describe("ide-ruff adapter", () => {
  beforeEach(async () => {
    // Applies the configSchema, so the defaults the adapter reads are the ones
    // the manifest declares rather than a copy of them kept here.
    await lumine.packages.activatePackage("ide-ruff");
  });
  afterEach(async () => lumine.packages.deactivatePackage("ide-ruff"));

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
    lumine.config.set("ide-ruff.serverPath", process.execPath);
    const launch = await adapter.resolveServer({ rootPath: __dirname });
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["server", "--config", 'builtins = ["_","__","___"]']);
    expect(launch.cwd).toBe(__dirname);
    expect(launch.transport).toBe("stdio");
    disposable.dispose();
  });

  it("maps editor settings into the ruff configuration section", () => {
    const { adapter, disposable } = registerAdapter();
    lumine.config.set("ide-ruff.lineLength", 120);
    lumine.config.set("ide-ruff.organizeImports", false);
    lumine.config.set("ide-ruff.codeAction.disableRuleComment", false);
    lumine.config.set("ide-ruff.lint.select", ["E", "F"]);
    lumine.config.set("ide-ruff.lint.extendSelect", ["B"]);
    lumine.config.set("ide-ruff.lint.ignore", ["E501"]);
    lumine.config.set("ide-ruff.exclude", ["build"]);
    lumine.config.set("ide-ruff.configurationPreference", "filesystemFirst");

    const { ruff } = adapter.getSettings();
    expect(ruff.lineLength).toBe(120);
    expect(ruff.fixAll).toBe(true);
    expect(ruff.organizeImports).toBe(false);
    expect(ruff.showSyntaxErrors).toBe(true);
    expect(ruff.configurationPreference).toBe("filesystemFirst");
    expect(ruff.exclude).toEqual(["build"]);
    expect(ruff.lint.select).toEqual(["E", "F"]);
    expect(ruff.lint.extendSelect).toEqual(["B"]);
    expect(ruff.lint.ignore).toEqual(["E501"]);
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
    expect(ruff.exclude).toBeUndefined();
    expect(ruff.lint.select).toBeUndefined();
    expect(ruff.lint.extendSelect).toBeUndefined();
    expect(ruff.lint.ignore).toBeUndefined();

    lumine.config.set("ide-ruff.configuration", "/etc/ruff.toml");
    expect(adapter.getSettings().ruff.configuration).toBe("/etc/ruff.toml");
    disposable.dispose();
  });

  it("stops the server linting when the diagnostics switch is off", () => {
    // One control, not two: what the editor would discard is not computed.
    const { adapter, disposable } = registerAdapter();
    expect(adapter.getSettings().ruff.lint.enable).toBe(true);
    lumine.config.set("ide-ruff.features.diagnostics", false);
    expect(adapter.getSettings().ruff.lint.enable).toBe(false);
    disposable.dispose();
  });

  describe("applying a changed setting", () => {
    // Ruff's didChangeConfiguration handler is an empty stub upstream, so the
    // push it receives is discarded and a restart is the only thing that
    // applies a change. Without one, every setting on the page would look like
    // it did nothing.
    const withSession = () => {
      const restarted = [];
      let adapter;
      const session = { state: "running" };
      const disposable = main.consumeIdeClient({
        registerAdapter(registered) {
          adapter = registered;
          session.adapter = registered;
          return { dispose() {} };
        },
        getSessions: () => [session],
        restart: async (target) => restarted.push(target),
      });
      return { adapter, restarted, disposable };
    };

    it("restarts the server for a server setting", () => {
      const { restarted, disposable } = withSession();
      lumine.config.set("ide-ruff.lint.select", ["F401"]);
      expect(restarted.length).toBe(1);
      lumine.config.set("ide-ruff.lineLength", 100);
      expect(restarted.length).toBe(2);
      disposable.dispose();
    });

    it("leaves it alone for a switch the editor applies itself", () => {
      const { restarted, disposable } = withSession();
      lumine.config.set("ide-ruff.features.hover", false);
      lumine.config.set("ide-ruff.features.format", false);
      expect(restarted.length).toBe(0);
      // Diagnostics are the exception: they also decide whether Ruff lints,
      // which it reads at startup.
      lumine.config.set("ide-ruff.features.diagnostics", false);
      expect(restarted.length).toBe(1);
      disposable.dispose();
    });
  });

  it("offers a switch only for what Ruff advertises", () => {
    // Verified against the server's own initialize response: Ruff is a linter
    // and a formatter, so there is nothing to switch for completions,
    // navigation, symbols, inlay hints, code lens or semantic tokens.
    const { configSchema } = require("../package.json");
    expect(Object.keys(configSchema.features.properties)).toEqual([
      "diagnostics",
      "hover",
      "format",
      "codeActions",
    ]);
  });

  it("reversibly hides noqa directives and IPython magic from Ruff", () => {
    const { adapter, disposable } = registerAdapter();
    lumine.config.set("ide-ruff.useNoqa", false);
    const original = "# ruff: noqa: F401\nimport os  # noqa: F401\n%timeit os.getcwd()\n  value?\n";
    const transformed = adapter.transformDocumentText(original, {
      editor: {
        getGrammar: () => ({ scopeName: "source.python.ipy" }),
        scopeDescriptorForBufferPosition: () => ({
          getScopesArray: () => ["source.python", "comment.line.number-sign.python"],
        }),
      },
    });

    expect(transformed).not.toContain("noqa");
    expect(transformed).not.toContain("%timeit");
    expect(transformed).not.toContain("value?");
    expect(
      adapter.restoreDocumentText(transformed, {
        editor: { getText: () => original },
      }),
    ).toBe(original);

    const pythonSource = "%timeit range(10)\n";
    expect(
      adapter.transformDocumentText(pythonSource, {
        editor: {
          getGrammar: () => ({ scopeName: "source.python" }),
          scopeDescriptorForBufferPosition: () => ({
            getScopesArray: () => ["source.python"],
          }),
        },
      }),
    ).toBe(pythonSource);
    disposable.dispose();
  });
});

describe("ide-ruff source transforms", () => {
  it("leaves text untouched when no transformation is requested", () => {
    const source = "import os  # noqa: F401\n%timeit os.getcwd()\n";
    expect(sourceTransform.transform(source, { maskMagic: false, useNoqa: true })).toBe(source);
  });

  it("does not hide noqa-shaped text outside a comment scope", () => {
    const source = 'label = "# noqa: F401"\nimport os  # noqa: F401\n';
    const transformed = sourceTransform.transform(source, {
      maskMagic: false,
      useNoqa: false,
      isComment: ([row]) => row === 1,
    });
    expect(transformed).toContain('"# noqa: F401"');
    expect(transformed).not.toContain("import os  # noqa");
    expect(sourceTransform.restore(transformed, source)).toBe(source);
  });
});

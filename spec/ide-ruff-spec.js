const { resolver, serverContext } = require("./helpers/server-resolver");
const path = require("path");
const { resolveServer, configurationArgs, assetFor } = require("../lib/server");
let main;
const sourceTransform = require("../lib/source-transform");

const registerAdapter = () => {
  let adapter;
  const disposable = main.consumeIde({
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
    const launch = await resolveServer(serverContext(), process.execPath);
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["server"]);
  });
  it("resolves to null when ruff is nowhere on PATH", async () => {
    spyOn(resolver, "select").and.resolveTo(null);
    expect(await resolveServer(serverContext(), "")).toBeNull();
  });
  it("names the exact release asset for each platform it supports", () => {
    expect(assetFor({ platform: "win32", arch: "x64" })).toBe("ruff-x86_64-pc-windows-msvc.zip");
    expect(assetFor({ platform: "darwin", arch: "arm64" })).toBe(
      "ruff-aarch64-apple-darwin.tar.gz",
    );
    expect(assetFor({ platform: "linux", arch: "x64" })).toBe(
      "ruff-x86_64-unknown-linux-gnu.tar.gz",
    );
    // An unsupported platform says so rather than guessing a name.
    expect(assetFor({ platform: "aix", arch: "ppc64" })).toBeNull();
  });
  it("maps fix policy without weakening ordinary Python undefined-name checks", () => {
    expect(
      configurationArgs({
        fixable: ["F401"],
        unfixable: ["B"],
      }),
    ).toEqual(["--config", 'lint.fixable = ["F401"]', "--config", 'lint.unfixable = ["B"]']);
    expect(configurationArgs({})).toEqual([]);
  });
});

describe("ide-ruff adapter", () => {
  beforeEach(async () => {
    // Applies the configSchema, so the defaults the adapter reads are the ones
    // the manifest declares rather than a copy of them kept here.
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
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
    expect(adapter.restartKeyPaths).toEqual([
      "ide-ruff.serverPath",
      "ide-ruff.useNoqa",
      "ide-ruff.configuration",
      "ide-ruff.configurationPreference",
      "ide-ruff.exclude",
      "ide-ruff.lineLength",
      "ide-ruff.fixAll",
      "ide-ruff.organizeImports",
      "ide-ruff.showSyntaxErrors",
      "ide-ruff.logLevel",
      "ide-ruff.logFile",
      "ide-ruff.features.diagnostics",
      "ide-ruff.lint.preview",
      "ide-ruff.lint.select",
      "ide-ruff.lint.extendSelect",
      "ide-ruff.lint.ignore",
      "ide-ruff.lint.fixable",
      "ide-ruff.lint.unfixable",
      "ide-ruff.format.preview",
      "ide-ruff.format.backend",
      "ide-ruff.codeAction.disableRuleComment",
      "ide-ruff.codeAction.fixViolation",
    ]);
    disposable.dispose();
  });

  it("launches `ruff server` in the resolution context's root", async () => {
    const { adapter, disposable } = registerAdapter();
    lumine.config.set("ide-ruff.serverPath", process.execPath);
    const launch = await adapter.resolveServer(serverContext({ rootPath: __dirname }));
    expect(launch.command).toBe(process.execPath);
    expect(launch.args).toEqual(["server"]);
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
    lumine.config.set("ide-ruff.logFile", "/tmp/ruff.log");
    lumine.config.set("ide-ruff.format.backend", "uv");

    const { ruff } = adapter.getSettings();
    expect(ruff.lineLength).toBe(120);
    expect(ruff.fixAll).toBe(true);
    expect(ruff.organizeImports).toBe(false);
    expect(ruff.showSyntaxErrors).toBe(true);
    expect(ruff.configurationPreference).toBe("filesystemFirst");
    expect(ruff.logFile).toBe("/tmp/ruff.log");
    expect(ruff.exclude).toEqual(["build"]);
    expect(ruff.lint.select).toEqual(["E", "F"]);
    expect(ruff.lint.extendSelect).toEqual(["B"]);
    expect(ruff.lint.ignore).toEqual(["E501"]);
    expect(ruff.codeAction.disableRuleComment.enable).toBe(false);
    expect(ruff.codeAction.fixViolation.enable).toBe(true);
    expect(ruff.format.backend).toBe("uv");

    expect(adapter.getWorkspaceConfiguration).toBeUndefined();
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

  it("keeps server linting on when any grammar-scoped diagnostics route needs it", () => {
    const { adapter, disposable } = registerAdapter();
    expect(adapter.getSettings().ruff.lint.enable).toBe(true);
    lumine.config.set("ide-ruff.features.diagnostics", false);
    expect(adapter.getSettings().ruff.lint.enable).toBe(false);
    lumine.config.set("ide-ruff.features.diagnostics", true, {
      scopeSelector: ".source.python.ipy",
    });
    expect(adapter.getSettings().ruff.lint.enable).toBe(true);
    lumine.config.unset("ide-ruff.features.diagnostics", {
      scopeSelector: ".source.python.ipy",
    });
    disposable.dispose();
  });

  it("keeps switches that do not change synchronized text out of the restart contract", () => {
    const { adapter, disposable } = registerAdapter();
    expect(adapter.restartKeyPaths).not.toContain("ide-ruff.features.hover");
    expect(adapter.restartKeyPaths).not.toContain("ide-ruff.features.format");
    expect(adapter.restartKeyPaths).toContain("ide-ruff.useNoqa");
    expect(adapter.restartKeyPaths).not.toContain("ide-ruff.notifyWhenMissing");
    disposable.dispose();
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

  it("uses the shared IPython projection and keeps its same-width noqa policy", async () => {
    const { adapter, disposable } = registerAdapter();
    lumine.config.set("ide-ruff.useNoqa", false);
    const original = "# ruff: noqa: F401\nimport os  # noqa: F401\n%timeit os.getcwd()\n  value?\n";
    const editor = {
      getGrammar: () => ({ scopeName: "source.python.ipy" }),
      scopeDescriptorForBufferPosition: () => ({
        getScopesArray: () => ["source.python", "comment.line.number-sign.python"],
      }),
    };
    const snapshot = Object.freeze({
      source: original,
      text: "# ruff: noqa: F401\nimport os  # noqa: F401\n0\n  0\n",
      isCurrent: () => true,
      fromServerPosition: (point) => point,
      isPythonPosition: () => true,
      mapEdits: (edits) => edits,
    });
    const project = jasmine.createSpy("project").and.resolveTo(snapshot);
    const provider = main.consumeIpythonSource({ isApplicable: () => true, project });
    const projection = await adapter.getDocumentProjection(editor);
    const transformed = projection.text;

    expect(transformed).not.toContain("noqa");
    expect(transformed).not.toContain("%timeit");
    expect(transformed).not.toContain("value?");
    expect(projection.mapEdits([{ oldRange: {}, newText: transformed }])[0].newText).toBe(
      snapshot.text,
    );
    expect(project).toHaveBeenCalledWith(editor, { signal: undefined });

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
    provider.dispose();
    disposable.dispose();
  });

  it("uses Python selected for an IPython filename without requesting its projection", () => {
    const { adapter, disposable } = registerAdapter();
    lumine.config.set("ide-ruff.useNoqa", true);
    const editor = {
      getGrammar: () => ({ scopeName: "source.python" }),
      getPath: () => "mixed.ipy",
      scopeDescriptorForBufferPosition: () => ({ getScopesArray: () => ["source.python"] }),
    };
    expect(adapter.needsDocumentTransform(editor)).toBe(false);
    expect(adapter.isFeatureAvailable("format", editor)).toBe(true);
    expect(adapter.transformDocumentText("value = 1\n", { editor })).toBe("value = 1\n");
    disposable.dispose();
  });

  it("uses root scopes before falling back to an unclassified IPython filename", () => {
    const { adapter, disposable } = registerAdapter();
    lumine.config.set("ide-ruff.useNoqa", true);
    const scoped = (scopes) => ({
      getRootScopeDescriptor: () => ({ getScopesArray: () => scopes }),
      getPath: () => "mixed.ipy",
    });
    expect(adapter.needsDocumentTransform(scoped(["source.python"]))).toBe(false);
    expect(adapter.needsDocumentTransform(scoped(["source.python.ipy"]))).toBe(true);
    expect(adapter.needsDocumentTransform({ getPath: () => "mixed.ipy" })).toBe(true);
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
    expect(sourceTransform.restoreNoqa(transformed)).toBe(source);
  });

  it("leaves magic-looking text alone because only the AST provider classifies IPython", () => {
    const source =
      '!pip install numpy\nif ready:\n    %timeit work()\n# %% shell\n%%bash\necho "$HOME"\nfor file in *; do echo "$file"; done\n# %% python\nanswer = 42\n';
    const transformed = sourceTransform.transform(source, {
      useNoqa: true,
    });

    expect(transformed).toBe(source);
  });
});

const { resolveServer, configurationArgs, managedServer } = require("./server");
const sourceTransform = require("./source-transform");

const setting = (key) => lumine.config.get(`ide-ruff.${key}`);
const GRAMMAR_SCOPES = ["source.python", "source.python.ipy"];
const featureUsedInAnyScope = (feature) =>
  GRAMMAR_SCOPES.some(
    (scope) => lumine.config.get(`ide-ruff.features.${feature}`, { scope: [scope] }) !== false,
  );
const optionalList = (key) => {
  const value = setting(key);
  return value?.length ? value : undefined;
};

// Ruff merges the settings it receives over the `ruff.toml` / `pyproject.toml`
// it discovers, so a value that only restates a default would silently win over
// the project's own configuration. `configuration` and `lineLength` are
// therefore dropped while they are empty. Rule lists are omitted for the same
// reason, while the remaining values are server-only behavior toggles.
const ruffSettings = () => {
  const lineLength = setting("lineLength");
  return {
    configuration: setting("configuration") || undefined,
    configurationPreference: setting("configurationPreference"),
    exclude: optionalList("exclude"),
    lineLength: lineLength > 0 ? lineLength : undefined,
    fixAll: setting("fixAll"),
    organizeImports: setting("organizeImports"),
    showSyntaxErrors: setting("showSyntaxErrors"),
    logLevel: setting("logLevel"),
    logFile: setting("logFile") || undefined,
    lint: {
      // The Diagnostics feature switch is the single control over Ruff's
      // violations. Mapping it here as well means a server whose diagnostics
      // would be discarded does not compute them in the first place.
      enable: featureUsedInAnyScope("diagnostics"),
      preview: setting("lint.preview"),
      select: optionalList("lint.select"),
      extendSelect: optionalList("lint.extendSelect"),
      ignore: optionalList("lint.ignore"),
    },
    format: {
      preview: setting("format.preview"),
      backend: setting("format.backend"),
    },
    codeAction: {
      disableRuleComment: { enable: setting("codeAction.disableRuleComment") },
      fixViolation: { enable: setting("codeAction.fixViolation") },
    },
  };
};

module.exports = {
  consumeIdeClient(service) {
    const adapter = {
      id: "ide-ruff",
      displayName: "Ruff Language Server",
      // The IPython dialect is not in the client's scope table and its grammar
      // name would resolve to an identifier no server knows, so the whole
      // adapter declares the Python language identifier.
      languageId: "python",
      grammarScopes: GRAMMAR_SCOPES,
      sessionScope: "project-root",
      // Kept although Ruff currently discards the push it triggers. If its
      // handler is implemented upstream, the restart list below can be narrowed
      // without adding a new configuration observer.
      settingsKeyPaths: ["ide-ruff"],
      // Ruff reads these while resolving the launch or initializing. Its
      // didChangeConfiguration handler is currently an empty stub upstream.
      // useNoqa also restarts: it changes the text synchronized to the server,
      // and a settings push alone cannot replace already-open documents.
      restartKeyPaths: [
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
      ],
      managedServer,
      async resolveServer(context) {
        const launch = await resolveServer(setting("serverPath"), context.managedServer);
        if (!launch) {
          // The hub owns the wording, the once-per-window dedupe, the Install
          // button and the opt-out, so every adapter says this the same way.
          service.reportMissingServer("ide-ruff", {
            description:
              "Install [Ruff](https://docs.astral.sh/ruff/installation/) and make sure it is on your PATH, or set its location in the ide-ruff settings. The editor can also fetch it for you.",
          });
          return null;
        }
        return {
          ...launch,
          args: [
            ...(launch.args || []),
            ...configurationArgs({
              fixable: setting("lint.fixable"),
              unfixable: setting("lint.unfixable"),
            }),
          ],
          cwd: context.rootPath,
          transport: "stdio",
        };
      },
      // Ruff reads its startup settings from the initialization options and
      // later updates from the `ruff` configuration section.
      getInitializationOptions() {
        return { settings: ruffSettings() };
      },
      getSettings() {
        return { ruff: ruffSettings() };
      },
      getWorkspaceConfiguration(section) {
        if (section === "ruff") return ruffSettings();
        return section ? lumine.config.get(section) : { ruff: ruffSettings() };
      },
      transformDocumentText(text, { editor }) {
        const isIpython = editor.getGrammar().scopeName === "source.python.ipy";
        return sourceTransform.transform(text, {
          maskMagic: isIpython,
          useNoqa: setting("useNoqa"),
          isComment: (position) =>
            editor
              .scopeDescriptorForBufferPosition(position)
              .getScopesArray()
              .some((scope) => scope.includes("comment")),
        });
      },
      restoreDocumentText(text, { editor }) {
        return sourceTransform.restore(text, editor.getText());
      },
    };

    return service.registerAdapter(adapter);
  },
};

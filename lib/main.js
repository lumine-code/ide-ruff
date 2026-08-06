const { CompositeDisposable } = require("atom");
const { resolveServer, configurationArgs } = require("./server");
const sourceTransform = require("./source-transform");

let missingReported = false;

const setting = (key) => atom.config.get(`ide-ruff.${key}`);
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
    lint: {
      // The Diagnostics feature switch is the single control over Ruff's
      // violations. Mapping it here as well means a server whose diagnostics
      // would be discarded does not compute them in the first place.
      enable: setting("features.diagnostics") !== false,
      preview: setting("lint.preview"),
      select: optionalList("lint.select"),
      extendSelect: optionalList("lint.extendSelect"),
      ignore: optionalList("lint.ignore"),
    },
    format: {
      preview: setting("format.preview"),
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
      grammarScopes: ["source.python", "source.python.ipy"],
      sessionScope: "project-root",
      settingsKeyPaths: ["ide-ruff"],
      async resolveServer(context) {
        const launch = await resolveServer(setting("serverPath"));
        if (!launch) {
          if (!missingReported) {
            missingReported = true;
            atom.notifications.addError("Unable to find ruff", {
              description:
                "Install [Ruff](https://docs.astral.sh/ruff/installation/) and make sure it is on your PATH, or set its location in the ide-ruff settings.",
              dismissable: true,
            });
          }
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
        return section ? atom.config.get(section) : { ruff: ruffSettings() };
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

    const subscriptions = new CompositeDisposable(service.registerAdapter(adapter));
    const restart = () => {
      for (const session of service.getSessions?.() || []) {
        if (session.adapter === adapter && !["stopping", "stopped"].includes(session.state)) {
          service.restart(session).catch((error) => {
            atom.notifications.addError("Unable to restart Ruff Language Server", {
              detail: error.message,
              dismissable: true,
            });
          });
        }
      }
    };
    // The rest reaches a running server through didChangeConfiguration. These
    // four do not: two are command-line arguments, one selects the executable,
    // and the noqa flag changes the text every document is synchronized as.
    for (const key of ["serverPath", "lint.fixable", "lint.unfixable", "useNoqa"]) {
      subscriptions.add(atom.config.onDidChange(`ide-ruff.${key}`, restart));
    }
    return subscriptions;
  },
};

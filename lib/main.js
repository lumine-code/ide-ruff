const { resolveServer } = require("./server");

let missingReported = false;

const setting = (key) => atom.config.get(`ide-ruff.${key}`);

// Ruff merges the settings it receives over the `ruff.toml` / `pyproject.toml`
// it discovers, so a value that only restates a default would silently win over
// the project's own configuration. `configuration` and `lineLength` are
// therefore dropped while they are empty; the remaining keys are server-only
// toggles with no configuration-file counterpart, so pushing them is safe.
const ruffSettings = () => {
  const lineLength = setting("lineLength");
  return {
    configuration: setting("configuration") || undefined,
    lineLength: lineLength > 0 ? lineLength : undefined,
    fixAll: setting("fixAll"),
    organizeImports: setting("organizeImports"),
    showSyntaxErrors: setting("showSyntaxErrors"),
    codeAction: {
      disableRuleComment: { enable: setting("disableRuleComment") },
      fixViolation: { enable: setting("fixViolation") },
    },
  };
};

module.exports = {
  consumeIdeClient(service) {
    return service.registerAdapter({
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
        return { ...launch, cwd: context.rootPath, transport: "stdio" };
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
    });
  },
};

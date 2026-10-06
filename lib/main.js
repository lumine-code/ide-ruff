const { resolveServer, configurationArgs, managedServer } = require("./server");
const sourceTransform = require("./source-transform");
const path = require("path");
const { CompositeDisposable, Disposable, Point, Range } = require("lumine");
const { execFile } = require("child_process");

const isIpython = (context) => {
  const scopeName = context?.getGrammar?.()?.scopeName;
  if (scopeName) return scopeName === "source.python.ipy";
  const descriptor = context?.getRootScopeDescriptor?.();
  const scopes = Array.isArray(descriptor) ? descriptor : descriptor?.getScopesArray?.() || [];
  if (scopes.length) return scopes.includes("source.python.ipy");
  return path.extname(context?.getPath?.() || "").toLowerCase() === ".ipy";
};

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
  execFile,

  activate() {
    this.scanMessages = [];
    this.scanNotebookSnapshots = new Map();
    this.disposables = new CompositeDisposable(
      lumine.commands.add("lumine-workspace", {
        "ide-ruff:lint-projects": {
          description: "Run Ruff over the files in every project folder.",
          didDispatch: () => this.ensureProjectScanner().runScan(),
        },
        "ide-ruff:lint-selected": {
          description: "Run Ruff over the files and folders selected in the tree view.",
          didDispatch: () => this.ensureProjectScanner().runSelectedScan(),
        },
      }),
      lumine.project.onDidChangePaths(() => {
        this.projectScanner?.dispose();
        this.projectScanner = null;
        this.publishScanMessages([], undefined, new Map());
      }),
    );
  },

  deactivate() {
    this.projectScanner?.dispose();
    this.projectScanner = null;
    this.projectDiagnostics?.dispose();
    this.projectDiagnostics = null;
    this.disposables.dispose();
    this.scanDelegate = null;
    this.busySignal = null;
    this.treeViewSelection = null;
    this.ideClient = null;
    this.ipythonSource = null;
    this.scanMessages = [];
    this.scanNotebookSnapshots = new Map();
  },

  ensureProjectScanner() {
    this.projectScanner ??= new (require("./project-scanner"))(this);
    return this.projectScanner;
  },

  provideBackgroundTips() {
    return {
      packageName: "ide-ruff",
      tips: [
        "{% if keys['ide-ruff:lint-projects'] %}You can check Python files and notebooks across the project with {{ 'ide-ruff:lint-projects' | keystroke }}{% else %}You can check Python files and notebooks across the project with Ruff, including files you have not opened.{% endif %}",
      ],
    };
  },

  consumeLinterRegistry(registerIndie) {
    const delegate = registerIndie({ name: "Ruff/Project", deleteOnOpen: false });
    this.scanDelegate = delegate;
    this.refreshProjectDiagnostics();
    const registration = new Disposable(() => {
      if (this.scanDelegate === delegate) {
        this.retainProjectDiagnostics();
        this.projectScanner?.dispose();
        this.projectScanner = null;
        this.projectDiagnostics?.dispose();
        this.projectDiagnostics = null;
        this.scanDelegate = null;
      }
      delegate.dispose();
    });
    this.disposables.add(registration);
    return registration;
  },

  refreshProjectDiagnostics() {
    this.retainProjectDiagnostics();
    this.projectDiagnostics?.dispose();
    this.projectDiagnostics =
      this.scanDelegate &&
      this.ideClient?.createProjectDiagnostics?.("ide-ruff", this.scanDelegate);
    if (this.scanDelegate)
      this.publishScanMessages(
        this.projectScanner?.messages || this.scanMessages,
        undefined,
        this.projectScanner?.notebookSnapshots || this.scanNotebookSnapshots,
      );
  },

  retainProjectDiagnostics() {
    const messages = this.projectDiagnostics?.getMessages?.();
    if (Array.isArray(messages)) {
      this.scanMessages = messages;
      if (this.projectScanner) this.projectScanner.messages = messages;
    }
  },

  publishScanMessages(messages, options, notebookSnapshots = this.scanNotebookSnapshots) {
    this.scanMessages = messages;
    this.scanNotebookSnapshots = notebookSnapshots;
    (this.projectDiagnostics || this.scanDelegate)?.setAllMessages(
      messages,
      options,
      notebookSnapshots,
    );
  },

  consumeBusySignal(service) {
    this.busySignal = service;
    return new Disposable(() => {
      if (this.busySignal === service) {
        this.projectScanner?.disposeBusyMessage();
        this.busySignal = null;
      }
    });
  },

  consumeTreeViewSelection(service) {
    this.treeViewSelection = service;
    return new Disposable(() => {
      if (this.treeViewSelection === service) this.treeViewSelection = null;
    });
  },

  scanSettings() {
    return {
      ...ruffSettings(),
      useNoqa: setting("useNoqa"),
      fixable: setting("lint.fixable"),
      unfixable: setting("lint.unfixable"),
    };
  },

  async resolveScanServer() {
    const launch = await resolveServer(
      setting("serverPath"),
      this.ideClient?.managedServer?.("ide-ruff"),
    );
    if (!launch) {
      lumine.notifications.addWarning("Ruff was not found", {
        detail: "Install Ruff from Manage Servers or set Server Path in the ide-ruff settings.",
        dismissable: true,
      });
    }
    return launch;
  },

  consumeIpythonSource(service) {
    this.ipythonSource = service;
    this.projectionMissingNotified = false;
    return new Disposable(() => {
      if (this.ipythonSource === service) this.ipythonSource = null;
    });
  },

  consumeIdeClient(service) {
    this.ideClient = service;
    const owner = this;
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
      needsDocumentTransform(editor) {
        return isIpython(editor) || !setting("useNoqa");
      },
      async getDocumentProjection(editor, { signal } = {}) {
        if (!isIpython(editor)) {
          if (setting("useNoqa")) return null;
          const source = editor.getText();
          const mode = editor.getBuffer().getLanguageMode();
          const sourceRange = editor.getBuffer().getRange();
          const isCurrent = () =>
            !editor.isDestroyed() &&
            !signal?.aborted &&
            editor.getBuffer().getLanguageMode() === mode &&
            editor.getText() === source;
          const text = sourceTransform.transform(source, {
            maskMagic: false,
            useNoqa: false,
            isComment: (position) =>
              editor
                .scopeDescriptorForBufferPosition(position)
                .getScopesArray()
                .some((scope) => scope.includes("comment")),
          });
          return Object.freeze({
            source,
            text,
            isCurrent,
            isPythonPosition: () => isCurrent(),
            isPythonRange: () => isCurrent(),
            toServerPosition: (position) => new Point(position.row, position.column),
            fromServerPosition: (position) => new Point(position.row, position.column),
            toServerRange: (range) => Range.fromObject(range).copy(),
            fromServerRange: (range) => Range.fromObject(range).copy(),
            mapEdits: (edits) => {
              if (!isCurrent() || !Array.isArray(edits)) return null;
              const output = [];
              for (const edit of edits) {
                if (typeof edit?.newText !== "string") return null;
                const oldRange = Range.fromObject(edit.oldRange).copy();
                if (!sourceRange.containsRange(oldRange)) return null;
                output.push({ oldRange, newText: sourceTransform.restoreNoqa(edit.newText) });
              }
              return isCurrent() ? output : null;
            },
          });
        }
        if (!owner.ipythonSource?.isApplicable(editor)) {
          if (!owner.projectionMissingNotified) {
            owner.projectionMissingNotified = true;
            lumine.notifications.addWarning(
              "Enable language-ipython and its grammar to analyze this IPython document.",
            );
          }
          return null;
        }
        const projection = await owner.ipythonSource.project(editor, { signal });
        if (!projection || setting("useNoqa")) return projection;
        const text = sourceTransform.transform(projection.text, {
          maskMagic: false,
          useNoqa: false,
          isComment: ([row, column]) => {
            const original = projection.fromServerPosition(new Point(row, column));
            return (
              original &&
              projection.isPythonPosition(original) &&
              editor
                .scopeDescriptorForBufferPosition(original)
                .getScopesArray()
                .some((scope) => scope.includes("comment"))
            );
          },
        });
        return Object.freeze(
          Object.defineProperties(Object.create(projection), {
            text: { value: text, enumerable: true },
            mapEdits: {
              value: (edits) =>
                Array.isArray(edits) && edits.every((edit) => typeof edit?.newText === "string")
                  ? projection.mapEdits(
                      edits.map((edit) => ({
                        ...edit,
                        newText: sourceTransform.restoreNoqa(edit.newText),
                      })),
                    )
                  : null,
              enumerable: true,
            },
          }),
        );
      },
      formatProjectedDocument(editor, projection, context) {
        if (!isIpython(editor)) {
          const method =
            context.method === "range" ? "textDocument/rangeFormatting" : "textDocument/formatting";
          return context.session
            .request(
              method,
              {
                textDocument: { uri: context.uri },
                options: context.options,
                ...(context.range
                  ? {
                      range: {
                        start: {
                          line: context.range.start.row,
                          character: context.range.start.column,
                        },
                        end: { line: context.range.end.row, character: context.range.end.column },
                      },
                    }
                  : {}),
              },
              { signal: context.signal },
            )
            .then((edits) =>
              projection.mapEdits(
                (edits || []).map((edit) => ({
                  oldRange: new Range(
                    [edit.range.start.line, edit.range.start.character],
                    [edit.range.end.line, edit.range.end.character],
                  ),
                  newText: edit.newText,
                })),
              ),
            );
        }
        return require("./projected-format")(editor, projection, context);
      },
      isFeatureAvailable(feature, editor) {
        if (!editor || !isIpython(editor)) return true;
        return feature !== "format" || Boolean(owner.ipythonSource);
      },
      transformDocumentText(text, { editor }) {
        if (isIpython(editor))
          throw new Error("IPython documents require the shared source projection");
        return sourceTransform.transform(text, {
          maskMagic: false,
          useNoqa: setting("useNoqa"),
          isComment: (position) =>
            editor
              .scopeDescriptorForBufferPosition(position)
              .getScopesArray()
              .some((scope) => scope.includes("comment")),
        });
      },
      restoreDocumentText(text) {
        return sourceTransform.restoreNoqa(text);
      },
    };

    const registration = service.registerAdapter(adapter);
    this.refreshProjectDiagnostics();
    return new Disposable(() => {
      registration.dispose();
      if (this.ideClient === service) {
        this.ideClient = null;
        this.refreshProjectDiagnostics();
      }
    });
  },
};

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Range, TextBuffer } = require("lumine");
let main;
const { findOnPath } = require("../lib/server");
const { LiveLspClient, fileUri } = require("./helpers/live-lsp-client");

const serverPath = process.env.RUFF_PATH || findOnPath("ruff");
const liveSuite = serverPath ? describe : () => {};

liveSuite("ide-ruff native server", () => {
  let adapter, client, disposable, rootPath, formatEditor, projectionRegistration;
  let originalTimeout;

  beforeEach(async () => {
    jasmine.useRealClock();
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ide-ruff-live-"));
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
    lumine.config.set("ide-ruff.serverPath", serverPath);
    disposable = main.consumeIdeClient({
      registerAdapter(registered) {
        adapter = registered;
        return { dispose() {} };
      },
      reportMissingServer() {},
    });
    client = new LiveLspClient(adapter, rootPath);
  });

  afterEach(async () => {
    formatEditor?.destroy();
    formatEditor = null;
    projectionRegistration?.dispose();
    projectionRegistration = null;
    await client.stop();
    disposable.dispose();
    lumine.config.unset("ide-ruff.serverPath");
    await lumine.packages.deactivatePackage("ide-ruff");
    fs.rmSync(rootPath, { recursive: true, force: true });
    jasmine.DEFAULT_TIMEOUT_INTERVAL = originalTimeout;
  });

  it("keeps ordinary Python undefined-name diagnostics while serving Ruff features", async () => {
    const { capabilities, serverInfo } = await client.start();
    expect(serverInfo.name.toLowerCase()).toContain("ruff");
    expect(capabilities.diagnosticProvider.identifier).toBe("Ruff");
    const formatting =
      capabilities.documentFormattingProvider ||
      (await client.registrationFor("textDocument/formatting"));
    expect(formatting).toBeTruthy();
    expect(capabilities.hoverProvider).toBe(true);

    const uri = fileUri(path.join(rootPath, "history.py"));
    client.open(uri, "value=1\nprint(_)\n");
    const report = await client.request("textDocument/diagnostic", {
      textDocument: { uri },
    });
    expect(report.items.some(({ code }) => code === "F821")).toBe(true);
    expect(
      await client.request("textDocument/formatting", {
        textDocument: { uri },
        options: { tabSize: 4, insertSpaces: true },
      }),
    ).toEqual(jasmine.any(Array));
  });

  it("keeps a query-URI formatting document separate from the real IPython path", async () => {
    await client.start();
    const hostUri = fileUri(path.join(rootPath, "document.ipy"));
    const temporary = new URL(hostUri);
    temporary.searchParams.set("lumine-ruff-format", "live-proof");
    client.open(hostUri, "host_value = 1\nmissing_host_name\n");
    client.open(temporary.href, "block_value=1\n");
    try {
      const edits = await client.request("textDocument/formatting", {
        textDocument: { uri: temporary.href },
        options: { tabSize: 4, insertSpaces: true },
      });
      expect(edits.length).toBeGreaterThan(0);
      expect(edits.some((edit) => edit.newText.includes("block_value = 1"))).toBe(true);
      const report = await client.request("textDocument/diagnostic", {
        textDocument: { uri: hostUri },
      });
      expect(
        report.items.some(
          (diagnostic) =>
            diagnostic.code === "F821" && diagnostic.message.includes("missing_host_name"),
        ),
      ).toBe(true);
    } finally {
      client.connection.sendNotification("textDocument/didClose", {
        textDocument: { uri: temporary.href },
      });
    }
    const after = await client.request("textDocument/diagnostic", {
      textDocument: { uri: hostUri },
    });
    expect(after.items.some((diagnostic) => diagnostic.code === "F821")).toBe(true);
  });

  it("applies the real Ruff single-edit response without a scratch buffer and keeps trailing bytes", async () => {
    await client.start();
    const source = "# preserved header\r\nvalue='😀'; result=1\r\n";
    const uri = fileUri(path.join(rootPath, "single-edit.py"));
    client.open(uri, source);
    const edits = await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 4, insertSpaces: true },
    });
    expect(edits.length).toBe(1);
    const reference = new TextBuffer({ text: source });
    try {
      const change = edits[0];
      reference.setTextInRange(
        [
          [change.range.start.line, change.range.start.character],
          [change.range.end.line, change.range.end.character],
        ],
        change.newText,
        { normalizeLineEndings: false },
      );
      const constructed = spyOn(TextBuffer.prototype, "setHistoryProvider").and.callThrough();
      const formatted = require("../lib/server-edits")(source, edits);
      expect(constructed).not.toHaveBeenCalled();
      expect(formatted).toBe(reference.getText());
      expect(formatted).toContain("result = 1");
      expect(formatted).toContain("😀");
      expect(formatted.endsWith("\r\n")).toBe(true);
    } finally {
      reference.destroy();
    }
  });

  it("formats canonical cells through the real host URI with one request and exact headers", async () => {
    await lumine.packages.activatePackage("language-ipython");
    projectionRegistration = main.consumeIpythonSource(
      lumine.packages.getActivePackage("language-ipython").mainModule.provideIPythonSource(),
    );
    const filePath = path.join(rootPath, "canonical.ipy"),
      source = "# %% One\r\nfirst=1\r\n# %% Two\r\nlast=2\r\n";
    formatEditor = await lumine.workspace.open(filePath);
    formatEditor.setText(source);
    lumine.grammars.assignLanguageMode(formatEditor.getBuffer(), "source.python.ipy");
    await formatEditor.whenGrammarSettled();
    const projection = await adapter.getDocumentProjection(formatEditor),
      uri = fileUri(filePath);
    await client.start();
    client.open(uri, projection.text);
    let requests = 0;
    const session = {
      rootPath,
      request(method, params) {
        requests++;
        expect(params.textDocument.uri).toBe(uri);
        return client.request(method, params);
      },
      withTemporaryDocument() {
        throw new Error("No canonical temporary document expected");
      },
    };
    const result = await adapter.formatProjectedDocument(formatEditor, projection, {
      method: "file",
      session,
      uri,
      options: { tabSize: 4, insertSpaces: true },
    });
    expect(requests).toBe(1);
    expect(result).not.toBeNull();
    expect(result.text).toContain("# %% One\r\nfirst = 1\r\n# %% Two\r\nlast = 2\r\n");
    expect(result.isCurrent()).toBe(true);
    formatEditor.setTextInBufferRange(
      [
        [1, 0],
        [1, 0],
      ],
      "changed = 3\r\n",
    );
    expect(result.isCurrent()).toBe(false);
  });

  it("retains native notebook Python under %%time while excluding Markdown", async () => {
    await client.start();
    const uri = fileUri(path.join(rootPath, "notebook.ipynb"));
    const cellPrefix = `vscode-notebook-cell:${uri.slice("file:".length)}`;
    const codeUri = `${cellPrefix}#code`;
    const markdownUri = `${cellPrefix}#markdown`;
    const plainUri = `${cellPrefix}#plain`;
    const reports = new Map();
    client.connection.onNotification(
      "textDocument/publishDiagnostics",
      ({ uri: documentUri, diagnostics }) => reports.set(documentUri, diagnostics),
    );
    await client.connection.sendNotification("notebookDocument/didOpen", {
      notebookDocument: {
        uri,
        notebookType: "jupyter-notebook",
        version: 1,
        metadata: { language_info: { name: "python" } },
        cells: [
          { kind: 1, document: markdownUri },
          { kind: 2, document: codeUri },
          { kind: 2, document: plainUri },
        ],
      },
      cellTextDocuments: [
        { uri: markdownUri, languageId: "markdown", version: 1, text: "missing_markdown_name\n" },
        { uri: codeUri, languageId: "python", version: 1, text: "%%time\nmissing_body_name\n" },
        { uri: plainUri, languageId: "python", version: 1, text: "missing_plain_name\n" },
      ],
    });
    const deadline = Date.now() + 2000;
    do {
      if (
        reports
          .get(plainUri)
          ?.some((diagnostic) => diagnostic.message.includes("missing_plain_name")) &&
        reports.get(codeUri)?.some((diagnostic) => diagnostic.message.includes("missing_body_name"))
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    expect(
      reports
        .get(plainUri)
        ?.some((diagnostic) => diagnostic.message.includes("missing_plain_name")),
    ).toBe(true);
    const diagnostics = reports.get(codeUri) || [];
    const missing = diagnostics.find((diagnostic) => diagnostic.code === "F821");
    expect(missing.message).toContain("missing_body_name");
    expect(missing.range.start.line).toBe(1);
    expect(
      diagnostics.some((diagnostic) => diagnostic.message.includes("missing_markdown_name")),
    ).toBe(false);
  });

  it("formats actual AST blocks through the configured Ruff session without changing magic or raw source", async () => {
    await lumine.packages.activatePackage("language-ipython");
    projectionRegistration = main.consumeIpythonSource(
      lumine.packages.getActivePackage("language-ipython").mainModule.provideIPythonSource(),
    );
    const filePath = path.join(rootPath, "format.ipy");
    formatEditor = await lumine.workspace.open(filePath);
    const source = "# %% [raw]\nraw <😀>\n# %%\n%%time -q\nvalue=1\n%pwd\n";
    formatEditor.setText(source);
    lumine.grammars.assignLanguageMode(formatEditor.getBuffer(), "source.python.ipy");
    await formatEditor.whenGrammarSettled();
    const projection = await adapter.getDocumentProjection(formatEditor);
    await client.start();
    client.open(fileUri(filePath), projection.text);
    const opened = [];
    const session = {
      rootPath,
      request: (method, params) => client.request(method, params),
      async withTemporaryDocument(item, callback) {
        opened.push(item.uri);
        await client.connection.sendNotification("textDocument/didOpen", {
          textDocument: { ...item, version: 1 },
        });
        try {
          return await callback(item.uri);
        } finally {
          await client.connection.sendNotification("textDocument/didClose", {
            textDocument: { uri: item.uri },
          });
        }
      },
    };
    const edits = await adapter.formatProjectedDocument(formatEditor, projection, {
      method: "file",
      options: { tabSize: 4, insertSpaces: true },
      session,
    });
    expect(edits.length).toBeGreaterThan(0);
    for (const edit of edits.sort((a, b) => b.oldRange.start.compare(a.oldRange.start)))
      formatEditor.setTextInBufferRange(edit.oldRange, edit.newText);
    expect(formatEditor.getText()).toBe(source.replace("value=1", "value = 1"));
    expect(opened.length).toBeGreaterThan(0);
    expect(
      opened.every((uri) => new URL(uri).pathname === new URL(fileUri(filePath)).pathname),
    ).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("formats a multi-cell batch with the real server and retains docstrings, imports and opaque bytes", async () => {
    await lumine.packages.activatePackage("language-ipython");
    projectionRegistration = main.consumeIpythonSource(
      lumine.packages.getActivePackage("language-ipython").mainModule.provideIPythonSource(),
    );
    const filePath = path.join(rootPath, "batch.ipy");
    formatEditor = await lumine.workspace.open(filePath);
    const source =
      '# %% Documentation\n"""Module documentation."""\nfrom __future__ import annotations\nfirst=1\n# %% [raw]\nraw <😀>\n# %% Timed\n%%time -q\nvalue=1\n%pwd\n# %% Final\nlast=2\n';
    formatEditor.setText(source);
    lumine.grammars.assignLanguageMode(formatEditor.getBuffer(), "source.python.ipy");
    await formatEditor.whenGrammarSettled();
    const projection = await adapter.getDocumentProjection(formatEditor);
    await client.start();
    let opened = 0,
      requests = 0;
    const session = {
      rootPath,
      request(method, params) {
        requests++;
        return client.request(method, params);
      },
      async withTemporaryDocument(item, callback) {
        opened++;
        await client.connection.sendNotification("textDocument/didOpen", {
          textDocument: { ...item, version: 1 },
        });
        try {
          return await callback(item.uri);
        } finally {
          await client.connection.sendNotification("textDocument/didClose", {
            textDocument: { uri: item.uri },
          });
        }
      },
    };
    const edits = await adapter.formatProjectedDocument(formatEditor, projection, {
      method: "file",
      options: { tabSize: 4, insertSpaces: true },
      session,
    });
    expect(edits).not.toBeNull();
    for (const edit of edits.sort((a, b) => b.oldRange.start.compare(a.oldRange.start)))
      formatEditor.setTextInBufferRange(edit.oldRange, edit.newText);
    const formatted = formatEditor.getText();
    expect(opened).toBe(1);
    expect(requests).toBe(1);
    expect(formatted).toContain('"""Module documentation."""');
    expect(formatted).toContain("from __future__ import annotations");
    expect(formatted).toContain("first = 1");
    expect(formatted).toContain("value = 1");
    expect(formatted).toContain("last = 2");
    expect(formatted).toContain("# %% [raw]\nraw <😀>\n# %% Timed\n%%time -q\n");
    expect(formatted).toContain("%pwd\n");
    expect(formatted).not.toContain("__lumine_ipy_batch_");
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("analyzes one Python document across cells without linting Markdown fences or raw bodies", async () => {
    await lumine.packages.activatePackage("language-ipython");
    projectionRegistration = main.consumeIpythonSource(
      lumine.packages.getActivePackage("language-ipython").mainModule.provideIPythonSource(),
    );
    lumine.config.set("ide-ruff.lint.select", ["F401", "F821"]);
    const filePath = path.join(rootPath, "shared.ipy");
    formatEditor = await lumine.workspace.open(filePath);
    formatEditor.setText(
      "# %% Setup\nimport math\nshared = 9\n# %% [markdown] Notes\n```python\nfenced_only = missing_from_markdown\n```\n# %% [raw]\nraw <bytes>\n# %% Use\nresult = math.sqrt(shared)\nundefined_real\n",
    );
    lumine.grammars.assignLanguageMode(formatEditor.getBuffer(), "source.python.ipy");
    await formatEditor.whenGrammarSettled();
    const projection = await adapter.getDocumentProjection(formatEditor);
    await client.start();
    const uri = fileUri(filePath);
    client.open(uri, projection.text);
    const report = await client.request("textDocument/diagnostic", { textDocument: { uri } });
    expect(report.items.some((item) => item.code === "F401")).toBe(false);
    const undefinedNames = report.items.filter((item) => item.code === "F821");
    expect(undefinedNames.length).toBe(1);
    const missing = undefinedNames[0];
    expect(missing.message).toContain("undefined_real");
    expect(missing.range.start.line).toBe(11);
    expect(projection.fromServerRange(new Range([11, 0], [11, 14])).start.row).toBe(11);
    expect(projection.text).not.toContain("missing_from_markdown");
    expect(projection.text).not.toContain("raw <bytes>");
  });
});

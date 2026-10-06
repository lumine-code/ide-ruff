const path = require("path");
const { Range, TextBuffer } = require("lumine");

describe("Ruff adapter with the real IPython AST projection", () => {
  let editor, main, adapter, registration, adapterRegistration, applyFormatResult;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage("language-ipython");
    const formatPackage = await lumine.packages.activatePackage("code-format");
    ({ applyEdits: applyFormatResult } = require(
      path.join(formatPackage.path, "lib", "apply-edits"),
    ));
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
    registration = main.consumeIpythonSource(
      lumine.packages.getActivePackage("language-ipython").mainModule.provideIPythonSource(),
    );
    adapterRegistration = main.consumeIde({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
    });
    editor = await lumine.workspace.open("mixed-ide-ruff.ipy");
    editor.setText(
      "# %% [raw]\nraw <body>\n# %%\n%%time -q\nvalue=1\n%pwd\n# %%\n%%bash -e\necho 'foreign'\n",
    );
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python.ipy");
    await editor.whenGrammarSettled();
  });
  afterEach(async () => {
    registration?.dispose();
    adapterRegistration?.dispose();
    editor?.destroy();
    await lumine.packages.deactivatePackage("code-format");
  });
  it("shares the real Python-only text and restores magics through safe formatting blocks", async () => {
    const source = editor.getText();
    const projection = await adapter.getDocumentProjection(editor);
    expect(projection.text).toContain("value=1");
    for (const hidden of ["raw <", "%%time", "%pwd", "echo 'foreign'"])
      expect(projection.text).not.toContain(hidden);
    let current,
      active = 0,
      maximum = 0;
    const session = {
      rootPath: path.resolve(__dirname),
      async withTemporaryDocument(item, callback) {
        current = item;
        active++;
        maximum = Math.max(maximum, active);
        try {
          return await callback(item.uri);
        } finally {
          active--;
        }
      },
      async request() {
        const lines = current.text.split("\n");
        return [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: lines.length - 1, character: lines.at(-1).length },
            },
            newText: current.text.replace("value=1", "value = 1"),
          },
        ];
      },
    };
    const edits = await adapter.formatProjectedDocument(editor, projection, {
      method: "file",
      session,
      options: {},
    });
    expect(edits.length).toBeGreaterThan(0);
    expect(maximum).toBe(1);
    expect(active).toBe(0);
    for (const edit of edits.sort((a, b) => b.oldRange.start.compare(a.oldRange.start)))
      editor.setTextInBufferRange(edit.oldRange, edit.newText);
    expect(editor.getText()).toBe(source.replace("value=1", "value = 1"));
  });
  it("rejects an edit that crosses a protected magic header", async () => {
    const projection = await adapter.getDocumentProjection(editor);
    expect(
      projection.mapEdits([{ oldRange: new Range([3, 0], [4, 7]), newText: "value = 2" }]),
    ).toBeNull();
  });

  it("formats 1000 code cells in one temporary document and one backend request", async () => {
    const source = Array.from(
      { length: 1000 },
      (_, index) => `# %% Cell ${index}\nvalue_${index}=1\n`,
    ).join("");
    editor.setText(source);
    await editor.whenGrammarSettled();
    const projection = await adapter.getDocumentProjection(editor);
    let current,
      opened = 0,
      requests = 0;
    const session = {
      rootPath: path.resolve(__dirname),
      async withTemporaryDocument(item, callback) {
        opened++;
        current = item;
        return callback(item.uri);
      },
      async request() {
        requests++;
        const lines = current.text.split("\n");
        return [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: lines.length - 1, character: lines.at(-1).length },
            },
            newText: current.text.replaceAll("=1", " = 1"),
          },
        ];
      },
    };
    const nativeDiff = spyOn(TextBuffer.prototype, "getChangesToText").and.callThrough();
    const edits = await adapter.formatProjectedDocument(editor, projection, {
      method: "file",
      session,
      options: {},
    });
    expect(opened).toBe(1);
    expect(requests).toBe(1);
    expect(nativeDiff).not.toHaveBeenCalled();
    expect(new Set(edits.edits.map((edit) => edit.oldRange.start.row)).size).toBe(1000);
    const replacement = spyOn(editor, "setText").and.callThrough();
    applyFormatResult(editor, edits);
    expect(replacement).toHaveBeenCalledTimes(1);
    await editor.whenGrammarSettled();
    expect(editor.getText()).toBe(source.replaceAll("=1", " = 1"));
  });

  it("formats canonical Python on the existing host and rejects protected or stale responses", async () => {
    const source = "# %% One\r\nfirst=1\r\n# %% Two\r\nlast=2\r\n";
    editor.setText(source);
    await editor.whenGrammarSettled();
    const projection = await adapter.getDocumentProjection(editor),
      uri = "file:///canonical-host.ipy";
    expect(projection.isIdentity).toBe(true);
    const calls = [];
    let response = source.replaceAll("=", " = "),
      changeSelection = false;
    const session = {
      async request(method, params) {
        calls.push({ method, uri: params.textDocument.uri });
        if (changeSelection) editor.setCursorBufferPosition([1, 1]);
        return [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 4, character: 0 } },
            newText: response,
          },
        ];
      },
      withTemporaryDocument() {
        throw new Error("Canonical host must not open a temporary document");
      },
    };
    const result = await adapter.formatProjectedDocument(editor, projection, {
      method: "file",
      session,
      uri,
      options: {},
    });
    expect(calls).toEqual([{ method: "textDocument/formatting", uri }]);
    expect(result.text).toBe(response);
    response = response.replace("# %% One", "# %% Changed");
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "file",
        session,
        uri,
        options: {},
      }),
    ).toBeNull();
    response = source.replaceAll("=", " = ");
    changeSelection = true;
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "file",
        session,
        uri,
        options: {},
      }),
    ).toBeNull();
    expect(editor.getText()).toBe(source);
  });

  it("keeps changed wire/noqa text and partial requests on guarded temporary formatting", async () => {
    const source = "# %% One\nfirst=1\n# %% Two\nlast=2\n";
    editor.setText(source);
    await editor.whenGrammarSettled();
    const projection = await adapter.getDocumentProjection(editor);
    const wireChanged = Object.freeze(
      Object.defineProperty(Object.create(projection), "text", {
        value: source.replace("first=1", "first=1 # noqa"),
      }),
    );
    let opened = 0;
    const session = {
      async withTemporaryDocument(item, callback) {
        opened++;
        return callback("file:///temporary.ipy?format");
      },
      async request(method, params) {
        expect(params.textDocument.uri).toBe("file:///temporary.ipy?format");
        return [];
      },
    };
    expect(
      await adapter.formatProjectedDocument(editor, wireChanged, {
        method: "file",
        session,
        uri: "file:///host.ipy",
        options: {},
      }),
    ).not.toBeNull();
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "range",
        range: new Range([1, 0], [1, 7]),
        session,
        uri: "file:///host.ipy",
        options: {},
      }),
    ).not.toBeNull();
    expect(opened).toBe(2);
    const original = editor.getText();
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "file",
        session,
        uri: "file:///host.ipy",
        options: {},
        signal: aborted.signal,
      }),
    ).toBeNull();
    expect(opened).toBe(2);
    expect(editor.getText()).toBe(original);
  });

  it("preserves guarded multiple reversed selections when applying Python-only edits", async () => {
    const source = "#%% One\r\nfirst=1; chosen=2\r\n#%% Two\r\nother=3\r\n";
    editor.setText(source);
    await editor.whenGrammarSettled();
    editor.getBuffer().clearUndoStack();
    editor.setSelectedBufferRanges([new Range([0, 0], [0, 7]), new Range([1, 9], [1, 15])]);
    editor.getSelections()[1].setBufferRange(new Range([1, 9], [1, 15]), { reversed: true });
    const projection = await adapter.getDocumentProjection(editor);
    let document;
    const session = {
      rootPath: path.resolve(__dirname),
      async withTemporaryDocument(item, callback) {
        document = item;
        return callback(item.uri);
      },
      async request() {
        const lines = document.text.split("\n");
        return [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: lines.length - 1, character: lines.at(-1).length },
            },
            newText: document.text.replaceAll("=", " = "),
          },
        ];
      },
    };
    const diff = spyOn(TextBuffer.prototype, "getChangesToText").and.callThrough();
    const edits = await adapter.formatProjectedDocument(editor, projection, {
      method: "file",
      session,
      options: {},
    });
    expect(diff).toHaveBeenCalledTimes(1);
    applyFormatResult(editor, edits);
    expect(editor.getSelections().map((selection) => selection.getText())).toEqual([
      "#%% One",
      "chosen ",
    ]);
    expect(editor.getSelections()[1].isReversed()).toBe(true);
    expect(editor.getText()).toBe(source.replaceAll("=", " = "));
    editor.undo();
    expect(editor.getText()).toBe(source);
    editor.redo();
    expect(editor.getText()).toBe(source.replaceAll("=", " = "));
  });
});

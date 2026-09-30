const path = require("path");
const { Range } = require("lumine");

describe("Ruff adapter with the real IPython AST projection", () => {
  let editor, main, adapter, registration, adapterRegistration;
  beforeEach(async () => {
    jasmine.useRealClock();
    await lumine.packages.activatePackage(path.resolve(__dirname, "..", "..", "language-ipython"));
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
    registration = main.consumeIpythonSource(
      lumine.packages.getActivePackage("language-ipython").mainModule.provideIPythonSource(),
    );
    adapterRegistration = main.consumeIdeClient({
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
  afterEach(() => {
    registration.dispose();
    adapterRegistration.dispose();
    editor.destroy();
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
    const edits = await adapter.formatProjectedDocument(editor, projection, {
      method: "file",
      session,
      options: {},
    });
    expect(opened).toBe(1);
    expect(requests).toBe(1);
    expect(new Set(edits.map((edit) => edit.oldRange.start.row)).size).toBe(1000);
    for (const edit of edits.sort((a, b) => b.oldRange.start.compare(a.oldRange.start)))
      editor.setTextInBufferRange(edit.oldRange, edit.newText);
    expect(editor.getText()).toBe(source.replaceAll("=1", " = 1"));
  });
});

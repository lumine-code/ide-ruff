const path = require("path");
const { Range, Point } = require("lumine");

describe("Ruff shared IPython projection", () => {
  let main, adapter, editor, serviceRegistration, adapterRegistration;
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
    await lumine.packages.activatePackage("language-python");
    adapterRegistration = main.consumeIdeClient({
      registerAdapter(value) {
        adapter = value;
        return { dispose() {} };
      },
    });
    editor = await lumine.workspace.open("ruff-projection.ipy");
    spyOn(editor, "getGrammar").and.returnValue({ scopeName: "source.python.ipy" });
    editor.setText("# %% [raw]\nopaque <bytes>\n# %%\nx=1\n");
  });
  afterEach(() => {
    serviceRegistration?.dispose();
    serviceRegistration = null;
    adapterRegistration.dispose();
    editor.destroy();
  });
  function snapshot(overrides = {}) {
    const source = editor.getText();
    const value = {
      source,
      text: "# %% [raw]\n              \n# %%\nx=1\n",
      isCurrent: () => !editor.isDestroyed() && editor.getText() === source,
      isPythonPosition: (point) => point.row === 3,
      fromServerPosition: (point) => point,
      mapEdits: (edits) => edits,
      getFormattingBlocks: async () => [
        { range: new Range([3, 0], [4, 0]), text: "x=1\n", restore: (formatted) => formatted },
      ],
      ...overrides,
    };
    value.getFormattingBatch ??= async () => {
      const blocks = await value.getFormattingBlocks();
      return {
        text: blocks[0].text,
        restore(formatted) {
          const text = blocks[0].restore(formatted);
          return text === null ? null : [{ range: blocks[0].range, text }];
        },
      };
    };
    return Object.freeze(value);
  }
  function register(value) {
    const project = jasmine.createSpy("project").and.resolveTo(value);
    serviceRegistration = main.consumeIpythonSource({ isApplicable: () => true, project });
    return project;
  }

  it("requests the passive shared projection instead of classifying source with regex", async () => {
    const projection = snapshot();
    const project = register(projection);
    expect(adapter.needsDocumentTransform(editor)).toBe(true);
    expect(await adapter.getDocumentProjection(editor)).toBe(projection);
    expect(project).toHaveBeenCalledWith(editor, { signal: undefined });
    expect(() => adapter.transformDocumentText(editor.getText(), { editor })).toThrow();
  });

  it("fails closed when the AST projection provider is absent", async () => {
    main.ipythonSource = null;
    const warnings = spyOn(lumine.notifications, "addWarning");
    expect(await adapter.getDocumentProjection(editor)).toBeNull();
    expect(await adapter.getDocumentProjection(editor)).toBeNull();
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary Python incremental unless the existing noqa policy needs a transform", async () => {
    editor.getGrammar.and.returnValue({ scopeName: "source.python" });
    spyOn(editor, "getPath").and.returnValue("ordinary.py");
    lumine.config.set("ide-ruff.useNoqa", true);
    expect(adapter.needsDocumentTransform(editor)).toBe(false);
    lumine.config.set("ide-ruff.useNoqa", false);
    editor.setText("x = 1 # noqa\n");
    lumine.grammars.assignLanguageMode(editor.getBuffer(), "source.python");
    await editor.whenGrammarSettled();
    expect(adapter.needsDocumentTransform(editor)).toBe(true);
    const projection = await adapter.getDocumentProjection(editor);
    expect(projection.text.length).toBe(projection.source.length);
    expect(projection.text).not.toContain("noqa");
    const edits = projection.mapEdits([
      { oldRange: new Range([0, 0], [1, 0]), newText: projection.text },
    ]);
    expect(edits[0].newText).toBe(projection.source);
    expect(projection.fromServerPosition(new Point(0, 4))).toEqual(new Point(0, 4));
    const request = jasmine.createSpy("format request").and.resolveTo([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
        newText: projection.text.replace("x = 1", "x = 2"),
      },
    ]);
    const formatted = await adapter.formatProjectedDocument(editor, projection, {
      method: "file",
      uri: "file:///ordinary.py",
      options: {},
      session: { request },
    });
    expect(request.calls.mostRecent().args[1].textDocument.uri).toBe("file:///ordinary.py");
    expect(formatted[0].newText).toBe("x = 2 # noqa\n");
  });

  function formattingSession(beforeReply = () => {}) {
    const calls = [];
    let active = 0,
      maximum = 0,
      current;
    const session = {
      rootPath: path.resolve(__dirname),
      async withTemporaryDocument(item, callback) {
        active++;
        maximum = Math.max(maximum, active);
        current = item;
        calls.push({ method: "open", item });
        try {
          return await callback(item.uri);
        } finally {
          calls.push({ method: "close", uri: item.uri });
          active--;
        }
      },
      async request(method, params) {
        beforeReply();
        calls.push({ method, params });
        return [
          {
            range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
            newText: current.text.replace("x=1", "x = 1"),
          },
        ];
      },
    };
    return { session, calls, maximum: () => maximum, active: () => active };
  }

  it("formats isolated blocks in the same session and leaves opaque source unchanged", async () => {
    const projection = snapshot();
    register(projection);
    const test = formattingSession();
    const edits = await adapter.formatProjectedDocument(editor, projection, {
      method: "file",
      session: test.session,
      options: { tabSize: 4, insertSpaces: true },
    });
    expect(edits.length).toBeGreaterThan(0);
    expect(edits.every((edit) => new Range([3, 0], [4, 0]).containsRange(edit.oldRange))).toBe(
      true,
    );
    expect(test.calls[0].item.languageId).toBe("python");
    expect(test.calls[0].item.uri).toContain("lumine-ruff-format");
    expect(test.maximum()).toBe(1);
    expect(test.active()).toBe(0);
    expect(test.calls.at(-1).method).toBe("close");
    expect(editor.getText()).toBe(projection.source);
  });

  it("returns no edits when the user changes source and still closes its temporary document", async () => {
    const projection = snapshot();
    register(projection);
    const test = formattingSession(() => editor.setText("user content"));
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "file",
        session: test.session,
        options: {},
      }),
    ).toBeNull();
    expect(test.active()).toBe(0);
    expect(editor.getText()).toBe("user content");
  });

  it("starts no temporary document when source changes during lazy block preparation", async () => {
    let release, started;
    const blocks = new Promise((resolve) => {
      release = resolve;
    });
    const preparing = new Promise((resolve) => {
      started = resolve;
    });
    const projection = snapshot({
      getFormattingBlocks: () => {
        started();
        return blocks;
      },
    });
    const test = formattingSession();
    const pending = adapter.formatProjectedDocument(editor, projection, {
      method: "file",
      session: test.session,
      options: {},
    });
    await preparing;
    editor.setText("user content");
    release([{ range: new Range([3, 0], [4, 0]), text: "x=1\n", restore: (text) => text }]);
    expect(await pending).toBeNull();
    expect(test.calls.length).toBe(0);
    expect(editor.getText()).toBe("user content");
  });

  it("returns no partial edits when a formatting block cannot restore protected syntax", async () => {
    const projection = snapshot({
      getFormattingBlocks: async () => [
        { range: new Range([3, 0], [4, 0]), text: "x=1\n", restore: () => null },
      ],
    });
    register(projection);
    const test = formattingSession();
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "file",
        session: test.session,
        options: {},
      }),
    ).toBeNull();
    expect(editor.getText()).toBe(projection.source);
    expect(test.active()).toBe(0);
  });

  it("honours the client invocation guard before starting formatting work", async () => {
    const projection = snapshot();
    const test = formattingSession();
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "file",
        session: test.session,
        options: {},
        isInvocationCurrent: () => false,
      }),
    ).toBeNull();
    expect(test.calls.length).toBe(0);
    expect(editor.getText()).toBe(projection.source);
  });

  it("rejects malformed and overlapping server edits before restoring a block", async () => {
    const projection = snapshot();
    const test = formattingSession();
    test.session.request = async () => [
      {
        range: { start: { line: 0, character: 0 }, end: { line: 9, character: 0 } },
        newText: "corrupted",
      },
    ];
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "file",
        session: test.session,
        options: {},
      }),
    ).toBeNull();
    test.session.request = async () => [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } }, newText: "a" },
      { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 3 } }, newText: "b" },
    ];
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "file",
        session: test.session,
        options: {},
      }),
    ).toBeNull();
    expect(test.active()).toBe(0);
    expect(editor.getText()).toBe(projection.source);
  });

  it("cancels source edits when the selection changes during formatting", async () => {
    const projection = snapshot();
    const test = formattingSession(() =>
      editor.setSelectedBufferRange([
        [3, 0],
        [3, 1],
      ]),
    );
    expect(
      await adapter.formatProjectedDocument(editor, projection, {
        method: "range",
        range: new Range([3, 0], [4, 0]),
        session: test.session,
        options: {},
      }),
    ).toBeNull();
    expect(test.active()).toBe(0);
    expect(editor.getText()).toBe(projection.source);
  });
});

const { resolver } = require("./helpers/server-resolver");
const fs = require("fs").promises;
const path = require("path");
const os = require("os");
const { Point } = require("lumine");

describe("Ruff project scanner", () => {
  let main, scanner, directory, delegate, registration, editor, resolverRegistration;
  beforeEach(async () => {
    jasmine.useRealClock();
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "ide-ruff-scan-"));
    delegate = {
      dispose: jasmine.createSpy("dispose delegate"),
      setAllMessages: jasmine.createSpy("publish"),
    };
    registration = main.consumeLinterRegistry(() => delegate);
    delegate.setAllMessages.calls.reset();
    scanner = main.ensureProjectScanner();
    spyOn(main, "resolveScanServer").and.resolveTo({ command: "ruff" });
  });
  afterEach(async () => {
    editor?.destroy();
    editor = null;
    registration?.dispose();
    registration = null;
    resolverRegistration?.dispose();
    resolverRegistration = null;
    await lumine.packages.deactivatePackage("ide-ruff");
    await fs.rm(directory, { force: true, recursive: true });
  });

  it("uses the client's resolver for the scanner's managed executable", async () => {
    main.resolveScanServer.and.callThrough();
    const managed = { binaryPath: process.execPath, version: "test-version" };
    const managedServer = jasmine.createSpy("managed installation").and.returnValue(managed);
    const getServerResolver = jasmine.createSpy("get resolver").and.returnValue(resolver);
    const edge = main.consumeIde({
      registerAdapter: () => ({ dispose() {} }),
      getServerResolver,
      managedServer,
    });
    spyOn(resolver, "select").and.resolveTo({
      path: process.execPath,
      kind: "executable",
      source: "managed",
      version: managed.version,
    });
    try {
      expect(await main.resolveScanServer()).toEqual({
        command: process.execPath,
        args: ["server"],
        version: managed.version,
      });
      expect(getServerResolver).toHaveBeenCalledTimes(1);
      expect(managedServer).not.toHaveBeenCalled();
      const request = resolver.select.calls.mostRecent().args[0];
      expect(await request.managed()).toEqual({
        path: managed.binaryPath,
        version: managed.version,
      });
      expect(managedServer).toHaveBeenCalledOnceWith("ide-ruff");
    } finally {
      edge.dispose();
    }
  });

  it("uses a configured scanner executable without reading a damaged managed installation", async () => {
    main.resolveScanServer.and.callThrough();
    const managedServer = jasmine
      .createSpy("managed installation")
      .and.throwError("Damaged installation");
    resolverRegistration = main.consumeIde({
      registerAdapter: () => ({ dispose() {} }),
      getServerResolver: () => resolver,
      managedServer,
    });
    lumine.config.set("ide-ruff.serverPath", process.execPath);
    const launch = await main.resolveScanServer();
    expect(launch.command).toBe(process.execPath);
    expect(managedServer).not.toHaveBeenCalled();
  });

  it("reports managed corruption when the scanner has no configured executable", async () => {
    main.resolveScanServer.and.callThrough();
    const managedServer = jasmine
      .createSpy("managed installation")
      .and.throwError("Damaged installation");
    resolverRegistration = main.consumeIde({
      registerAdapter: () => ({ dispose() {} }),
      getServerResolver: () => resolver,
      managedServer,
    });
    lumine.config.set("ide-ruff.serverPath", "");
    await expectAsync(main.resolveScanServer()).toBeRejectedWithError("Damaged installation");
    expect(managedServer).toHaveBeenCalledOnceWith("ide-ruff");
  });

  it("explains a missing client before trying a project scan", async () => {
    main.resolveScanServer.and.callThrough();
    main.ide = null;
    spyOn(lumine.notifications, "addWarning");
    expect(await main.resolveScanServer()).toBeNull();
    const [title, options] = lumine.notifications.addWarning.calls.mostRecent().args;
    expect(title).toBe("Ruff requires ide");
    expect(options.detail).toContain("Enable ide");
  });

  const finding = (filename, extras = {}) => ({
    filename,
    code: "F821",
    message: "Undefined name",
    location: { row: 4, column: 1 },
    end_location: { row: 4, column: 6 },
    ...extras,
  });
  function projection(source, extras = {}) {
    return {
      source,
      text: "# %% [markdown]\n                 \n# %%\nvalue\n",
      isCurrent: () => true,
      fromCodePointPosition: (point) => point,
      fromServerRange: (range) => range,
      isPythonRange: (range) => range.start.row === 3,
      dispose: jasmine.createSpy("dispose projection"),
      ...extras,
    };
  }
  function fakeRuff(reply) {
    const calls = [];
    main.execFile = (command, args, options, callback) => {
      const call = { command, args, options, text: undefined };
      calls.push(call);
      queueMicrotask(async () => {
        try {
          callback(null, await reply(call), "");
        } catch (error) {
          callback(error, "", error.message);
        }
      });
      return {
        stdin: {
          end(text) {
            call.text = text;
          },
        },
      };
    };
    return calls;
  }
  function scanItems() {
    return [{ projectPath: directory, targetPaths: [directory] }];
  }

  it("scans discovered files and notebook cells without enabling autofix", async () => {
    const python = path.join(directory, "file.py");
    const notebook = path.join(directory, "book.ipynb");
    await fs.writeFile(python, "\n\n\nvalue\n");
    await fs.writeFile(
      notebook,
      JSON.stringify({
        cells: [
          { cell_type: "markdown", source: ["heading"] },
          { cell_type: "code", source: ["\n\n\nvalue\n"] },
        ],
      }),
    );
    lumine.config.set("ide-ruff.features.diagnostics", false);
    lumine.config.set("ide-ruff.lint.select", ["F"]);
    lumine.config.set("ide-ruff.lint.extendSelect", ["B"]);
    lumine.config.set("ide-ruff.lint.ignore", ["F401"]);
    lumine.config.set("ide-ruff.useNoqa", false);
    lumine.config.set("ide-ruff.configuration", path.join(directory, "ruff.toml"));
    lumine.config.set("ide-ruff.lineLength", 110);
    const calls = fakeRuff(({ args }) =>
      args.includes("--show-files")
        ? [python, notebook].join("\n")
        : JSON.stringify([finding(python), finding(notebook, { cell: 2 })]),
    );
    await scanner.runScan(scanItems());
    expect(calls.length).toBe(2);
    expect(calls[1].args).toContain(python);
    expect(calls[1].args).toContain(notebook);
    expect(calls[1].args).toContain("--no-fix");
    expect(calls[1].args).toContain("--no-fix-only");
    expect(calls[1].args).toContain("--ignore-noqa");
    expect(calls[1].args).toContain('lint.select = ["F"]');
    expect(calls[1].args).toContain('lint.extend-select = ["B"]');
    expect(calls[1].args).toContain('lint.ignore = ["F401"]');
    expect(calls[1].args).toContain("line-length = 110");
    expect(calls[1].args).toContain(path.join(directory, "ruff.toml"));
    expect(scanner.messages.length).toBe(2);
    expect(scanner.messages[1].location.cell).toBe(2);
    expect(scanner.notebookSnapshots.get(notebook)).toBe(await fs.readFile(notebook, "utf8"));
    expect(delegate.setAllMessages).toHaveBeenCalledWith(
      scanner.messages,
      { showProjectView: true },
      scanner.notebookSnapshots,
    );
  });

  it("maps raw Unicode columns against each Python or notebook cell snapshot", () => {
    const source = 'text = "😀"; missing_name\n';
    const notebook = JSON.stringify({
      cells: [
        { cell_type: "markdown", source: ["heading"] },
        { cell_type: "code", source: [source] },
      ],
    });
    const positions = { location: { row: 1, column: 13 }, end_location: { row: 1, column: 25 } };
    const messages = scanner.rawMessages(
      [finding("unicode.py", positions), finding("unicode.ipynb", { ...positions, cell: 2 })],
      new Map([
        ["unicode.py", source],
        ["unicode.ipynb", notebook],
      ]),
      main.scanSettings(),
    );
    expect(messages.length).toBe(2);
    expect(messages[0].location.position).toEqual([
      [0, 13],
      [0, 25],
    ]);
    expect(messages[1].location.position).toEqual([
      [0, 13],
      [0, 25],
    ]);
    expect(messages[1].location.cell).toBe(2);
  });

  it("rejects notebook findings and their snapshots when the disk changes during Ruff", async () => {
    const notebook = path.join(directory, "changed.ipynb");
    const source = JSON.stringify({ cells: [{ cell_type: "code", source: ["value\n"] }] });
    await fs.writeFile(notebook, source);
    fakeRuff(async ({ args }) => {
      if (args.includes("--show-files")) return notebook;
      await fs.writeFile(
        notebook,
        JSON.stringify({
          cells: [
            { cell_type: "markdown", source: ["inserted"] },
            { cell_type: "code", source: ["value\n"] },
          ],
        }),
      );
      return JSON.stringify([
        finding(notebook, {
          cell: 1,
          location: { row: 1, column: 1 },
          end_location: { row: 1, column: 6 },
        }),
      ]);
    });
    await scanner.runScan(scanItems());
    expect(scanner.messages).toEqual([]);
    expect(scanner.notebookSnapshots.size).toBe(0);
    expect(delegate.setAllMessages).toHaveBeenCalledWith(
      [],
      { showProjectView: true },
      scanner.notebookSnapshots,
    );
  });

  it("honors Ruff severities and the adapter's syntax-diagnostic switch", () => {
    const settings = main.scanSettings();
    expect(
      scanner.message("sample.py", finding("sample.py", { severity: "warning" }), settings)
        .severity,
    ).toBe("warning");
    expect(
      scanner.message("sample.py", finding("sample.py", { code: "invalid-syntax" }), {
        ...settings,
        showSyntaxErrors: false,
      }),
    ).toBeNull();
  });

  it("uses the selected Ruff executable and never rewrites Python or notebook files", async () => {
    const serverPath =
      process.env.RUFF_PATH || require("./helpers/server-resolver").findOnPath("ruff");
    if (!serverPath) {
      pending("Ruff is not installed");
      return;
    }
    main.resolveScanServer.and.callThrough();
    resolverRegistration = main.consumeIde({
      registerAdapter: () => ({ dispose() {} }),
      getServerResolver: () => resolver,
      managedServer: () => null,
    });
    main.execFile = require("child_process").execFile;
    lumine.config.set("ide-ruff.serverPath", serverPath);
    lumine.config.set("ide-ruff.lint.select", ["F401", "F821"]);
    const python = path.join(directory, "unicode.py");
    const notebook = path.join(directory, "unicode.ipynb");
    const source = 'import os\ntext = "😀"; missing_name\n';
    const notebookSource = JSON.stringify({
      cells: [
        { cell_type: "markdown", metadata: {}, source: ["heading"] },
        {
          cell_type: "code",
          metadata: {},
          source: source.split(/(?<=\n)/),
          outputs: [],
          execution_count: null,
        },
      ],
      metadata: { language_info: { name: "python" } },
      nbformat: 4,
      nbformat_minor: 5,
    });
    await fs.writeFile(python, source);
    await fs.writeFile(notebook, notebookSource);
    await fs.writeFile(path.join(directory, "ruff.toml"), "fix = true\n");
    await scanner.runScan(scanItems());
    expect(await fs.readFile(python, "utf8")).toBe(source);
    expect(await fs.readFile(notebook, "utf8")).toBe(notebookSource);
    const undefinedNames = scanner.messages.filter((message) =>
      message.excerpt.startsWith("F821:"),
    );
    expect(undefinedNames.length).toBe(2);
    for (const message of undefinedNames)
      expect(message.location.position).toEqual([
        [1, 13],
        [1, 25],
      ]);
    expect(undefinedNames.find((message) => message.location.file === notebook).location.cell).toBe(
      2,
    );
  });

  it("projects closed IPython files serially and uses the open buffer snapshot", async () => {
    const first = path.join(directory, "first.ipy");
    const second = path.join(directory, "second.ipy");
    const openPath = path.join(directory, "open.ipy");
    const source = "# %% [markdown]\n# Literal heading\n# %%\nvalue\n";
    await fs.writeFile(first, source);
    await fs.writeFile(second, source);
    editor = await lumine.workspace.open(openPath);
    editor.setText(source);
    let active = 0,
      maximum = 0;
    const closed = [];
    const snapshots = [];
    const project = jasmine.createSpy("project open").and.callFake(async () => projection(source));
    const service = main.consumeIpythonSource({
      isApplicable: () => true,
      project,
      async projectText(text, { filePath }) {
        closed.push(filePath);
        const value = projection(text);
        snapshots.push(value);
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return value;
      },
    });
    const calls = fakeRuff(({ args }) =>
      args.includes("--show-files")
        ? [first, openPath, second, first].join("\n")
        : JSON.stringify([
            finding(args.find((arg) => arg.startsWith("--stdin-filename=")).slice(17)),
          ]),
    );
    await scanner.runScan(scanItems());
    expect(closed).toEqual([first, second]);
    expect(maximum).toBe(1);
    expect(project).toHaveBeenCalled();
    expect(project.calls.mostRecent().args[0]).toBe(editor);
    expect(calls.length).toBe(4);
    for (const call of calls.slice(1)) {
      expect(call.text).toBe(projection(source).text);
      expect(call.args).toContain("--extension=ipy:python");
      expect(call.text).not.toContain("Literal heading");
    }
    for (const snapshot of snapshots) expect(snapshot.dispose).toHaveBeenCalledTimes(1);
    expect(scanner.messages.length).toBe(3);
    expect(editor.getText()).toBe(source);
    service.dispose();
  });

  it("maps projected codepoint positions and drops findings in protected source", () => {
    const convert = jasmine
      .createSpy("codepoints")
      .and.callFake((point) => new Point(point.row, point.column + 1));
    const value = projection("source", { fromCodePointPosition: convert });
    const messages = scanner.projectedMessages(
      "mixed.ipy",
      [
        finding("mixed.ipy"),
        finding("mixed.ipy", {
          location: { row: 2, column: 1 },
          end_location: { row: 2, column: 5 },
        }),
      ],
      value,
      main.scanSettings(),
    );
    expect(messages.length).toBe(1);
    expect(messages[0].location.position).toEqual([
      [3, 1],
      [3, 6],
    ]);
    expect(convert).toHaveBeenCalledTimes(4);
  });

  it("disposes closed snapshots and rejects results when the disk source changes", async () => {
    const filePath = path.join(directory, "closed.ipy");
    await fs.writeFile(filePath, "before");
    const value = projection("before");
    const service = main.consumeIpythonSource({ projectText: async () => value });
    fakeRuff(async () => {
      await fs.writeFile(filePath, "changed on disk");
      return JSON.stringify([finding(filePath)]);
    });
    const controller = new AbortController();
    expect(
      await scanner.scanIpython(filePath, "ruff", [], main.scanSettings(), controller.signal),
    ).toEqual([]);
    expect(value.dispose).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(filePath, "utf8")).toBe("changed on disk");
    service.dispose();
  });

  it("rejects open IPython results after edits, Save As or cancellation", async () => {
    editor = await lumine.workspace.open(path.join(directory, "open.ipy"));
    editor.setText("value\n");
    const service = main.consumeIpythonSource({
      isApplicable: () => true,
      project: async () => projection(editor.getText()),
    });
    for (const change of [
      () => editor.setText("changed"),
      () => editor.getBuffer().setPath(path.join(directory, "renamed.ipy")),
    ]) {
      fakeRuff(() => {
        change();
        return JSON.stringify([finding(editor.getPath())]);
      });
      const controller = new AbortController();
      expect(
        await scanner.scanIpython(
          editor.getPath(),
          "ruff",
          [],
          main.scanSettings(),
          controller.signal,
        ),
      ).toEqual([]);
    }
    const controller = new AbortController();
    fakeRuff(() => {
      controller.abort();
      return "[]";
    });
    expect(
      await scanner.scanIpython(
        editor.getPath(),
        "ruff",
        [],
        main.scanSettings(),
        controller.signal,
      ),
    ).toEqual([]);
    service.dispose();
  });

  it("never sends mixed IPython source when the projection service is absent", async () => {
    main.ipythonSource = null;
    const calls = fakeRuff(() => "[]");
    expect(
      await scanner.scanIpython(
        "absent.ipy",
        "ruff",
        [],
        main.scanSettings(),
        new AbortController().signal,
      ),
    ).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it("stops an in-flight process and publishes nothing after registry disposal", async () => {
    let release, began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const calls = fakeRuff(() => {
      began();
      return waiting;
    });
    const pending = scanner.runScan(scanItems());
    await started;
    registration.dispose();
    release(path.join(directory, "file.py"));
    await pending;
    expect(calls[0].options.signal.aborted).toBe(true);
    expect(delegate.setAllMessages).not.toHaveBeenCalled();
    expect(delegate.dispose).toHaveBeenCalled();
    expect(scanner.controller).toBeNull();
  });

  it("reports failed processes and retains the preceding successful scan", async () => {
    scanner.messages = [{ location: { file: "old.py" } }];
    const notify = spyOn(lumine.notifications, "addError");
    main.execFile = (_command, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(Object.assign(new Error("failed"), { code: 2 }), "", "invalid config"),
      );
    };
    await scanner.runScan(scanItems());
    expect(notify).toHaveBeenCalledWith("Ruff project scan failed", { detail: "invalid config" });
    expect(scanner.messages).toEqual([{ location: { file: "old.py" } }]);
    expect(delegate.setAllMessages).not.toHaveBeenCalled();
  });

  it("aborts a scan and clears its full cache when project folders change", async () => {
    const messages = [{ location: { file: path.join(directory, "old.py") } }];
    scanner.messages = messages;
    scanner.notebookSnapshots = new Map([["old.ipynb", "saved notebook"]]);
    main.publishScanMessages(messages, undefined, scanner.notebookSnapshots);
    let release, began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const calls = fakeRuff(() => {
      began();
      return waiting;
    });
    const pending = scanner.runScan(scanItems());
    await started;
    lumine.project.setPaths([directory]);
    expect(calls[0].options.signal.aborted).toBe(true);
    expect(main.scanMessages).toEqual([]);
    expect(main.scanNotebookSnapshots.size).toBe(0);
    expect(scanner.messages).toEqual([]);
    expect(scanner.notebookSnapshots.size).toBe(0);
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
    release(path.join(directory, "old.py"));
    await pending;
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
    expect(main.ensureProjectScanner()).not.toBe(scanner);
  });

  it("groups existing tree selections by project and rejects empty selections", async () => {
    const other = path.join(directory, "other");
    await fs.mkdir(other);
    const first = path.join(directory, "file.py");
    const second = path.join(other, "file.py");
    await fs.writeFile(first, "x");
    await fs.writeFile(second, "x");
    lumine.project.setPaths([other, directory]);
    const service = main.consumeTreeViewSelection({
      selectedPaths: () => [first, second, first, path.join(directory, "missing")],
    });
    expect(await scanner.selectedScanItems()).toEqual([
      { projectPath: directory, targetPaths: [first] },
      { projectPath: other, targetPaths: [second] },
    ]);
    service.dispose();
    const notify = spyOn(lumine.notifications, "addWarning");
    await scanner.runSelectedScan();
    expect(notify).toHaveBeenCalled();
  });

  it("clears busy progress when a scan finishes or its service disappears", async () => {
    const busy = { add: jasmine.createSpy("busy add"), dispose: jasmine.createSpy("busy dispose") };
    const service = main.consumeBusySignal({ create: () => busy });
    fakeRuff(() => "");
    await scanner.runScan(scanItems());
    expect(busy.add).toHaveBeenCalledWith("Scanning project with Ruff");
    expect(busy.dispose).toHaveBeenCalledTimes(1);
    scanner.busyProvider = busy;
    service.dispose();
    expect(busy.dispose).toHaveBeenCalledTimes(2);
    expect(main.busySignal).toBeNull();
  });

  it("passes cached scans to the IDE coordinator and restores raw results on edge loss", () => {
    const messages = [{ location: { file: "closed.py" } }];
    scanner.messages = messages;
    const notebookSnapshots = new Map([["closed.ipynb", "saved notebook"]]);
    scanner.notebookSnapshots = notebookSnapshots;
    const coordinator = {
      setAllMessages: jasmine.createSpy("coordinator publish"),
      dispose: jasmine.createSpy("dispose coordinator"),
    };
    const service = {
      registerAdapter: () => ({ dispose() {} }),
      createProjectDiagnostics: jasmine.createSpy("coordinate").and.returnValue(coordinator),
    };
    const edge = main.consumeIde(service);
    expect(service.createProjectDiagnostics).toHaveBeenCalledWith("ide-ruff", delegate);
    expect(coordinator.setAllMessages).toHaveBeenCalledWith(messages, undefined, notebookSnapshots);
    edge.dispose();
    expect(coordinator.dispose).toHaveBeenCalledTimes(1);
    expect(delegate.setAllMessages).toHaveBeenCalledWith(messages, undefined, notebookSnapshots);
  });

  it("retains notebook invalidations before the IDE edge disappears or reconnects", () => {
    const messages = [{ location: { file: "changed.ipynb", cell: 1 } }];
    scanner.messages = messages;
    main.publishScanMessages(messages);
    let valid = messages;
    const coordinator = {
      getMessages: () => valid,
      setAllMessages: jasmine.createSpy("coordinator publish"),
      dispose: jasmine.createSpy("dispose coordinator"),
    };
    const service = {
      registerAdapter: () => ({ dispose() {} }),
      createProjectDiagnostics: () => coordinator,
    };
    const edge = main.consumeIde(service);
    valid = [];
    edge.dispose();
    expect(main.scanMessages).toEqual([]);
    expect(scanner.messages).toEqual([]);
    expect(delegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
    const nextEdge = main.consumeIde(service);
    expect(coordinator.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
    nextEdge.dispose();
  });

  it("retains notebook invalidations when the scan registry is replaced", () => {
    const messages = [{ location: { file: "changed.ipynb", cell: 1 } }];
    scanner.messages = messages;
    main.publishScanMessages(messages);
    let valid = messages;
    const edge = main.consumeIde({
      registerAdapter: () => ({ dispose() {} }),
      createProjectDiagnostics: () => ({
        getMessages: () => valid,
        setAllMessages() {},
        dispose() {},
      }),
    });
    valid = [];
    registration.dispose();
    expect(main.scanMessages).toEqual([]);
    const nextDelegate = { dispose() {}, setAllMessages: jasmine.createSpy("next publish") };
    registration = main.consumeLinterRegistry(() => nextDelegate);
    expect(main.ensureProjectScanner().messages).toEqual([]);
    edge.dispose();
    expect(nextDelegate.setAllMessages.calls.mostRecent().args[0]).toEqual([]);
  });
});

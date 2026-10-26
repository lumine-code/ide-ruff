const fs = require("fs").promises;
const path = require("path");
const { CompositeDisposable, Point, Range } = require("lumine");
const { configurationArgs } = require("./server");
const { TEXT_LIMIT, readSource, mapText, limitError } = require("./scan-source");
const MAX_RESULTS = 100000;
const MAX_NOTEBOOK_UNITS = 4 * TEXT_LIMIT;

const fileKey = (filePath) => {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const disabledFiles = (files) => {
  const open = new Map(
    lumine.workspace
      .getTextEditors()
      .filter((editor) => editor.getPath())
      .map((editor) => [fileKey(editor.getPath()), editor.getGrammar?.()]),
  );
  const disabled = new Set(
    [...open].filter(([, grammar]) => grammar === lumine.grammars.nullGrammar).map(([key]) => key),
  );
  const associated =
    lumine.config.get("core.customFileTypes")?.[lumine.grammars.nullGrammar.scopeName];
  if (associated?.length)
    for (const file of files)
      if (
        !open.has(fileKey(file)) &&
        lumine.grammars.getGrammarScore(lumine.grammars.nullGrammar, file, "") > 0
      )
        disabled.add(fileKey(file));
  return disabled;
};

// Project scans are explicit CLI operations. The adapter remains the only
// automatic diagnostic source, and the IDE hub arbitrates their published
// results without throwing away the scanner's complete cache.
module.exports = class ProjectScanner {
  constructor(owner) {
    this.owner = owner;
    this.messages = owner.scanMessages || [];
    this.notebookSnapshots = owner.scanNotebookSnapshots || new Map();
    this.controller = null;
    this.busyProvider = null;
    this.disposed = false;
    this.activePaths = new Set();
    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      lumine.workspace.observeTextEditors((editor) => {
        const cancelScan = () => {
          if (
            editor.getGrammar?.() === lumine.grammars.nullGrammar &&
            editor.getPath() &&
            this.activePaths.has(fileKey(editor.getPath()))
          )
            this.controller?.abort();
        };
        const local = new CompositeDisposable(
          editor.onDidChangeGrammar(cancelScan),
          editor.onDidDestroy(() => {
            this.subscriptions.remove(local);
            local.dispose();
          }),
        );
        this.subscriptions.add(local);
        cancelScan();
      }),
    );
  }

  async selectedScanItems() {
    const selected = this.owner.treeViewSelection?.selectedPaths?.() || [];
    const projects = lumine.project.getPaths();
    const grouped = new Map();
    for (const selectedPath of new Set(selected.filter(Boolean))) {
      try {
        await fs.access(selectedPath);
      } catch {
        continue;
      }
      const projectPath = projects.find((root) => {
        const relative = path.relative(root, selectedPath);
        return relative.split(path.sep)[0] !== ".." && !path.isAbsolute(relative);
      });
      if (!projectPath) continue;
      if (!grouped.has(projectPath)) grouped.set(projectPath, []);
      grouped.get(projectPath).push(selectedPath);
    }
    return [...grouped].map(([projectPath, targetPaths]) => ({ projectPath, targetPaths }));
  }

  async runSelectedScan() {
    const items = await this.selectedScanItems();
    if (this.disposed) return;
    if (!items.length) {
      lumine.notifications.addWarning("Ruff selected scan skipped", {
        detail: "Select files or folders inside a project in the tree view first.",
        dismissable: true,
      });
      return;
    }
    return this.runScan(items);
  }

  disposeBusyMessage() {
    this.busyProvider?.dispose();
    this.busyProvider = null;
  }

  checkArgs(settings) {
    const args = ["check", "--quiet", "--no-fix", "--no-fix-only", "--no-cache"];
    if (settings.configuration) args.push("--config", settings.configuration);
    for (const [key, value] of [
      ["line-length", settings.lineLength],
      ["extend-exclude", settings.exclude],
      ["lint.select", settings.lint.select],
      ["lint.extend-select", settings.lint.extendSelect],
      ["lint.ignore", settings.lint.ignore],
    ]) {
      if (value !== undefined) args.push("--config", `${key} = ${JSON.stringify(value)}`);
    }
    args.push(...configurationArgs(settings));
    args.push(settings.lint.preview ? "--preview" : "--no-preview");
    if (!settings.useNoqa) args.push("--ignore-noqa");
    return args;
  }

  runRuff(command, args, cwd, signal, text) {
    if (text !== undefined && (typeof text !== "string" || text.length > TEXT_LIMIT))
      return Promise.reject(limitError("IPython projection"));
    return new Promise((resolve, reject) => {
      const child = this.owner.execFile(
        command,
        args,
        { cwd, signal, timeout: 100000, maxBuffer: TEXT_LIMIT },
        (error, stdout, stderr) => {
          if (signal.aborted) return resolve(null);
          // Ruff's exit code 1 denotes findings, not a failed process.
          if (error && error.code !== 1) return reject(new Error(stderr || error.message));
          if (typeof stdout !== "string" || stdout.length > TEXT_LIMIT)
            return reject(limitError("Ruff response"));
          resolve(stdout);
        },
      );
      if (text !== undefined) child.stdin.end(text);
    });
  }

  message(filePath, item, settings, position) {
    if (!item.location || !item.end_location) return null;
    const syntax = item.code === null || item.code === "E999" || item.code === "invalid-syntax";
    if (syntax && !settings.showSyntaxErrors) return null;
    return {
      severity: ["error", "warning", "info", "hint"].includes(item.severity)
        ? item.severity
        : "error",
      excerpt: item.code ? `${item.code}: ${item.message}` : item.message,
      ...(item.url ? { url: item.url } : {}),
      location: {
        file: filePath,
        position: position || [
          [item.location.row - 1, item.location.column - 1],
          [item.end_location.row - 1, item.end_location.column - 1],
        ],
        ...(item.cell != null ? { cell: item.cell } : {}),
      },
    };
  }

  parseFindings(stdout) {
    if (typeof stdout !== "string" || stdout.length > TEXT_LIMIT) throw limitError("Ruff response");
    const items = JSON.parse(stdout);
    if (!Array.isArray(items) || items.length > MAX_RESULTS)
      throw new Error(`Ruff scans support at most ${MAX_RESULTS} findings.`);
    return items;
  }

  async rawMessages(items, sources, settings, signal) {
    const messages = [];
    const grouped = new Map();
    for (const item of items) {
      if (!item?.filename || !item.location || !item.end_location || !sources.has(item.filename))
        continue;
      if (!grouped.has(item.filename)) grouped.set(item.filename, new Map());
      const cells = grouped.get(item.filename);
      const cell = item.cell ?? null;
      if (!cells.has(cell)) cells.set(cell, []);
      cells.get(cell).push(item);
    }
    for (const [filename, cells] of grouped) {
      signal?.throwIfAborted();
      const source = sources.get(filename);
      const text = typeof source === "string" ? source : source.text;
      let notebook;
      if ([...cells.keys()].some((cell) => cell !== null)) {
        if (typeof text !== "string" || text.length > TEXT_LIMIT) throw limitError(filename);
        try {
          notebook = JSON.parse(text);
        } catch {
          continue;
        }
      }
      for (const [cellNumber, findings] of cells) {
        let positions;
        if (cellNumber === null && source.positions) positions = source.positions;
        else {
          let content = text;
          if (cellNumber !== null) {
            if (!Number.isSafeInteger(cellNumber) || cellNumber < 1) continue;
            const cell = notebook.cells?.[cellNumber - 1];
            if (!cell || cell.cell_type !== "code") continue;
            if (Array.isArray(cell.source)) {
              if (cell.source.some((part) => typeof part !== "string")) continue;
              content = cell.source.join("");
            } else content = cell.source;
          }
          if (typeof content !== "string") continue;
          if (content.length > TEXT_LIMIT) throw limitError(filename);
          positions = await mapText(
            content,
            findings.flatMap((item) => [item.location, item.end_location]),
            signal,
          );
        }
        for (const item of findings) {
          const start = positions.get(`${item.location.row}:${item.location.column}`);
          const end = positions.get(`${item.end_location.row}:${item.end_location.column}`);
          if (!start || !end) continue;
          const message = this.message(filename, item, settings, [start, end]);
          if (message) messages.push(message);
        }
      }
    }
    return messages;
  }

  projectedMessages(filePath, items, projection, settings) {
    const messages = [];
    for (const item of items) {
      if (!item.location || !item.end_location) continue;
      const start = projection.fromCodePointPosition(
        new Point(item.location.row - 1, item.location.column - 1),
      );
      const end = projection.fromCodePointPosition(
        new Point(item.end_location.row - 1, item.end_location.column - 1),
      );
      if (!start || !end) continue;
      const range = projection.fromServerRange(new Range(start, end));
      if (!range || !projection.isPythonRange(range)) continue;
      const message = this.message(filePath, item, settings, Range.fromObject(range).serialize());
      if (message) messages.push(message);
    }
    return projection.isCurrent() ? messages : [];
  }

  async scanIpython(filePath, command, args, settings, signal) {
    const provider = this.owner.ipythonSource;
    if (!provider) {
      if (!this.projectionMissingNotified) {
        this.projectionMissingNotified = true;
        lumine.notifications.addWarning("Enable language-ipython to scan IPython documents.");
      }
      return [];
    }
    const editor = lumine.workspace.getTextEditors().find((item) => item.getPath() === filePath);
    if (editor?.getGrammar?.() === lumine.grammars.nullGrammar) return [];
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) controller.abort();
    const subscriptions = new CompositeDisposable();
    if (editor)
      subscriptions.add(
        editor.getBuffer().onWillChange(onAbort),
        editor.onDidDestroy(onAbort),
        editor.onDidChangePath(onAbort),
        editor.onDidChangeGrammar(onAbort),
      );
    let projection;
    try {
      let before;
      if (editor) {
        if (!provider.isApplicable?.(editor) || !provider.project) return [];
        if (editor.getBuffer().getLength() > TEXT_LIMIT) throw limitError(filePath);
        projection = await provider.project(editor, { signal: controller.signal });
      } else {
        if (!provider.projectText) return [];
        before = await readSource(filePath, {
          signal: controller.signal,
          maxUnits: TEXT_LIMIT,
          text: true,
        });
        projection = await provider.projectText(before.text, {
          filePath,
          signal: controller.signal,
        });
      }
      if (!projection?.isCurrent() || controller.signal.aborted) return [];
      const stdout = await this.runRuff(
        command,
        [...args, "--output-format=json", `--stdin-filename=${filePath}`, "--extension=ipy:python"],
        path.dirname(filePath),
        controller.signal,
        projection.text,
      );
      if (stdout === null || !projection.isCurrent() || controller.signal.aborted) return [];
      if (!editor) {
        if (!(await readSource(filePath, { signal: controller.signal, expected: before })))
          return [];
      }
      return this.projectedMessages(filePath, this.parseFindings(stdout), projection, settings);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
      return [];
    } finally {
      if (!editor) projection?.dispose();
      subscriptions.dispose();
      signal.removeEventListener("abort", onAbort);
    }
  }

  async runScan(items = null) {
    if (this.disposed || this.controller) return;
    if (!this.owner.scanDelegate) {
      lumine.notifications.addWarning("Enable linter to show Ruff project scan results.");
      return;
    }
    const scanItems =
      items ||
      lumine.project.getPaths().map((projectPath) => ({
        projectPath,
        targetPaths: [projectPath],
      }));
    if (!scanItems.length) return;
    const controller = new AbortController();
    this.controller = controller;
    lumine.commands.invalidateAvailability();
    const current = () => !this.disposed && !controller.signal.aborted;
    try {
      const launch = await this.owner.resolveScanServer();
      if (!launch || !current()) return;
      const settings = this.owner.scanSettings();
      const args = this.checkArgs(settings);
      this.projectionMissingNotified = false;
      this.busyProvider = this.owner.busySignal?.create?.();
      this.busyProvider?.add("Scanning project with Ruff");
      const messages = [];
      const notebookSnapshots = new Map();
      let notebookUnits = 0;
      const appendMessages = (incoming) => {
        if (messages.length + incoming.length > MAX_RESULTS)
          throw new Error(`Ruff scans support at most ${MAX_RESULTS} findings.`);
        for (const message of incoming) messages.push(message);
      };
      for (const { projectPath, targetPaths } of scanItems) {
        const files = await this.runRuff(
          launch.command,
          [...args, "--show-files", "--extension=ipy:python", ...targetPaths],
          projectPath,
          controller.signal,
        );
        if (files === null || !current()) return;
        const uniquePaths = new Set();
        for (let start = 0; start < files.length;) {
          let end = files.indexOf("\n", start);
          if (end === -1) end = files.length;
          const pathEnd = files[end - 1] === "\r" ? end - 1 : end;
          if (pathEnd > start) {
            if (pathEnd - start > 32768) throw limitError("Ruff file path", 32768);
            uniquePaths.add(path.resolve(projectPath, files.slice(start, pathEnd)));
            if (uniquePaths.size > MAX_RESULTS)
              throw new Error(`Ruff scans support at most ${MAX_RESULTS} files per project.`);
          }
          start = end + 1;
        }
        const discoveredPaths = [...uniquePaths];
        const disabled = disabledFiles(discoveredPaths);
        const discovered = discoveredPaths.filter((filePath) => !disabled.has(fileKey(filePath)));
        for (const filePath of discovered) this.activePaths.add(fileKey(filePath));
        const ipythonPaths = discovered.filter(
          (filePath) => path.extname(filePath).toLowerCase() === ".ipy",
        );
        for (const filePath of ipythonPaths) {
          appendMessages(
            await this.scanIpython(filePath, launch.command, args, settings, controller.signal),
          );
          if (!current()) return;
        }
        // Only discovered non-IPython files reach raw disk linting. Batching
        // bounds Windows command lines without overriding exclusion settings.
        const rawFiles = discovered.filter(
          (filePath) => path.extname(filePath).toLowerCase() !== ".ipy",
        );
        for (let index = 0; index < rawFiles.length; index += 50) {
          const batch = rawFiles.slice(index, index + 50);
          const sources = new Map();
          for (const filePath of batch)
            sources.set(
              filePath,
              await readSource(filePath, {
                signal: controller.signal,
                maxUnits:
                  path.extname(filePath).toLowerCase() === ".ipynb" ? TEXT_LIMIT : undefined,
              }),
            );
          if (!current()) return;
          const stdout = await this.runRuff(
            launch.command,
            [...args, "--output-format=json", ...batch],
            projectPath,
            controller.signal,
          );
          if (stdout === null || !current()) return;
          const findings = this.parseFindings(stdout);
          for (const [filePath, source] of sources) {
            const notebook = path.extname(filePath).toLowerCase() === ".ipynb";
            const fileFindings = findings.filter((item) => item?.filename === filePath);
            const after = await readSource(filePath, {
              signal: controller.signal,
              expected: source,
              maxUnits: notebook ? TEXT_LIMIT : undefined,
              text: notebook,
              points: notebook
                ? undefined
                : fileFindings.flatMap((item) => [item.location, item.end_location]),
            });
            if (!current()) return;
            if (!after) continue;
            appendMessages(
              await this.rawMessages(
                fileFindings,
                new Map([[filePath, after]]),
                settings,
                controller.signal,
              ),
            );
            if (notebook) {
              notebookUnits += after.text.length - (notebookSnapshots.get(filePath)?.length || 0);
              if (notebookUnits > MAX_NOTEBOOK_UNITS)
                throw limitError("Notebook scan snapshots", MAX_NOTEBOOK_UNITS);
              notebookSnapshots.set(filePath, after.text);
            }
          }
        }
      }
      if (!current()) return;
      this.messages = messages;
      this.notebookSnapshots = notebookSnapshots;
      this.owner.publishScanMessages(messages, { showProjectView: true }, notebookSnapshots);
    } catch (error) {
      if (current())
        lumine.notifications.addError("Ruff project scan failed", { detail: error.message });
    } finally {
      this.controller = null;
      this.activePaths.clear();
      lumine.commands.invalidateAvailability();
      this.disposeBusyMessage();
    }
  }

  dispose() {
    this.disposed = true;
    this.controller?.abort();
    this.subscriptions.dispose();
    this.activePaths.clear();
    this.messages = [];
    this.notebookSnapshots = new Map();
    this.disposeBusyMessage();
  }
};

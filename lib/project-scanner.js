const fs = require("fs").promises;
const path = require("path");
const { CompositeDisposable, Point, Range } = require("lumine");
const { configurationArgs } = require("./server");

// Project scans are explicit CLI operations. The adapter remains the only
// automatic diagnostic source, and the IDE hub arbitrates their published
// results without throwing away the scanner's complete cache.
module.exports = class ProjectScanner {
  constructor(owner) {
    this.owner = owner;
    this.messages = owner.scanMessages || [];
    this.controller = null;
    this.busyProvider = null;
    this.disposed = false;
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
    return new Promise((resolve, reject) => {
      const child = this.owner.execFile(
        command,
        args,
        { cwd, signal, timeout: 100000, maxBuffer: 100 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (signal.aborted) return resolve(null);
          // Ruff's exit code 1 denotes findings, not a failed process.
          if (error && error.code !== 1) return reject(new Error(stderr || error.message));
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

  rawMessages(items, sources, settings) {
    const messages = [];
    for (const item of items) {
      if (!item.filename || !item.location || !item.end_location) continue;
      const source = sources.get(item.filename);
      if (source === undefined) continue;
      let text = source;
      if (item.cell != null) {
        try {
          const cell = JSON.parse(source).cells?.[item.cell - 1];
          if (!cell || cell.cell_type !== "code") continue;
          text = Array.isArray(cell.source) ? cell.source.join("") : cell.source;
          if (typeof text !== "string") continue;
        } catch {
          continue;
        }
      }
      const lines = text.split(/\r\n|\n|\r/);
      const point = ({ row, column }) => {
        const line = lines[row - 1];
        if (line === undefined || !Number.isInteger(column) || column < 1) return null;
        const codepoints = Array.from(line);
        if (column - 1 > codepoints.length) return null;
        return [row - 1, codepoints.slice(0, column - 1).join("").length];
      };
      const start = point(item.location),
        end = point(item.end_location);
      if (!start || !end) continue;
      const message = this.message(item.filename, item, settings, [start, end]);
      if (message) messages.push(message);
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
      let before, source;
      if (editor) {
        if (!provider.isApplicable?.(editor) || !provider.project) return [];
        projection = await provider.project(editor, { signal: controller.signal });
      } else {
        if (!provider.projectText) return [];
        before = await fs.stat(filePath);
        source = await fs.readFile(filePath, "utf8");
        projection = await provider.projectText(source, { filePath, signal: controller.signal });
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
        const after = await fs.stat(filePath);
        if (
          before.mtimeMs !== after.mtimeMs ||
          before.size !== after.size ||
          (await fs.readFile(filePath, "utf8")) !== source
        )
          return [];
      }
      return this.projectedMessages(filePath, JSON.parse(stdout), projection, settings);
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
      for (const { projectPath, targetPaths } of scanItems) {
        const files = await this.runRuff(
          launch.command,
          [...args, "--show-files", "--extension=ipy:python", ...targetPaths],
          projectPath,
          controller.signal,
        );
        if (files === null || !current()) return;
        const discovered = [...new Set(files.split(/\r?\n/).filter(Boolean))].map((filePath) =>
          path.resolve(projectPath, filePath),
        );
        const ipythonPaths = discovered.filter(
          (filePath) => path.extname(filePath).toLowerCase() === ".ipy",
        );
        for (const filePath of ipythonPaths) {
          messages.push(
            ...(await this.scanIpython(
              filePath,
              launch.command,
              args,
              settings,
              controller.signal,
            )),
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
          for (const filePath of batch) sources.set(filePath, await fs.readFile(filePath, "utf8"));
          if (!current()) return;
          const stdout = await this.runRuff(
            launch.command,
            [...args, "--output-format=json", ...batch],
            projectPath,
            controller.signal,
          );
          if (stdout === null || !current()) return;
          for (const [filePath, source] of sources) {
            if ((await fs.readFile(filePath, "utf8")) !== source) sources.delete(filePath);
          }
          if (!current()) return;
          messages.push(...this.rawMessages(JSON.parse(stdout), sources, settings));
        }
      }
      if (!current()) return;
      this.messages = messages;
      this.owner.publishScanMessages(messages, { showProjectView: true });
    } catch (error) {
      if (current())
        lumine.notifications.addError("Ruff project scan failed", { detail: error.message });
    } finally {
      this.controller = null;
      this.disposeBusyMessage();
    }
  }

  dispose() {
    this.disposed = true;
    this.controller?.abort();
    this.messages = [];
    this.disposeBusyMessage();
  }
};

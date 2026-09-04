const fs = require("fs");
const os = require("os");
const path = require("path");
const main = require("../lib/main");
const { findOnPath } = require("../lib/server");
const { LiveLspClient, fileUri } = require("./helpers/live-lsp-client");

const serverPath = process.env.RUFF_PATH || findOnPath("ruff");
const liveSuite = serverPath ? describe : () => {};

liveSuite("ide-ruff native server", () => {
  let adapter, client, disposable, rootPath;
  let originalTimeout;

  beforeEach(async () => {
    jasmine.useRealClock();
    originalTimeout = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = 20000;
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), "ide-ruff-live-"));
    await lumine.packages.activatePackage("ide-ruff");
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
});

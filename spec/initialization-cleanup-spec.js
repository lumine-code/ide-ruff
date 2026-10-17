describe("ide-ruff initialization cleanup", () => {
  let pack;

  beforeEach(async () => {
    if (lumine.packages.isPackageLoaded("ide-ruff"))
      await lumine.packages.unloadPackage("ide-ruff", { serialize: false });
    pack = lumine.packages.loadPackage("ide-ruff");
    pack.initializeForExternalUse("workspace restoration");
  });

  afterEach(async () => {
    if (lumine.packages.isPackageLoaded("ide-ruff"))
      await lumine.packages.unloadPackage("ide-ruff", { serialize: false });
  });

  it("deactivates before activation and can activate again", async () => {
    const scope = pack.lifecycleContext.subscriptions;
    expect(pack.mainActivationStarted).toBe(false);
    await expectAsync(pack.deactivate()).toBeResolved();
    expect(scope.disposed).toBe(true);
    pack = await lumine.packages.activatePackage("ide-ruff");
    expect(pack.mainActivated).toBe(true);
    expect(pack.lifecycleContext.subscriptions).not.toBe(scope);
  });

  it("unloads before activation starts", async () => {
    expect(pack.mainInitialized).toBe(true);
    expect(pack.mainActivationStarted).toBe(false);
    await expectAsync(
      lumine.packages.unloadPackage("ide-ruff", { serialize: false }),
    ).toBeResolved();
    expect(lumine.packages.isPackageLoaded("ide-ruff")).toBe(false);
  });
});

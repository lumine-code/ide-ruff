describe("Ruff selected scan ownership", () => {
  it("does not report a stale selection after the project scanner is disposed", async () => {
    const ProjectScanner = require("../lib/project-scanner");
    const scanner = new ProjectScanner({});
    let finishSelection;
    spyOn(scanner, "selectedScanItems").and.returnValue(
      new Promise((resolve) => (finishSelection = resolve)),
    );
    spyOn(lumine.notifications, "addWarning");

    const scanning = scanner.runSelectedScan();
    scanner.dispose();
    finishSelection([]);
    await scanning;

    expect(lumine.notifications.addWarning).not.toHaveBeenCalled();
  });
});

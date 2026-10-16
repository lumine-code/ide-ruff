describe("ide-ruff scan availability", () => {
  it("reads roots, service and passive tree selection without starting a scan", async () => {
    const main = (await lumine.packages.activatePackage("ide-ruff")).mainModule;

    jasmine.attachToDOM(lumine.workspace.getElement());
    const target = document.createElement("div");
    target.className = "tree-view";
    lumine.workspace.getElement().appendChild(target);
    const available = (action) => lumine.commands.canDispatch(target, "ide-ruff:" + action);
    const roots = spyOn(lumine.project, "getPaths").and.returnValue([]);
    main.scanDelegate = null;
    expect(available("lint-projects")).toBe(false);
    main.scanDelegate = {};
    roots.and.returnValue(["/project"]);
    expect(available("lint-projects")).toBe(true);
    main.treeViewSelection = {
      getSelectionSnapshot: () => ({ count: 0 }),
      selectedPaths: jasmine.createSpy("initialize tree"),
    };
    expect(available("lint-selected")).toBe(false);
    main.treeViewSelection.getSelectionSnapshot = () => ({ count: 1 });
    expect(available("lint-selected")).toBe(true);
    expect(main.treeViewSelection.selectedPaths).not.toHaveBeenCalled();
    main.projectScanner = { controller: true, dispose() {} };
    expect(available("lint-projects")).toBe(false);
    main.projectScanner = null;
    main.scanDelegate = null;
    target.remove();
    await lumine.packages.deactivatePackage("ide-ruff");
  });
});

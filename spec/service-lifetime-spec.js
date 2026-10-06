const path = require("node:path");

describe("Ruff consumed service lifetime", () => {
  let main;
  const edges = [];
  beforeEach(async () => {
    main = (await lumine.packages.activatePackage(path.resolve(__dirname, ".."))).mainModule;
  });
  afterEach(async () => {
    for (const edge of edges.splice(0)) edge.dispose();
    await lumine.packages.deactivatePackage("ide-ruff");
  });
  for (const [method, field] of [
    ["consumeIde", "ide"],
    ["consumeBusySignal", "busySignal"],
    ["consumeTreeViewSelection", "treeViewSelection"],
    ["consumeIpythonSource", "ipythonSource"],
  ]) {
    it(`preserves the renewed ${field} edge when the same provider's old edge disappears`, () => {
      const registrations = [];
      const service = {
        registerAdapter: () => {
          const registration = { dispose: jasmine.createSpy("dispose exact adapter registration") };
          registrations.push(registration);
          return registration;
        },
      };
      const oldEdge = main[method](service);
      const currentEdge = main[method](service);
      edges.push(oldEdge, currentEdge);
      oldEdge.dispose();
      expect(main[field]).toBe(service);
      if (method === "consumeIde") {
        expect(registrations[0].dispose).toHaveBeenCalledTimes(1);
        expect(registrations[1].dispose).not.toHaveBeenCalled();
      }
      currentEdge.dispose();
      expect(main[field]).toBeNull();
      if (method === "consumeIde") expect(registrations[1].dispose).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps the current IDE edge when a replacement fails to register its adapter", () => {
    const original = { registerAdapter: () => ({ dispose() {} }) };
    edges.push(main.consumeIde(original));
    expect(() =>
      main.consumeIde({
        registerAdapter: () => {
          throw new Error("Registration failed");
        },
      }),
    ).toThrowError("Registration failed");
    expect(main.ide).toBe(original);
  });

  it("releases the previous busy resource on renewal and leaves the new one to its own edge", () => {
    const service = {};
    const oldEdge = main.consumeBusySignal(service);
    const scanner = main.ensureProjectScanner();
    const previous = { dispose: jasmine.createSpy("previous busy resource") };
    scanner.busyProvider = previous;
    const currentEdge = main.consumeBusySignal(service);
    edges.push(oldEdge, currentEdge);
    expect(previous.dispose).toHaveBeenCalledTimes(1);
    const current = { dispose: jasmine.createSpy("current busy resource") };
    scanner.busyProvider = current;
    oldEdge.dispose();
    expect(current.dispose).not.toHaveBeenCalled();
    currentEdge.dispose();
    expect(current.dispose).toHaveBeenCalledTimes(1);
  });
});

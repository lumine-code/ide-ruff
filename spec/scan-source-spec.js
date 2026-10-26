const fs = require("node:fs").promises;
const path = require("node:path");
const os = require("node:os");

describe("Ruff streaming scan sources", () => {
  let directory, source;
  beforeEach(async () => {
    jasmine.useRealClock();
    source = require("../lib/scan-source");
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "ruff-source-"));
  });
  afterEach(async () => fs.rm(directory, { recursive: true, force: true }));

  it("maps code points across every chunk boundary and physical line ending", () => {
    const text = "a😀b\r\n\r𐀀z\n\ud800x\udfff\r";
    const lines = text.split(/\r\n|\n|\r/);
    const points = [],
      expected = [];
    lines.forEach((line, row) => {
      const characters = Array.from(line);
      for (let column = 0; column <= characters.length + 1; column++) {
        points.push({ row: row + 1, column: column + 1 });
        if (column <= characters.length)
          expected.push([
            `${row + 1}:${column + 1}`,
            [row, characters.slice(0, column).join("").length],
          ]);
      }
    });
    points.push({ row: -1, column: 1 }, { row: 1.5, column: 2 }, { row: 1, column: Infinity });
    for (let width = 1; width <= text.length; width++) {
      const mapper = new source.PositionMapper(points);
      for (let offset = 0; offset < text.length; offset += width)
        mapper.write(text.slice(offset, offset + width));
      mapper.write("", true);
      expect([...mapper.positions])
        .withContext(`chunk width ${width}`)
        .toEqual(expected);
    }
  });

  it("maps a row beyond V8's string limit without retaining its contents", () => {
    const chunk = "x".repeat(65536);
    const count = Math.ceil(require("node:buffer").constants.MAX_STRING_LENGTH / chunk.length) + 1;
    const length = count * chunk.length;
    const mapper = new source.PositionMapper([
      { row: 1, column: length + 1 },
      { row: 2, column: 2 },
    ]);
    for (let index = 0; index < count; index++) mapper.write(chunk);
    mapper.write("\r\n😀", true);
    expect([...mapper.positions]).toEqual([
      [`1:${length + 1}`, [0, length]],
      ["2:2", [1, 2]],
    ]);
    expect(mapper.points.length).toBe(2);
    expect(mapper.high).toBe("");
  });

  it("streams decoded positions and fingerprints without readFile or line arrays", async () => {
    const file = path.join(directory, "source.py");
    const prefix = "x".repeat(65535);
    await fs.writeFile(file, prefix + "😀\r\ny\r𐀀z");
    const readFile = fs.readFile.bind(fs);
    spyOn(fs, "readFile").and.callFake((target, ...args) => {
      if (target === file) throw new Error("whole-file read forbidden");
      return readFile(target, ...args);
    });
    const before = await source.readSource(file);
    expect(before.text).toBeUndefined();
    const after = await source.readSource(file, {
      expected: before,
      points: [
        { row: 1, column: 65537 },
        { row: 3, column: 2 },
      ],
    });
    expect([...after.positions]).toEqual([
      ["1:65537", [0, 65537]],
      ["3:2", [2, 2]],
    ]);
    expect(after.digest).toBe(before.digest);
  });

  it("checks exact bytes even when supplied file metadata matches a same-size edit", async () => {
    const file = path.join(directory, "changed.py");
    await fs.writeFile(file, "before");
    const before = await source.readSource(file);
    await fs.writeFile(file, "after!");
    before.stat = await fs.stat(file);
    expect(await source.readSource(file, { expected: before })).toBeNull();
  });

  it("preflights oversized input and bounds decoded text independently of byte size", async () => {
    const file = path.join(directory, "bounded.ipynb");
    await fs.writeFile(file, "1234567890");
    const open = fs.open.bind(fs);
    let read;
    spyOn(fs, "open").and.callFake(async (...args) => {
      const handle = await open(...args);
      if (args[0] !== file) return handle;
      read = spyOn(handle, "read").and.callThrough();
      return handle;
    });
    await expectAsync(source.readSource(file, { text: true, maxUnits: 3 })).toBeRejectedWithError(
      /budget/,
    );
    expect(read).not.toHaveBeenCalled();
    await expectAsync(source.readSource(file, { text: true, maxUnits: 5 })).toBeRejectedWithError(
      /budget/,
    );
    expect(read).toHaveBeenCalled();
  });

  it("rejects growth during a read and closes its file descriptor", async () => {
    const file = path.join(directory, "growing.py");
    await fs.writeFile(file, "before");
    const open = fs.open.bind(fs);
    let close;
    spyOn(fs, "open").and.callFake(async (...args) => {
      const handle = await open(...args);
      if (args[0] !== file) return handle;
      const read = handle.read.bind(handle);
      let grew = false;
      spyOn(handle, "read").and.callFake(async (...values) => {
        if (!grew) {
          grew = true;
          await fs.appendFile(file, "after");
        }
        return read(...values);
      });
      close = spyOn(handle, "close").and.callThrough();
      return handle;
    });
    await expectAsync(source.readSource(file)).toBeRejectedWithError(/Source changed/);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("honors cancellation before I/O and during cooperative in-memory mapping", async () => {
    const controller = new AbortController();
    controller.abort();
    spyOn(fs, "open").and.throwError("cancelled operation opened a file");
    await expectAsync(source.readSource("missing", { signal: controller.signal })).toBeRejected();
    await expectAsync(source.mapText("x", [], controller.signal)).toBeRejected();
    expect(fs.open).not.toHaveBeenCalled();
  });
});

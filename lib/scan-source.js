const fs = require("node:fs").promises;
const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");

const TEXT_LIMIT = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const sameFile = (left, right) =>
  ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => left[key] === right[key]);

function limitError(subject, limit = TEXT_LIMIT) {
  const error = new RangeError(`${subject} exceeds the ${limit} UTF-16 unit scan budget.`);
  error.code = "ERR_RUFF_SCAN_BUDGET";
  return error;
}

// Ruff columns count Unicode code points. Retain only requested coordinates,
// never an array of lines or of all code points in a potentially giant row.
class PositionMapper {
  constructor(points) {
    this.points = [
      ...new Map(
        points
          .filter(
            (point) =>
              Number.isSafeInteger(point?.row) &&
              point.row > 0 &&
              Number.isSafeInteger(point?.column) &&
              point.column > 0,
          )
          .map((point) => [`${point.row}:${point.column}`, point]),
      ).values(),
    ].sort((a, b) => a.row - b.row || a.column - b.column);
    this.positions = new Map();
    this.index = 0;
    this.row = 1;
    this.column = 1;
    this.units = 0;
    this.afterCR = false;
    this.high = "";
  }

  record() {
    while (this.index < this.points.length) {
      const point = this.points[this.index];
      if (point.row > this.row || (point.row === this.row && point.column > this.column)) break;
      if (point.row === this.row && point.column === this.column)
        this.positions.set(`${point.row}:${point.column}`, [this.row - 1, this.units]);
      this.index++;
    }
  }

  write(chunk, final = false) {
    if (this.index === this.points.length) return;
    let text = this.high + chunk;
    this.high = "";
    const last = text.charCodeAt(text.length - 1);
    if (!final && last >= 0xd800 && last <= 0xdbff) {
      this.high = text.at(-1);
      text = text.slice(0, -1);
    }
    const special = /[\r\n\ud800-\udfff]/g;
    let offset = 0;
    const advance = (length) => {
      const end = this.column + length;
      this.record();
      while (this.index < this.points.length) {
        const point = this.points[this.index];
        if (point.row !== this.row || point.column > end) break;
        this.positions.set(`${point.row}:${point.column}`, [
          this.row - 1,
          this.units + point.column - this.column,
        ]);
        this.index++;
      }
      this.column = end;
      this.units += length;
      if (length) this.afterCR = false;
    };
    for (let match; (match = special.exec(text));) {
      advance(match.index - offset);
      const character = text[match.index];
      offset = match.index + 1;
      if (this.afterCR && character === "\n") {
        this.afterCR = false;
        continue;
      }
      this.record();
      if (this.index === this.points.length) return;
      this.afterCR = character === "\r";
      if (character === "\r" || character === "\n") {
        this.row++;
        this.column = 1;
        this.units = 0;
      } else {
        const high = text.charCodeAt(match.index);
        const low = text.charCodeAt(match.index + 1);
        const pair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
        this.column++;
        this.units += pair ? 2 : 1;
        if (pair) special.lastIndex = ++offset;
      }
    }
    advance(text.length - offset);
    if (final) this.record();
  }
}

// Hash before and after the CLI run. Size/timestamps alone miss same-size edits
// and path replacement; identity plus the digest guards the mapped coordinates.
async function readSource(filePath, { signal, expected, maxUnits, text = false, points } = {}) {
  if (text && maxUnits === undefined) maxUnits = TEXT_LIMIT;
  signal?.throwIfAborted();
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const before = await handle.stat();
    if (expected && !sameFile(expected.stat, before)) return null;
    if (maxUnits !== undefined && before.size > maxUnits * 3) throw limitError(filePath, maxUnits);
    const hash = createHash("sha256");
    const decoder = text || maxUnits !== undefined || points ? new StringDecoder("utf8") : null;
    const mapper = points ? new PositionMapper(points) : null;
    const chunks = [];
    let units = 0,
      bytes = 0;
    const accept = (chunk, final = false) => {
      units += chunk.length;
      if (maxUnits !== undefined && units > maxUnits) throw limitError(filePath, maxUnits);
      if (text) chunks.push(chunk);
      mapper?.write(chunk, final);
    };
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (true) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > before.size) {
        if (expected) return null;
        throw new Error(`Source changed while scanning ${filePath}. Run the scan again.`);
      }
      hash.update(buffer.subarray(0, bytesRead));
      if (decoder) accept(decoder.write(buffer.subarray(0, bytesRead)));
    }
    if (decoder) accept(decoder.end(), true);
    signal?.throwIfAborted();
    const after = await handle.stat();
    const atPath = await fs.stat(filePath);
    const digest = hash.digest("hex");
    if (
      !sameFile(before, after) ||
      !sameFile(after, atPath) ||
      (expected && digest !== expected.digest)
    ) {
      if (expected) return null;
      throw new Error(`Source changed while scanning ${filePath}. Run the scan again.`);
    }
    return {
      stat: after,
      digest,
      text: text ? chunks.join("") : undefined,
      positions: mapper?.positions,
    };
  } catch (error) {
    if (expected && error.code === "ENOENT") return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

async function mapText(text, points, signal) {
  const mapper = new PositionMapper(points);
  let deadline = performance.now() + 4;
  for (let offset = 0; offset < text.length; offset += CHUNK_BYTES) {
    signal?.throwIfAborted();
    mapper.write(text.slice(offset, offset + CHUNK_BYTES));
    if (performance.now() >= deadline) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      deadline = performance.now() + 4;
    }
  }
  mapper.write("", true);
  signal?.throwIfAborted();
  return mapper.positions;
}

module.exports = { TEXT_LIMIT, PositionMapper, readSource, mapText, limitError };

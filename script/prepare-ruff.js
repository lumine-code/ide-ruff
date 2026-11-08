"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const VERSION = "0.17.2";
const API = "https://api.github.com/repos/astral-sh/ruff/releases";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function removeOwnedStaging(owned, base) {
  if (
    path.dirname(owned) !== base ||
    !path.basename(owned).startsWith("lumine-ruff-") ||
    fs.lstatSync(owned).isSymbolicLink() ||
    fs.realpathSync.native(owned) !== owned
  )
    throw new Error("Unsafe Ruff bootstrap staging cleanup");
  fs.rmSync(owned, { recursive: true, force: true });
}

function targetFor(platform, arch) {
  if (arch !== "x64" || !["linux", "win32"].includes(platform))
    throw new Error(`No reviewed Ruff ${VERSION} bootstrap for ${platform}/${arch}`);
  return platform === "linux"
    ? { filename: "ruff-x86_64-unknown-linux-gnu.tar.gz", binary: "ruff" }
    : {
        filename: "ruff-x86_64-pc-windows-msvc.zip",
        binary: "ruff.exe",
      };
}

function assetFor(release, filename, maximum) {
  const matches = release.assets?.filter((asset) => asset.name === filename);
  const asset = matches?.[0];
  if (
    release.tag_name !== VERSION ||
    matches?.length !== 1 ||
    !Number.isSafeInteger(asset.id) ||
    asset.id <= 0 ||
    !Number.isSafeInteger(asset.size) ||
    asset.size <= 0 ||
    asset.size > maximum ||
    asset.browser_download_url !==
      `https://github.com/astral-sh/ruff/releases/download/${VERSION}/${filename}` ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest || "")
  )
    throw new Error("The official Ruff release does not identify the exact reviewed asset");
  return asset;
}

async function downloadRuff({
  request,
  fetch = globalThis.fetch,
  token,
  platform = process.platform,
  arch = process.arch,
  signal = AbortSignal.timeout(120000),
}) {
  const target = targetFor(platform, arch);
  signal.throwIfAborted();
  const metadata = await request(fetch, `${API}/tags/${VERSION}`, {
    accept: "application/vnd.github+json",
    token,
    signal,
  });
  if (!metadata.ok) throw new Error(`Official Ruff metadata HTTP ${metadata.status}`);
  const release = await metadata.json();
  const archive = assetFor(release, target.filename, 128 * 1024 * 1024);
  const sidecar = assetFor(release, target.filename + ".sha256", 16384);
  const bytesFor = async (asset) => {
    signal.throwIfAborted();
    const response = await request(fetch, `${API}/assets/${asset.id}`, {
      accept: "application/octet-stream",
      token,
      signal,
    });
    if (!response.ok) throw new Error(`Official Ruff asset HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > asset.size) throw new Error("Official Ruff asset exceeds its declared size");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== asset.size || `sha256:${sha256(bytes)}` !== asset.digest)
      throw new Error("Official Ruff asset SHA256 or size mismatch");
    return bytes;
  };
  const checksumBytes = await bytesFor(sidecar);
  const checksum = checksumBytes.toString("utf8").trim().split(/\s+/);
  if (
    checksum.length !== 2 ||
    !/^[a-f0-9]{64}$/.test(checksum[0]) ||
    checksum[1].replace(/^\*/, "") !== target.filename
  )
    throw new Error("Official Ruff SHA256 sidecar does not name the exact archive");
  const bytes = await bytesFor(archive);
  if (sha256(bytes) !== checksum[0]) throw new Error("Official Ruff archive failed sidecar SHA256");
  return { ...target, bytes, sha256: checksum[0], size: bytes.length };
}

async function prepareRuff({
  editor,
  output,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  fetch = globalThis.fetch,
  request,
  run = spawnSync,
  signal,
}) {
  if (env.RUFF_VERSION && env.RUFF_VERSION !== VERSION)
    throw new Error(`The reviewed Ruff bootstrap requires ${VERSION}`);
  if (env.HTTPS_PROXY || env.https_proxy)
    throw new Error("The Ruff bootstrap refuses to bypass an explicitly configured HTTPS proxy");
  if (!request) {
    if (!editor || require(path.join(path.resolve(editor), "package.json")).name !== "lumine")
      throw new Error("Pass the explicit checked-out editor path for the reviewed API transport");
    // CI orchestration selects its checked-out editor explicitly; this is not
    // a runtime package integration or a dependency on a sibling installation.
    request = require(
      path.join(path.resolve(editor), "script/github-release-request"),
    ).githubReleaseRequest;
  }
  if (!path.isAbsolute(output) || fs.existsSync(output))
    throw new Error("Ruff output must be a new absolute directory");
  const archive = await downloadRuff({
    request,
    fetch,
    token: env.GITHUB_TOKEN,
    platform,
    arch,
    signal,
  });
  signal?.throwIfAborted();
  const base = fs.realpathSync.native(os.tmpdir());
  const owned = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "lumine-ruff-")));
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv))
    if (key.toUpperCase() === "GITHUB_TOKEN") delete childEnv[key];
  const execute = (command, args, options = {}) => {
    const result = run(command, args, {
      env: childEnv,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60000,
      ...options,
    });
    if (result.error || result.signal || result.status !== 0)
      throw new Error(
        `Ruff bootstrap process failed: ${result.error?.message || result.signal || result.status}`,
      );
    return result;
  };
  try {
    const file = path.join(owned, archive.filename);
    fs.writeFileSync(file, archive.bytes, { flag: "wx" });
    fs.mkdirSync(output);
    if (platform === "linux") {
      execute("tar", ["-xzf", file, "--strip-components=1", "-C", output]);
    } else {
      execute(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Expand-Archive -LiteralPath $env:LUMINE_RUFF_ARCHIVE -DestinationPath $env:LUMINE_RUFF_OUTPUT",
        ],
        { env: { ...childEnv, LUMINE_RUFF_ARCHIVE: file, LUMINE_RUFF_OUTPUT: output } },
      );
    }
    const binary = path.join(output, archive.binary);
    if (!fs.statSync(binary).isFile())
      throw new Error("Official Ruff archive lacks its executable");
    if (platform === "linux") fs.chmodSync(binary, 0o755);
    const version = execute(binary, ["--version"]).stdout.trim();
    if (version !== `ruff ${VERSION}`) throw new Error("Official Ruff executable version mismatch");
    if (env.GITHUB_PATH) fs.appendFileSync(env.GITHUB_PATH, path.dirname(binary) + "\n");
    return {
      version,
      filename: archive.filename,
      sha256: archive.sha256,
      size: archive.size,
      binary,
    };
  } finally {
    removeOwnedStaging(owned, base);
  }
}

module.exports = { VERSION, targetFor, downloadRuff, prepareRuff };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (
    args.length < 2 ||
    args[0] !== "--editor" ||
    ![2, 4].includes(args.length) ||
    (args.length === 4 && args[2] !== "--output")
  )
    throw new Error(
      "Usage: node script/prepare-ruff.js --editor <checkout> [--output <new-directory>]",
    );
  prepareRuff({ editor: args[1], output: path.resolve(args[3] || ".server") }).then(
    (result) => console.log(`Verified ${result.version}: ${result.filename}, ${result.sha256}`),
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}

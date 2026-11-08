"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const test = require("node:test");
const { VERSION, targetFor, downloadRuff, prepareRuff } = require("./prepare-ruff");

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t, platform = "linux") {
  const base = fs.realpathSync.native(os.tmpdir());
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(base, "ruff-bootstrap-test-")));
  t.after(() => {
    assert.equal(path.dirname(directory), base);
    assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
    assert.equal(fs.realpathSync.native(directory), directory);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const target = targetFor(platform, "x64");
  const archive = Buffer.from("actual transport fixture bytes");
  const sidecar = Buffer.from(`${hash(archive)}  ${target.filename}\n`);
  const metadata = {
    tag_name: VERSION,
    assets: [archive, sidecar].map((bytes, index) => {
      const name = target.filename + (index ? ".sha256" : "");
      return {
        id: index + 1,
        name,
        size: bytes.length,
        digest: `sha256:${hash(bytes)}`,
        browser_download_url: `https://github.com/astral-sh/ruff/releases/download/${VERSION}/${name}`,
      };
    }),
  };
  const requests = [];
  const request = async (_fetch, url, options) => {
    requests.push({ url, options });
    if (url.includes("/tags/")) return Response.json(metadata);
    return new Response(url.endsWith("/1") ? archive : sidecar);
  };
  return { directory, target, archive, sidecar, metadata, requests, request };
}

test("exact Linux tar and Windows zip are reviewed while unsupported targets fail", () => {
  assert.equal(targetFor("linux", "x64").filename, "ruff-x86_64-unknown-linux-gnu.tar.gz");
  assert.equal(targetFor("win32", "x64").filename, "ruff-x86_64-pc-windows-msvc.zip");
  assert.equal(targetFor("win32", "x64").binary, "ruff.exe");
  assert.throws(() => targetFor("linux", "arm64"), /No reviewed/);
});

test("exact official archive and original sidecar are both verified through the explicit API boundary", async (t) => {
  const f = fixture(t);
  const result = await downloadRuff({
    request: f.request,
    platform: "linux",
    arch: "x64",
    token: "fixture-token",
  });
  assert.deepEqual(result.bytes, f.archive);
  assert.equal(result.sha256, hash(f.archive));
  assert.deepEqual(
    f.requests.map(({ url }) => url),
    [
      "https://api.github.com/repos/astral-sh/ruff/releases/tags/0.17.2",
      "https://api.github.com/repos/astral-sh/ruff/releases/assets/2",
      "https://api.github.com/repos/astral-sh/ruff/releases/assets/1",
    ],
  );
  assert.ok(f.requests.every(({ options }) => options.token === "fixture-token"));
});

for (const change of [
  (m) => (m.tag_name = "0.17.3"),
  (m) => m.assets.push(m.assets[0]),
  (m) => (m.assets[0].id = -1),
  (m) => (m.assets[0].size = 200 * 1024 * 1024),
  (m) => (m.assets[0].digest = "invalid"),
  (m) => (m.assets[0].browser_download_url = "https://untrusted.invalid/archive"),
]) {
  test("wrong official release identity fails before extraction", async (t) => {
    const f = fixture(t);
    change(f.metadata);
    await assert.rejects(
      downloadRuff({ request: f.request, platform: "linux", arch: "x64" }),
      /exact reviewed asset/,
    );
    assert.equal(f.requests.length, 1);
  });
}

test("corrupt bytes fail before output creation or extraction", async (t) => {
  const f = fixture(t);
  const output = path.join(f.directory, "output");
  await assert.rejects(
    prepareRuff({
      output,
      platform: "linux",
      arch: "x64",
      env: {},
      request: async (fetch, url, options) =>
        url.endsWith("/1") ? new Response("corrupt") : f.request(fetch, url, options),
      run: () => assert.fail("must not extract"),
    }),
    /SHA256 or size mismatch/,
  );
  assert.equal(fs.existsSync(output), false);
});

test("a valid but wrong sidecar digest cannot approve an archive", async (t) => {
  const f = fixture(t);
  const wrong = Buffer.from(`${"0".repeat(64)}  ${f.target.filename}\n`);
  f.metadata.assets[1].digest = `sha256:${hash(wrong)}`;
  await assert.rejects(
    downloadRuff({
      platform: "linux",
      arch: "x64",
      request: (fetch, url, options) =>
        url.endsWith("/2") ? new Response(wrong) : f.request(fetch, url, options),
    }),
    /failed sidecar SHA256/,
  );
});

for (const status of [403, 404, 504]) {
  test(`metadata HTTP ${status} remains a failure without retry`, async () => {
    let calls = 0;
    await assert.rejects(
      downloadRuff({
        platform: "linux",
        arch: "x64",
        request: async () => {
          calls++;
          return new Response(null, { status });
        },
      }),
      new RegExp(`metadata HTTP ${status}`),
    );
    assert.equal(calls, 1);
  });
}

for (const platform of ["linux", "win32"]) {
  test(`${platform} verifies the extracted executable version and strips credentials from native children`, async (t) => {
    const f = fixture(t, platform);
    const output = path.join(f.directory, "output");
    const pathFile = path.join(f.directory, "github-path");
    const calls = [];
    const result = await prepareRuff({
      output,
      platform,
      arch: "x64",
      request: f.request,
      env: { GITHUB_TOKEN: "fixture-token", GITHUB_PATH: pathFile },
      run(command, args, options) {
        calls.push({ command, args });
        assert.equal(options.env.GITHUB_TOKEN, undefined);
        if (args[0] === "--version") return { status: 0, stdout: `ruff ${VERSION}\n` };
        const binary = path.join(output, f.target.binary);
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, "native fixture");
        return { status: 0, stdout: "" };
      },
    });
    assert.equal(result.version, `ruff ${VERSION}`);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command, platform === "linux" ? "tar" : "powershell");
    assert.equal(fs.readFileSync(pathFile, "utf8"), path.dirname(result.binary) + "\n");
  });
}

test("a wrong native executable version never reaches GITHUB_PATH", async (t) => {
  const f = fixture(t);
  const pathFile = path.join(f.directory, "github-path");
  const output = path.join(f.directory, "output");
  await assert.rejects(
    prepareRuff({
      output,
      platform: "linux",
      arch: "x64",
      request: f.request,
      env: { GITHUB_PATH: pathFile },
      run(_command, args) {
        if (args[0] === "--version") return { status: 0, stdout: "ruff 0.17.1\n" };
        fs.writeFileSync(path.join(output, "ruff"), "native fixture");
        return { status: 0 };
      },
    }),
    /version mismatch/,
  );
  assert.equal(fs.existsSync(pathFile), false);
});

test("explicit proxies and wrong versions fail before any network or extraction", async (t) => {
  const f = fixture(t);
  let requests = 0;
  for (const env of [
    { HTTPS_PROXY: "http://proxy.invalid" },
    { https_proxy: "http://proxy.invalid" },
    { RUFF_VERSION: "0.17.1" },
  ])
    await assert.rejects(
      prepareRuff({
        output: path.join(f.directory, "output"),
        env,
        request: () => {
          requests++;
          assert.fail("must not request");
        },
      }),
      /HTTPS proxy|requires 0\.17\.2/,
    );
  assert.equal(requests, 0);
});

test("caller cancellation prevents even the first metadata request", async () => {
  const controller = new AbortController();
  controller.abort();
  let requests = 0;
  await assert.rejects(
    downloadRuff({
      platform: "linux",
      arch: "x64",
      signal: controller.signal,
      request: async () => {
        requests++;
        return Response.json({});
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(requests, 0);
});

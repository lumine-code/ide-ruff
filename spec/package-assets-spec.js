const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md");

// Guards for the workspace-wide package conventions: one canonical description
// sentence shared by the manifest and the README, no legacy editor branding,
// keyword hygiene, and the language-server service contract this adapter is
// built on.
describe("ide-ruff package assets", () => {
  it("carries the same description in the manifest and the README", () => {
    const lines = readme.split(/\r?\n/);
    expect(lines[0]).toBe(`# ${pkg.name}`);
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(pkg.description);
    expect(pkg.description.endsWith(".")).toBe(true);
    expect(pkg.description.length).toBeLessThan(80);
  });

  it("is published under lumine-code", () => {
    expect(pkg.name).toBe("ide-ruff");
    expect(pkg.author).toBe("lumine-code");
    expect(pkg.repository).toBe("https://github.com/lumine-code/ide-ruff");
    expect(pkg.bugs.url).toBe("https://github.com/lumine-code/ide-ruff/issues");
    expect(pkg.license).toBe("MIT");
    expect(read("LICENSE")).toContain("Copyright (c) 2026 lumine-code");
  });

  it("has no legacy editor branding", () => {
    const sources = [readme, read("package.json"), read("lib/main.js"), read("lib/server.js")];
    for (const source of sources) expect(source).not.toMatch(/\b(Atom|Pulsar|atom-ide)\b/);
  });

  it("keeps the README free of badges, images, and keybindings", () => {
    expect(readme).not.toMatch(/!\[|<img|shields\.io/);
    expect(readme).not.toMatch(/keymap|keybinding|keystroke/i);
  });

  it("keeps keyword hygiene", () => {
    expect(pkg.keywords.length).toBeGreaterThan(2);
    expect(pkg.keywords.length).toBeLessThan(9);
    for (const keyword of pkg.keywords) {
      expect(keyword).toBe(keyword.toLowerCase());
      expect(keyword).not.toMatch(/\s/);
      // A keyword contained in the package name is a wasted slot: the Install
      // tab already scores the name match higher.
      expect(pkg.name.includes(keyword)).toBe(false);
    }
  });

  it("consumes the language-server service and ships no runtime dependencies", () => {
    expect(pkg.consumedServices["ide-client"].versions["^1.0.0"]).toBe("consumeIdeClient");
    expect(pkg.providedServices).toBeUndefined();
    expect(pkg.dependencies).toBeUndefined();
    expect(readme).toContain("- **ide-client** (`^1.0.0`): consumed to");
  });

  it("declares every setting the adapter reads, with no `order` keys", () => {
    const lookup = (keyPath) =>
      keyPath
        .split(".")
        .reduce(
          (schema, key) => (schema === pkg.configSchema ? schema : schema?.properties)?.[key],
          pkg.configSchema,
        );
    const used = [...read("lib/main.js").matchAll(/setting\("([A-Za-z.]+)"\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const keyPath of new Set(used))
      expect(`${keyPath}: ${!!lookup(keyPath)}`).toBe(`${keyPath}: true`);

    const check = (entry, keyPath) => {
      expect(`${keyPath}: ${entry.order}`).toBe(`${keyPath}: undefined`);
      expect(typeof entry.description).toBe("string");
      // `title`, `description`, `type`, then the rest. A leaf ends with its
      // `default`; a group has none and ends with the settings it holds.
      const keys = Object.keys(entry);
      expect(`${keyPath}: ${keys.slice(0, 3)}`).toBe(`${keyPath}: title,description,type`);
      const last = entry.type === "object" ? "properties" : "default";
      expect(`${keyPath}: ${keys[keys.length - 1]}`).toBe(`${keyPath}: ${last}`);
      if (entry.type === "object")
        for (const [key, nested] of Object.entries(entry.properties))
          check(nested, `${keyPath}.${key}`);
    };
    for (const [key, entry] of Object.entries(pkg.configSchema)) check(entry, key);
  });
});

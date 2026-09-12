import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const bumpScript = fileURLToPath(
  new URL("../../scripts/bump-plugin-versions.mjs", import.meta.url),
);
const checkScript = fileURLToPath(
  new URL("../../scripts/check-release-versions.mjs", import.meta.url),
);

const roots: string[] = [];

function writeJson(root: string, relativePath: string, value: unknown): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson<T>(root: string, relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as T;
}

function createReleaseFixture(version: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "socraticode-release-manifests-"));
  roots.push(root);

  writeJson(root, "package.json", {
    name: "socraticode",
    mcpName: "io.github.giancarloerra/socraticode",
    version,
  });
  for (const relativePath of [
    ".claude-plugin/plugin.json",
    ".cursor-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "gemini-extension.json",
    "extension/package.json",
  ]) {
    writeJson(root, relativePath, { version: "0.0.1" });
  }
  writeJson(root, "extension/package-lock.json", {
    version: "0.0.1",
    packages: { "": { version: "0.0.1" } },
  });
  writeJson(root, "server.json", {
    name: "io.github.giancarloerra/socraticode",
    version: "0.0.1",
    packages: [{ registryType: "npm", identifier: "socraticode", version: "0.0.1" }],
  });

  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("release manifest versioning", () => {
  it("bumps plugin, extension, lockfile, and MCP Registry versions together", () => {
    const root = createReleaseFixture("2.4.0");

    execFileSync(process.execPath, [bumpScript, "2.4.0"], { cwd: root });

    expect(readJson<{ version: string }>(root, ".codex-plugin/plugin.json").version).toBe(
      "2.4.0",
    );
    expect(
      readJson<{ packages: { "": { version: string } } }>(
        root,
        "extension/package-lock.json",
      ).packages[""].version,
    ).toBe("2.4.0");
    const server = readJson<{
      version: string;
      packages: Array<{ version: string }>;
    }>(root, "server.json");
    expect(server.version).toBe("2.4.0");
    expect(server.packages[0].version).toBe("2.4.0");

    expect(() =>
      execFileSync(process.execPath, [checkScript, "2.4.0"], { cwd: root }),
    ).not.toThrow();
  });

  it("fails when a nested MCP Registry package version drifts", () => {
    const root = createReleaseFixture("2.4.0");
    execFileSync(process.execPath, [bumpScript, "2.4.0"], { cwd: root });

    const server = readJson<{
      version: string;
      packages: Array<{ registryType: string; identifier: string; version: string }>;
    }>(root, "server.json");
    server.packages[0].version = "2.3.9";
    writeJson(root, "server.json", server);

    const result = spawnSync(process.execPath, [checkScript, "2.4.0"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('server.json.packages[0].version is "2.3.9"');
  });

  it("rejects a modern lockfile whose root package has no version", () => {
    const root = createReleaseFixture("2.4.0");
    writeJson(root, "extension/package-lock.json", {
      version: "0.0.1",
      packages: { "": {} },
    });

    const result = spawnSync(process.execPath, [bumpScript, "2.4.0"], {
      cwd: root,
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'missing version field(s): extension/package-lock.json.packages[""].version',
    );
  });
});

// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/** Manifests whose release version must match the root package version. */
export const VERSIONED_MANIFESTS = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "gemini-extension.json",
  "extension/package.json",
  "extension/package-lock.json",
  "server.json",
];

const VERSIONED_REGISTRY_TYPES = new Set(["npm", "pypi", "nuget"]);

function hasPackageLockRoot(manifest) {
  return (
    manifest.packages !== null &&
    typeof manifest.packages === "object" &&
    Object.prototype.hasOwnProperty.call(manifest.packages, "")
  );
}

/** Return every version-bearing field that must match for one manifest. */
export function manifestVersionFields(relativePath, manifest) {
  const fields = [{ label: `${relativePath}.version`, value: manifest.version }];

  if (relativePath.endsWith("package-lock.json") && hasPackageLockRoot(manifest)) {
    fields.push({
      label: `${relativePath}.packages[\"\"].version`,
      value: manifest.packages?.[""]?.version,
    });
  }

  if (relativePath === "server.json") {
    if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) {
      fields.push({ label: "server.json.packages", value: undefined });
    } else {
      manifest.packages.forEach((pkg, index) => {
        if (VERSIONED_REGISTRY_TYPES.has(pkg?.registryType)) {
          fields.push({
            label: `server.json.packages[${index}].version`,
            value: pkg.version,
          });
        }
      });
    }
  }

  return fields;
}

/** Update every release-coupled version field in one parsed manifest. */
export function setManifestVersion(relativePath, manifest, version) {
  const fields = manifestVersionFields(relativePath, manifest);
  const missing = fields.filter((field) => typeof field.value !== "string");
  if (missing.length > 0) {
    throw new Error(`missing version field(s): ${missing.map((field) => field.label).join(", ")}`);
  }

  let changed = false;
  if (manifest.version !== version) {
    manifest.version = version;
    changed = true;
  }

  if (
    relativePath.endsWith("package-lock.json") &&
    hasPackageLockRoot(manifest) &&
    manifest.packages[""].version !== version
  ) {
    manifest.packages[""].version = version;
    changed = true;
  }

  if (relativePath === "server.json") {
    for (const pkg of manifest.packages) {
      if (VERSIONED_REGISTRY_TYPES.has(pkg.registryType) && pkg.version !== version) {
        pkg.version = version;
        changed = true;
      }
    }
  }

  return changed;
}

#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { manifestVersionFields, VERSIONED_MANIFESTS } from "./release-manifests.mjs";

function readJson(relativePath) {
  const path = resolve(process.cwd(), relativePath);
  if (!existsSync(path)) throw new Error(`missing release manifest: ${relativePath}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

try {
  const packageManifest = readJson("package.json");
  const expectedVersion = process.argv[2] ?? packageManifest.version;
  if (packageManifest.version !== expectedVersion) {
    throw new Error(
      `package.json.version is ${JSON.stringify(packageManifest.version)}, expected ${JSON.stringify(expectedVersion)}`,
    );
  }

  const mismatches = [];
  for (const relativePath of VERSIONED_MANIFESTS) {
    const manifest = readJson(relativePath);
    for (const field of manifestVersionFields(relativePath, manifest)) {
      if (field.value !== expectedVersion) {
        mismatches.push(
          `${field.label} is ${JSON.stringify(field.value)}, expected ${JSON.stringify(expectedVersion)}`,
        );
      }
    }

    if (relativePath === "server.json") {
      if (manifest.name !== packageManifest.mcpName) {
        mismatches.push(
          `server.json.name is ${JSON.stringify(manifest.name)}, expected package.json.mcpName ${JSON.stringify(packageManifest.mcpName)}`,
        );
      }
      const npmPackage = manifest.packages?.find((pkg) => pkg.registryType === "npm");
      if (npmPackage?.identifier !== packageManifest.name) {
        mismatches.push(
          `server.json npm identifier is ${JSON.stringify(npmPackage?.identifier)}, expected package.json.name ${JSON.stringify(packageManifest.name)}`,
        );
      }
    }
  }

  if (mismatches.length > 0) {
    throw new Error(`release manifest mismatch:\n- ${mismatches.join("\n- ")}`);
  }

  console.log(`release manifests match ${expectedVersion}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

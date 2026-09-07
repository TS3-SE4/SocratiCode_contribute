#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
assert(packageRoot, "Usage: verify-packaged-qdrant.mjs <installed-socraticode-directory>");

const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const serviceUrl = (name) =>
  pathToFileURL(path.join(packageRoot, "dist", "services", `${name}.js`)).href;

const compatibility = await import(serviceUrl("qdrant-client-compat"));
const qdrantClientVersion = compatibility.readInstalledQdrantClientVersion();
assert.match(
  qdrantClientVersion ?? "",
  /^1\.18\./,
  "The consumer smoke test must exercise the declared Qdrant 1.18 dependency without substitution",
);

const { listCodebaseCollections } = await import(serviceUrl("qdrant"));
const collections = await listCodebaseCollections();
assert(Array.isArray(collections), "The packaged Qdrant request did not return a collection list");

process.stdout.write(
  `${JSON.stringify({
    node: process.versions.node,
    socraticode: packageJson.version,
    qdrantClient: qdrantClientVersion,
    qdrantRequest: "passed",
  })}\n`,
);
process.exit(0);

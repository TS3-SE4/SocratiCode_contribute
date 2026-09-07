#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
assert(packageRoot, "Usage: verify-packaged-qdrant.mjs <installed-socraticode-directory>");

const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const packageRequire = createRequire(path.join(packageRoot, "package.json"));
const serviceUrl = (name) =>
  pathToFileURL(path.join(packageRoot, "dist", "services", `${name}.js`)).href;

/** Wait for a predicate without leaving an unbounded integration check. */
async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

/**
 * Prove that the Node 26 transport bridge preserves Qdrant's request timeout
 * through response-body reads and releases the stalled server connection.
 */
async function verifyTimeoutCancellation(compatibility) {
  const { QdrantClient, QdrantClientTimeoutError } = packageRequire(
    "@qdrant/js-client-rest",
  );
  const sockets = new Set();
  let requestReceived = false;
  const server = http.createServer((_request, response) => {
    requestReceived = true;
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": "1000000",
    });
    response.write('{"result":');
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    assert(address && typeof address !== "string", "The timeout probe did not bind a port");
    const url = `http://127.0.0.1:${address.port}`;
    compatibility.ensureQdrantClientCompatibility(url);

    const client = new QdrantClient({ url, timeout: 100, checkCompatibility: false });
    const startedAt = Date.now();
    let failure;
    try {
      await client.getCollections();
    } catch (error) {
      failure = error;
    }
    const elapsedMs = Date.now() - startedAt;

    assert(requestReceived, "The timeout probe did not reach the stalled response handler");
    assert(
      failure instanceof QdrantClientTimeoutError,
      `Expected QdrantClientTimeoutError, received ${failure?.constructor?.name ?? "no error"}`,
    );
    assert(elapsedMs < 2_000, `The timed-out request settled after ${elapsedMs}ms`);
    assert(
      await waitUntil(() => sockets.size === 0, 8_000),
      "The timed-out Qdrant request left its server connection open",
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

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

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (nodeMajor >= 26) {
  await verifyTimeoutCancellation(compatibility);
}

process.stdout.write(
  `${JSON.stringify({
    node: process.versions.node,
    socraticode: packageJson.version,
    qdrantClient: qdrantClientVersion,
    qdrantRequest: "passed",
    timeoutCancellation: nodeMajor >= 26 ? "passed" : "not-applicable",
  })}\n`,
);
process.exit(0);

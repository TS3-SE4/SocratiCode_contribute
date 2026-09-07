// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fetch as undiciFetch } from "undici";

/**
 * Support facts this module encodes (each verified by running the client
 * against a live Qdrant on the real Node majors):
 *
 *   - @qdrant/js-client-rest < 1.19 bundles undici 6, whose Agent the client
 *     hands to Node's built-in fetch. Node 26's built-in fetch (undici 8)
 *     renamed the legacy `onError` handler hook, so the v6 Agent fails
 *     validation and every request dies with
 *     `UND_ERR_INVALID_ARG: invalid onError method`.
 *   - Pairing the client's Agent with fetch from the same undici line avoids
 *     that cross-version handoff. SocratiCode already depends on undici 6 for
 *     its Ollama transport, so the same pairing keeps client 1.18 working on
 *     Node 26 without dropping Node 18 support.
 *   - 1.19+ bundles undici 7 and works on Node 26 without this bridge
 *     (https://github.com/qdrant/qdrant-js/issues/134, fixed in 1.19).
 *
 * The bridge below is deliberately narrow: only Qdrant-origin requests that
 * carry a per-request dispatcher are routed through undici's fetch, and only
 * for the affected Node/client pair. Every other request keeps using the
 * process's original fetch implementation.
 */

const QDRANT_CLIENT_PACKAGE = "@qdrant/js-client-rest";

/**
 * Version of the installed @qdrant/js-client-rest, or null when it cannot
 * be determined.
 *
 * The package's `exports` map exposes only `.`, so
 * `require("@qdrant/js-client-rest/package.json")` throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED; instead the entry file is resolved and the
 * walk goes upward to the nearest package.json that declares the package's
 * own name (the entry sits inside dist/, whose parent directories may hold
 * unrelated package.json files, hence the name check).
 */
export function readInstalledQdrantClientVersion(): string | null {
  let entry: string;
  try {
    entry = createRequire(import.meta.url).resolve(QDRANT_CLIENT_PACKAGE);
  } catch {
    return null; // not installed / not resolvable from here
  }
  let dir = path.dirname(entry);
  // Walk toward the filesystem root; the package root is at most a few
  // levels above the entry file.
  for (;;) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      if (parsed?.name === QDRANT_CLIENT_PACKAGE && typeof parsed.version === "string") {
        return parsed.version;
      }
    } catch {
      // no package.json at this level (or unreadable/malformed) — keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Whether the (node major, installed client version) pair is the one that
 * breaks: Node 26+ with a client older than 1.19.
 *
 * An undeterminable version on Node 26+ refuses too (returns true): the
 * alternative is booting into a possibly-broken client whose first request
 * dies with an opaque undici error, which is exactly what the guard exists
 * to prevent. On Node < 26 the client version is irrelevant.
 */
export type QdrantFetchMode = "native" | "paired-undici" | "unknown";

/** Select the fetch transport required by a Node/Qdrant-client pair. */
export function qdrantFetchMode(
  nodeMajor: number,
  clientVersion: string | null,
): QdrantFetchMode {
  if (!Number.isFinite(nodeMajor) || nodeMajor < 26) return "native";
  if (clientVersion === null) return "unknown";
  // Full semver shape required (prerelease/build tags allowed): a partial
  // match like `1.19.not-a-version` is NOT a version the registry could
  // have served, so transport selection fails closed rather than guessing.
  const numericIdentifier = "(?:0|[1-9]\\d*)";
  const prereleaseIdentifier = `(?:${numericIdentifier}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
  const match = clientVersion.match(
    new RegExp(
      `^(${numericIdentifier})\\.(${numericIdentifier})\\.${numericIdentifier}` +
        `(?:-${prereleaseIdentifier}(?:\\.${prereleaseIdentifier})*)?` +
        "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
    ),
  );
  if (!match) return "unknown";
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  return major < 1 || (major === 1 && minor < 19) ? "paired-undici" : "native";
}

type FetchFunction = typeof globalThis.fetch;
type DispatcherRequestInit = RequestInit & { dispatcher?: unknown };

function requestOrigin(input: Parameters<FetchFunction>[0]): string | null {
  try {
    if (typeof input === "string") return new URL(input).origin;
    if (input instanceof URL) return input.origin;
    return new URL(input.url).origin;
  } catch {
    return null;
  }
}

/**
 * Build a fetch wrapper that pairs Qdrant's undici dispatcher with undici's
 * own fetch. Errors propagate unchanged; there is no retry or fallback path.
 */
export function createQdrantFetchBridge(
  nativeFetch: FetchFunction,
  pairedFetch: FetchFunction,
  qdrantOrigins: ReadonlySet<string>,
): FetchFunction {
  return (input, init) => {
    const dispatcher = (init as DispatcherRequestInit | undefined)?.dispatcher;
    if (dispatcher !== undefined) {
      const origin = requestOrigin(input);
      if (origin !== null && qdrantOrigins.has(origin)) {
        return pairedFetch(input, init);
      }
    }
    return nativeFetch(input, init);
  };
}

const bridgedQdrantOrigins = new Set<string>();
let bridgeInstalled = false;

/**
 * Install the Node 26/Qdrant 1.18 transport bridge once for the configured
 * Qdrant origin. Repeated calls only register an additional origin.
 */
export function ensureQdrantClientCompatibility(qdrantBaseUrl: string): void {
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const clientVersion = readInstalledQdrantClientVersion();
  const mode = qdrantFetchMode(nodeMajor, clientVersion);
  if (mode === "native") return;
  if (mode === "unknown") {
    throw new Error(
      `socraticode: cannot determine the installed @qdrant/js-client-rest version on Node ${process.versions.node}; ` +
        "cannot select a safe Qdrant transport.",
    );
  }

  bridgedQdrantOrigins.add(new URL(qdrantBaseUrl).origin);
  if (bridgeInstalled) return;

  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = createQdrantFetchBridge(
    nativeFetch,
    undiciFetch as unknown as FetchFunction,
    bridgedQdrantOrigins,
  );
  bridgeInstalled = true;
}

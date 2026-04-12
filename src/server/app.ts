import express from "express";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, formatExpandedPlan } from "../compiler.js";
import { validate } from "../validator.js";
import { loadSpecFile } from "../loader.js";
import type {
  Spec,
  ExecutableStep,
  BrowserStep,
  ApiContract,
} from "../types.js";

const __serverDir = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Suite ID encoding (base64url of relative file path)
// ---------------------------------------------------------------------------

export function encodeSuiteId(relativePath: string): string {
  return Buffer.from(relativePath).toString("base64url");
}

export function decodeSuiteId(id: string): string {
  return Buffer.from(id, "base64url").toString("utf-8");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerSuite = {
  id: string;
  name: string;
  path: string;
  relativePath: string;
  spec: Spec | null;
  loadError: string | null;
};

// ---------------------------------------------------------------------------
// Action summary formatters (for the /plan browse endpoint)
// ---------------------------------------------------------------------------

function formatActionSummary(step: ExecutableStep): string {
  const action = step.action;
  if (action.__type === "api") {
    return `${action.method} ${action.path}`;
  }
  if (action.__type === "browser") {
    const b = action as BrowserStep & {
      action: string;
      target?: unknown;
      url?: unknown;
    };
    const target = b.target ?? b.url ?? "";
    return `browser.${b.action}(${JSON.stringify(target)})`;
  }
  if (action.__type === "expect") {
    return `expect ${action.matcher}`;
  }
  return "unknown";
}

function formatExpectSummaries(step: ExecutableStep): string[] {
  const parts: string[] = [];
  if (step.inlineExpect?.status !== undefined) {
    parts.push(`status: ${step.inlineExpect.status}`);
  }
  if (step.inlineExpect?.body !== undefined) {
    parts.push(`body: ${JSON.stringify(step.inlineExpect.body)}`);
  }
  for (const e of step.expects) {
    const exp =
      e.expected !== undefined ? ` ${JSON.stringify(e.expected)}` : "";
    parts.push(`${e.matcher}${exp}`);
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Suite step count (flattening sections)
// ---------------------------------------------------------------------------

function countSteps(spec: Spec): number {
  let count = 0;
  for (const f of spec.flows) {
    for (const item of f.steps) {
      if (
        "__type" in item &&
        (item as { __type: string }).__type === "section"
      ) {
        count += (item as { steps: unknown[] }).steps.length;
      } else {
        count++;
      }
    }
  }
  return count;
}

// ---------------------------------------------------------------------------
// Express app factory
// ---------------------------------------------------------------------------

export function createApp(suites: ServerSuite[]): express.Application {
  const app = express();
  app.use(express.json());

  const suiteMap = new Map<string, ServerSuite>();
  for (const s of suites) suiteMap.set(s.id, s);

  // Build a cross-suite contract index: name → { contract, suites[] }
  type ContractEntry = {
    contract: ApiContract;
    suites: { id: string; name: string }[];
  };
  const contractIndex = new Map<string, ContractEntry>();
  for (const s of suites) {
    if (s.spec === null) continue;
    for (const [name, contract] of Object.entries(s.spec.apis ?? {})) {
      const existing = contractIndex.get(name);
      if (existing === undefined) {
        contractIndex.set(name, {
          contract,
          suites: [{ id: s.id, name: s.name }],
        });
      } else {
        existing.suites.push({ id: s.id, name: s.name });
      }
    }
  }

  const pagesDir = join(__serverDir, "pages");
  app.use(express.static(pagesDir));

  // -------------------------------------------------------------------------
  // GET /api/suites -- list all discovered suites
  //
  // Optional query params:
  //   ?name=<substring>  case-insensitive substring match on suite name
  //   ?tag=<value>       case-insensitive exact match against suite tags
  //
  // Results are sorted lexically by relativePath (stable across requests).
  // -------------------------------------------------------------------------

  app.get("/api/suites", (req, res) => {
    const nameFilter =
      typeof req.query["name"] === "string"
        ? req.query["name"].toLowerCase()
        : null;
    const tagFilter =
      typeof req.query["tag"] === "string"
        ? req.query["tag"].toLowerCase()
        : null;

    const sorted = [...suites].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );

    const filtered = sorted.filter((s) => {
      if (nameFilter !== null && !s.name.toLowerCase().includes(nameFilter))
        return false;
      if (tagFilter !== null) {
        const tags = s.spec?.tags ?? [];
        if (!tags.some((t) => t.toLowerCase() === tagFilter)) return false;
      }
      return true;
    });

    const result = filtered.map((s) => ({
      id: s.id,
      name: s.name,
      path: s.relativePath,
      flowCount: s.spec !== null ? s.spec.flows.length : 0,
      tags: s.spec !== null ? (s.spec.tags ?? []) : [],
      hasError: s.loadError !== null,
      expectedOutcome: s.spec?.expectedOutcome ?? "pass",
    }));

    res.json({ suites: result });
  });

  // -------------------------------------------------------------------------
  // GET /api/suites/:id -- metadata for one suite
  // -------------------------------------------------------------------------

  app.get("/api/suites/:id", (req, res) => {
    const suite = suiteMap.get(req.params["id"] ?? "");
    if (suite === undefined) {
      res.status(404).json({ error: "Suite not found" });
      return;
    }
    if (suite.loadError !== null || suite.spec === null) {
      res.status(500).json({ error: suite.loadError ?? "Failed to load spec" });
      return;
    }
    const { spec } = suite;
    res.json({
      id: suite.id,
      name: spec.name,
      path: suite.relativePath,
      flowNames: spec.flows.map((f) => f.name),
      stepCount: countSteps(spec),
      apiNames: Object.keys(spec.apis ?? {}),
      tags: spec.tags ?? [],
      safety: spec.safety ?? null,
      expectedOutcome: spec.expectedOutcome ?? "pass",
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/suites/:id/plan -- browse-oriented expanded plan for the web UI
  //
  // Returns display-friendly summaries: step action strings, rendered plan
  // text, and validation diagnostics. Not intended for CLI consumption.
  // -------------------------------------------------------------------------

  app.get("/api/suites/:id/plan", (req, res) => {
    const suite = suiteMap.get(req.params["id"] ?? "");
    if (suite === undefined) {
      res.status(404).json({ error: "Suite not found" });
      return;
    }
    if (suite.loadError !== null || suite.spec === null) {
      res.status(500).json({ error: suite.loadError ?? "Failed to load spec" });
      return;
    }

    let plan: ReturnType<typeof compile>;
    try {
      plan = compile(suite.spec);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const validation = validate(suite.spec, plan);

    const rawBaseUrl = plan.baseUrl;
    const baseUrlStr =
      typeof rawBaseUrl === "string"
        ? rawBaseUrl || null
        : `${(rawBaseUrl as { __type: string; name?: string }).__type}("${(rawBaseUrl as { name?: string }).name ?? ""}")`;

    const urlsDisplay: Record<string, string | null> = {};
    for (const [key, val] of Object.entries(plan.urls)) {
      urlsDisplay[key] =
        typeof val === "string"
          ? val || null
          : `${(val as { __type: string; name?: string }).__type}("${(val as { name?: string }).name ?? ""}")`;
    }

    const steps = plan.steps.map((s) => ({
      name: s.name,
      section: s.section ?? null,
      flowOrigin: s.flowOrigin ?? null,
      actionType: s.action.__type as "api" | "browser" | "expect",
      actionSummary: formatActionSummary(s),
      retries: s.retries,
      ...(s.retryIntervalMs !== undefined
        ? { retryIntervalMs: s.retryIntervalMs }
        : {}),
      saves: Object.keys(s.saves),
      expects: formatExpectSummaries(s),
    }));

    res.json({
      specName: plan.specName,
      baseUrl: baseUrlStr,
      urls: urlsDisplay,
      steps,
      flowRanges: plan.flowRanges.map((r) => ({
        name: r.name,
        startIndex: r.startIndex,
        stepCount: r.stepCount,
      })),
      validation: {
        errors: validation.errors.map((e) => e.message),
        warnings: validation.warnings.map((w) => w.message),
      },
      renderedPlan: formatExpandedPlan(plan),
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/suites/:id/execution-plan -- versioned machine-readable artifact
  //
  // Returns the raw ExecutionPlan for CLI consumption. env() and secret()
  // markers are preserved unresolved — the CLI resolves them from the user's
  // own environment. planVersion allows the CLI to detect format changes.
  // -------------------------------------------------------------------------

  app.get("/api/suites/:id/execution-plan", (req, res) => {
    const suite = suiteMap.get(req.params["id"] ?? "");
    if (suite === undefined) {
      res.status(404).json({ error: "Suite not found" });
      return;
    }
    if (suite.loadError !== null || suite.spec === null) {
      res.status(500).json({ error: suite.loadError ?? "Failed to load spec" });
      return;
    }

    let plan: ReturnType<typeof compile>;
    try {
      plan = compile(suite.spec);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const validation = validate(suite.spec, plan);

    res.json({
      planVersion: 1,
      plan,
      validation: {
        errors: validation.errors.map((e) => e.message),
        warnings: validation.warnings.map((w) => w.message),
      },
      expectedOutcome: suite.spec.expectedOutcome ?? "pass",
      tags: suite.spec.tags ?? [],
      safety: suite.spec.safety ?? null,
    });
  });

  // -------------------------------------------------------------------------
  // GET /api/contracts -- list all contracts aggregated across suites
  // -------------------------------------------------------------------------

  app.get("/api/contracts", (_req, res) => {
    const result = Array.from(contractIndex.entries()).map(([name, entry]) => ({
      name,
      method: entry.contract.method,
      path: entry.contract.path,
      purpose: entry.contract.purpose ?? null,
      suiteCount: entry.suites.length,
    }));
    res.json({ contracts: result });
  });

  // -------------------------------------------------------------------------
  // GET /api/contracts/:name -- full contract detail with using suites
  // -------------------------------------------------------------------------

  app.get("/api/contracts/:name", (req, res) => {
    const entry = contractIndex.get(req.params["name"] ?? "");
    if (entry === undefined) {
      res.status(404).json({ error: "Contract not found" });
      return;
    }
    const { contract, suites: usingSuites } = entry;
    res.json({
      name: req.params["name"],
      method: contract.method,
      path: contract.path,
      purpose: contract.purpose ?? null,
      request: contract.request ?? null,
      response: contract.response ?? null,
      suites: usingSuites,
    });
  });

  // SPA fallback -- must be declared last
  app.get("*", (_req, res) => {
    res.sendFile(join(pagesDir, "index.html"));
  });

  return app;
}

// ---------------------------------------------------------------------------
// Suite discovery -- load all specs matching a glob at startup
// ---------------------------------------------------------------------------

export async function discoverSuites(
  globPattern: string,
  cwd: string,
): Promise<ServerSuite[]> {
  const { resolveGlob } = await import("../loader.js");
  const { relative, resolve } = await import("node:path");

  const files = await resolveGlob(globPattern);
  const suites: ServerSuite[] = [];

  for (const file of files) {
    const absPath = resolve(file);
    const rel = relative(cwd, absPath);
    const id = encodeSuiteId(rel);

    const loaded = await loadSpecFile(absPath);
    suites.push({
      id,
      name: loaded.spec !== null ? loaded.spec.name : rel,
      path: absPath,
      relativePath: rel,
      spec: loaded.spec,
      loadError: loaded.error,
    });
  }

  return suites;
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function startServer(
  suites: ServerSuite[],
  port = 4000,
): Promise<ReturnType<typeof createServer>> {
  const app = createApp(suites);

  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.on("error", reject);
    server.listen(port, () => {
      server.off("error", reject);
      console.log(`Ortheon server running at http://localhost:${port}`);
      console.log(`Serving ${suites.length} spec(s)`);
      suites
        .filter((s) => s.loadError !== null)
        .forEach((s) =>
          console.warn(
            `  warning: failed to load "${s.relativePath}": ${s.loadError ?? ""}`,
          ),
        );
      resolve(server);
    });
  });
}

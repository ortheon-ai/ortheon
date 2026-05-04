import express from "express";
import type { RequestHandler } from "express";
import { createServer } from "node:http";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile, compileAgent, compileWorkflow, flattenTools, formatExpandedPlan, formatAgentPlan, formatWorkflowPlan } from "../compiler.js";
import { validate, validateAgent, validateWorkflow, validateWorkflowCollection } from "../validator.js";
import { loadSpecFile } from "../loader.js";
import type {
  AgentSpec,
  Spec,
  WorkflowSpec,
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
  kind: "spec" | "agent" | "workflow" | null;
  spec: Spec | null;
  agentSpec: AgentSpec | null;
  workflowSpec: WorkflowSpec | null;
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

function isAgentSuite(s: ServerSuite): s is ServerSuite & { kind: "agent"; agentSpec: AgentSpec } {
  return s.kind === "agent" && s.agentSpec !== null;
}

function isWorkflowSuite(s: ServerSuite): s is ServerSuite & { kind: "workflow"; workflowSpec: WorkflowSpec } {
  return s.kind === "workflow" && s.workflowSpec !== null;
}

// ---------------------------------------------------------------------------
// Server options
// ---------------------------------------------------------------------------

export type ServerOptions = {
  /** Additional Express middleware to mount after json parsing, before routes. */
  middleware?: RequestHandler[];
  /** Host / interface to bind the HTTP server to (default: all interfaces). */
  host?: string | undefined;
};

// ---------------------------------------------------------------------------
// Express app factory
// ---------------------------------------------------------------------------

export function createApp(suites: ServerSuite[], opts: ServerOptions = {}): express.Application {
  const app = express();
  app.use(express.json());

  for (const mw of opts.middleware ?? []) {
    app.use(mw);
  }

  const suiteMap = new Map<string, ServerSuite>();
  for (const s of suites) suiteMap.set(s.id, s);

  // Build a cross-suite contract index: name → { contract, suites[] }
  // Agent suites have no API contracts.
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
        // Agent specs have no tags
        const tags = s.spec?.tags ?? [];
        if (!tags.some((t) => t.toLowerCase() === tagFilter)) return false;
      }
      return true;
    });

    const result = filtered.map((s) => {
      if (s.kind === null) {
        return {
          id: s.id,
          name: s.name,
          path: s.relativePath,
          type: "unknown" as const,
          hasError: true,
        };
      }
      if (isAgentSuite(s)) {
        return {
          id: s.id,
          name: s.name,
          path: s.relativePath,
          type: "agent" as const,
          toolCount: flattenTools(s.agentSpec.tools).length,
          hasError: false,
        };
      }
      if (isWorkflowSuite(s)) {
        return {
          id: s.id,
          name: s.name,
          path: s.relativePath,
          type: "workflow" as const,
          stepCount: s.workflowSpec.steps.length,
          triggerKind: s.workflowSpec.trigger.kind,
          hasError: false,
        };
      }
      return {
        id: s.id,
        name: s.name,
        path: s.relativePath,
        type: "spec" as const,
        flowCount: s.spec !== null ? s.spec.flows.length : 0,
        tags: s.spec !== null ? (s.spec.tags ?? []) : [],
        hasError: s.loadError !== null,
        expectedOutcome: s.spec?.expectedOutcome ?? "pass",
      };
    });

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
    if (suite.loadError !== null || (suite.spec === null && suite.agentSpec === null && suite.workflowSpec === null)) {
      res.status(500).json({ error: suite.loadError ?? "Failed to load spec" });
      return;
    }

    if (isAgentSuite(suite)) {
      const { agentSpec } = suite;
      const tools = flattenTools(agentSpec.tools);
      res.json({
        id: suite.id,
        name: agentSpec.name,
        path: suite.relativePath,
        type: "agent",
        toolNames: tools.map((t) => t.name),
        toolCount: tools.length,
      });
      return;
    }

    if (isWorkflowSuite(suite)) {
      const { workflowSpec } = suite;
      res.json({
        id: suite.id,
        name: workflowSpec.name,
        path: suite.relativePath,
        type: "workflow",
        trigger: workflowSpec.trigger,
        stepNames: workflowSpec.steps.map((s) => s.specName),
        stepCount: workflowSpec.steps.length,
        gateCount: workflowSpec.steps.reduce(
          (n, s) => n + (s.approveBefore ? 1 : 0) + (s.approveAfter ? 1 : 0),
          0,
        ),
      });
      return;
    }

    const { spec } = suite;
    if (spec === null) {
      res.status(500).json({ error: "Failed to load spec" });
      return;
    }
    res.json({
      id: suite.id,
      name: spec.name,
      path: suite.relativePath,
      type: "spec",
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
    if (suite.loadError !== null || (suite.spec === null && suite.agentSpec === null && suite.workflowSpec === null)) {
      res.status(500).json({ error: suite.loadError ?? "Failed to load spec" });
      return;
    }

    // Workflow spec browse plan
    if (isWorkflowSuite(suite)) {
      let workflowPlan: ReturnType<typeof compileWorkflow>;
      try {
        workflowPlan = compileWorkflow(suite.workflowSpec);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const validation = validateWorkflow(suite.workflowSpec);
      res.json({
        planType: "workflow",
        specName: workflowPlan.specName,
        trigger: workflowPlan.trigger,
        steps: workflowPlan.steps,
        gates: workflowPlan.gates,
        validation: {
          errors: validation.errors.map((e) => e.message),
          warnings: validation.warnings.map((w) => w.message),
        },
        renderedPlan: formatWorkflowPlan(workflowPlan),
      });
      return;
    }

    // Agent spec browse plan
    if (isAgentSuite(suite)) {
      let agentPlan: ReturnType<typeof compileAgent>;
      try {
        agentPlan = compileAgent(suite.agentSpec);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const validation = validateAgent(suite.agentSpec);
      res.json({
        planType: "agent",
        specName: agentPlan.specName,
        tools: agentPlan.tools,
        validation: {
          errors: validation.errors.map((e) => e.message),
          warnings: validation.warnings.map((w) => w.message),
        },
        renderedPlan: formatAgentPlan(agentPlan),
      });
      return;
    }

    if (suite.spec === null) {
      res.status(500).json({ error: "Failed to load spec" });
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

    const urlsDisplay: Record<string, string | null> = {};
    for (const [key, val] of Object.entries(plan.urls)) {
      urlsDisplay[key] =
        typeof val === "string"
          ? val || null
          : `${(val as { __type: string; name?: string }).__type}("${(val as { name?: string }).name ?? ""}")`;
    }
    // Derive baseUrl display from urls['default'] so an explicit urls['default'] override is reflected.
    const baseUrlStr = urlsDisplay["default"] ?? null;

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
      planType: "behavioral",
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
    if (suite.loadError !== null || (suite.spec === null && suite.agentSpec === null && suite.workflowSpec === null)) {
      res.status(500).json({ error: suite.loadError ?? "Failed to load spec" });
      return;
    }

    // Workflow spec execution plan
    if (isWorkflowSuite(suite)) {
      let workflowPlan: ReturnType<typeof compileWorkflow>;
      try {
        workflowPlan = compileWorkflow(suite.workflowSpec);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const validation = validateWorkflow(suite.workflowSpec);
      res.json({
        planType: "workflow",
        planVersion: 1,
        plan: workflowPlan,
        validation: {
          errors: validation.errors.map((e) => e.message),
          warnings: validation.warnings.map((w) => w.message),
        },
      });
      return;
    }

    // Agent spec execution plan
    if (isAgentSuite(suite)) {
      let agentPlan: ReturnType<typeof compileAgent>;
      try {
        agentPlan = compileAgent(suite.agentSpec);
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
      const validation = validateAgent(suite.agentSpec);
      res.json({
        planType: "agent",
        planVersion: 1,
        plan: agentPlan,
        validation: {
          errors: validation.errors.map((e) => e.message),
          warnings: validation.warnings.map((w) => w.message),
        },
      });
      return;
    }

    if (suite.spec === null) {
      res.status(500).json({ error: "Failed to load spec" });
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
      planType: "behavioral",
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

    if (loaded.kind === "spec") {
      suites.push({
        id,
        name: loaded.spec.name,
        path: absPath,
        relativePath: rel,
        kind: "spec",
        spec: loaded.spec,
        agentSpec: null,
        workflowSpec: null,
        loadError: null,
      });
    } else if (loaded.kind === "agent") {
      suites.push({
        id,
        name: loaded.spec.name,
        path: absPath,
        relativePath: rel,
        kind: "agent",
        spec: null,
        agentSpec: loaded.spec,
        workflowSpec: null,
        loadError: null,
      });
    } else if (loaded.kind === "workflow") {
      suites.push({
        id,
        name: loaded.spec.name,
        path: absPath,
        relativePath: rel,
        kind: "workflow",
        spec: null,
        agentSpec: null,
        workflowSpec: loaded.spec,
        loadError: null,
      });
    } else {
      suites.push({
        id,
        name: rel,
        path: absPath,
        relativePath: rel,
        kind: null,
        spec: null,
        agentSpec: null,
        workflowSpec: null,
        loadError: loaded.error,
      });
    }
  }

  return suites;
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

export async function startServer(
  suites: ServerSuite[],
  port = 4000,
  opts: ServerOptions = {},
): Promise<ReturnType<typeof createServer>> {
  const app = createApp(suites, opts);

  return new Promise((resolve, reject) => {
    const server = createServer(app);
    server.on("error", reject);
    const host = opts.host;

    const onListening = () => {
      server.off("error", reject);
      const displayAddr = host ?? "localhost";
      const displayHost = (h: string) => h.includes(":") ? `[${h}]` : h;
      console.log(`Ortheon server running at http://${displayHost(displayAddr)}:${port}`);
      console.log(`Serving ${suites.length} spec(s)`);
      suites
        .filter((s) => s.loadError !== null)
        .forEach((s) =>
          console.warn(
            `  warning: failed to load "${s.relativePath}": ${s.loadError ?? ""}`,
          ),
        );

      // Cross-spec uniqueness check: duplicate trigger keys cause fan-out runs.
      const workflowSpecs = suites
        .filter((s) => s.kind === "workflow" && s.workflowSpec !== null)
        .map((s) => s.workflowSpec as WorkflowSpec);
      if (workflowSpecs.length > 0) {
        const collectionResult = validateWorkflowCollection(workflowSpecs);
        if (collectionResult.errors.length > 0) {
          for (const err of collectionResult.errors) {
            console.error(`  ERROR: ${err.message}`);
          }
          server.close();
          reject(
            new Error(
              `Duplicate workflow trigger keys detected — fix spec collisions before starting: ` +
                collectionResult.errors.map((e) => e.message).join("; "),
            ),
          );
          return;
        }
      }

      resolve(server);
    };

    if (host !== undefined) {
      server.listen(port, host, onListening);
    } else {
      server.listen(port, onListening);
    }
  });
}

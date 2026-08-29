import { Controller, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MarketService } from "./market.service";
import { PostingsService } from "./postings.service";
import { RunsService } from "./runs.service";
import {
  principalFromRequest,
  requirePrincipalKind,
  AuthPrincipal,
} from "./auth-principal";

function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(cause: unknown): CallToolResult {
  const message = cause instanceof Error ? cause.message : String(cause);
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Wraps a tool handler so a thrown `BadRequestException`/`NotFoundException`
 * (`RunsService`'s error type, shared with the REST path) becomes an
 * `isError` tool result instead of an uncaught rejection — the MCP-side
 * translation of what a NestJS exception filter does automatically for
 * `RunsController`. */
async function safely(fn: () => unknown): Promise<CallToolResult> {
  try {
    return jsonResult(await fn());
  } catch (cause) {
    return errorResult(cause);
  }
}

/**
 * The MCP surface (M9) — every tool calls the same `RunsService` method
 * `RunsController`'s matching REST route calls, so "run collect" has
 * exactly one implementation regardless of which of the two protocols
 * Hermes speaks. Protected by the same global `ApiKeyGuard` as every other
 * route (`ApiModule`) — MCP-over-HTTP is still HTTP.
 *
 * A fresh `McpServer` + stateless `StreamableHTTPServerTransport`
 * (`sessionIdGenerator: undefined`) **per request**, not one held for the
 * app's lifetime — the SDK enforces this itself ("Stateless transport
 * cannot be reused across requests. Create a new transport per request."),
 * discovered by reproducing a 500 on the second message of every session
 * (`initialize` succeeds, the client's follow-up `notifications/initialized`
 * fails) against a real running server, not a test-harness artifact. Each
 * pair is thrown away once the response finishes — cheap, since every tool
 * handler is a self-contained call into `RunsService` with no state to
 * preserve between requests anyway.
 */
@Controller("mcp")
export class McpController {
  constructor(
    private readonly runs: RunsService,
    private readonly market: MarketService,
    private readonly postings: PostingsService,
  ) {}

  @Post()
  async handle(@Req() req: Request, @Res() res: Response): Promise<void> {
    const server = new McpServer({ name: "argos-career", version: "1.0.0" });
    this.registerTools(server, principalFromRequest(req));

    // Explicit `undefined` is stateless mode (the SDK's own documented way
    // to request it) — a cast is needed only because the project's
    // `exactOptionalPropertyTypes` is stricter than this option's declared
    // type allows for an intentionally-undefined value, not because the
    // value itself is wrong. `enableJsonResponse: true`: no tool here
    // pushes unprompted server-to-client messages, so there is nothing to
    // keep an SSE stream open for, and a plain JSON response per call is
    // simpler to reason about for a transport that already lives for one
    // request only.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    } as unknown as StreamableHTTPServerTransportOptions);

    res.on("close", () => {
      transport.close();
      server.close();
    });

    // Same `exactOptionalPropertyTypes` friction as above — `Transport`'s
    // optional callback properties (`onclose`, etc.) are genuinely
    // implemented by `StreamableHTTPServerTransport`; the cast is a type
    // annotation gap, not a real structural mismatch.
    await server.connect(transport as Transport);
    await transport.handleRequest(req, res, req.body);
  }

  private registerTools(server: McpServer, principal: AuthPrincipal): void {
    server.registerTool(
      "get_health",
      {
        description:
          "Last successful run per kind (collect, dedup, scoreAndDeliver).",
      },
      () => safely(() => this.runs.health()),
    );

    server.registerTool(
      "list_runs",
      {
        description: "Recent runs of a given kind, newest first.",
        inputSchema: {
          kind: z.string().describe("collect | dedup | scoreAndDeliver"),
          limit: z.number().int().positive().optional(),
        },
      },
      ({ kind, limit }) => safely(() => this.runs.list(kind, limit)),
    );

    server.registerTool(
      "get_run",
      {
        description: "A single run's full detail by runId.",
        inputSchema: { runId: z.string() },
      },
      ({ runId }) => safely(() => this.runs.detail(runId)),
    );

    server.registerTool(
      "run_collect",
      {
        description:
          "Trigger a collection cycle now (no LLM, no cost — same as the scheduled cron).",
        inputSchema: {
          jobName: z.string().optional(),
          city: z.string().optional(),
          maxResults: z.number().int().positive().optional(),
        },
      },
      (params) => safely(() => this.runs.collect(params, principal.id)),
    );

    server.registerTool(
      "run_dedup",
      { description: "Re-scan the corpus for near-duplicates now." },
      () => safely(() => this.runs.dedup(principal.id)),
    );

    server.registerTool(
      "run_deliver",
      {
        description:
          "Trigger scoring and delivery now. Real: spends API credit unless " +
          "SCORER_ADAPTER=stub, and sends a real Telegram message — the same " +
          "thing the nightly cron does, callable early.",
      },
      () => safely(() => this.runs.deliver(principal.id)),
    );

    server.registerTool(
      "cancel_run",
      {
        description:
          "Request that an in-flight run stop at its next checkpoint " +
          "(docs/11-known-issues.md C1). Cooperative, not immediate — " +
          "only scoreAndDeliver has a checkpoint that observes this today; " +
          "use get_run to see the eventual 'cancelled' outcome.",
        inputSchema: {
          kind: z.string().describe("Only 'scoreAndDeliver' is accepted."),
        },
      },
      ({ kind }) => safely(() => this.runs.cancel(kind)),
    );

    server.registerTool(
      "get_study_plan",
      {
        description:
          "Generate and send the market-intelligence study plan now (M10): " +
          "skills frequent in high-compatibility postings and absent from " +
          "the profile, ranked by demand, sent as a real Telegram message. " +
          "Read-only over the corpus — never scores anything, never spends " +
          "LLM budget.",
      },
      () => safely(() => this.market.studyPlan()),
    );

    server.registerTool(
      "list_postings",
      {
        description:
          "List postings from the corpus for analysis (ADR-072) — company, " +
          "title, verdict, score, tracks, and the manual 'applied' bookmark. " +
          "Read-only: never scores anything, never spends LLM budget, reads " +
          "only what Stage A/B already cached. Sorted by score, descending.",
        inputSchema: {
          verdict: z
            .enum(["apply", "review", "discard"])
            .optional()
            .describe("Filter to one scoring verdict."),
          applied: z
            .boolean()
            .optional()
            .describe("Filter by the manual applied/not-applied bookmark."),
          track: z
            .string()
            .optional()
            .describe("dev | security | automation | data"),
          sinceDays: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("Only postings first seen in the last N days."),
          limit: z.number().int().positive().optional(),
        },
      },
      (params) => safely(() => this.postings.list(params)),
    );

    server.registerTool(
      "mark_applied",
      {
        description:
          "Mark a posting as applied to (ADR-072) — a manual bookmark, " +
          "reversible with unmark_applied. Not automatic application " +
          "(CLAUDE.md §2 non-goal) and not the Phase 2 feedback loop: no " +
          "outcome or response is tracked, only that you applied.",
        inputSchema: {
          fingerprint: z.string().describe("The posting's fingerprint."),
        },
      },
      ({ fingerprint }) =>
        safely(() => {
          // Same reason `discard_posting` gates below: `ApiKeyGuard`
          // allowlists `POST /mcp` for an `automation` principal but not
          // `/postings/*`, so without this an automation key could mutate
          // through MCP exactly what it is denied over REST.
          requirePrincipalKind(principal, ["admin"]);
          return this.postings.markApplied(fingerprint);
        }),
    );

    server.registerTool(
      "unmark_applied",
      {
        description: "Clear the applied bookmark set by mark_applied.",
        inputSchema: {
          fingerprint: z.string().describe("The posting's fingerprint."),
        },
      },
      ({ fingerprint }) =>
        safely(() => {
          requirePrincipalKind(principal, ["admin"]);
          return this.postings.unmarkApplied(fingerprint);
        }),
    );

    server.registerTool(
      "discard_posting",
      {
        description:
          "Permanently reject a posting by fingerprint — a human decision, " +
          "never surfaced again regardless of future profile changes or " +
          "re-scoring. There is no undo tool; reversing it means a direct " +
          "database edit.",
        inputSchema: {
          fingerprint: z.string().describe("The posting's fingerprint."),
          reason: z.string().optional().describe("Optional free-text note."),
        },
      },
      ({ fingerprint, reason }) =>
        safely(() => {
          requirePrincipalKind(principal, ["admin"]);
          return this.postings.discard(fingerprint, reason);
        }),
    );
  }
}

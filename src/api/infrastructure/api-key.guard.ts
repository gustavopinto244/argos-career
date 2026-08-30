import { createHash, timingSafeEqual } from "node:crypto";
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Request } from "express";
import { AuthenticatedRequest, AuthPrincipal } from "./auth-principal";

const BEARER_PREFIX = "Bearer ";

/**
 * Every route requires a scoped Bearer credential (ADR-047). Hermes reaches
 * this API from a different machine over Tailscale, while n8n and host-side
 * collectors cross other network/process boundaries, so the guard identifies
 * the caller before authorizing capabilities. API_ADMIN_KEY is the full-access
 * credential; API_KEY remains a temporary compatibility fallback for it.
 *
 * Applied globally via `APP_GUARD` (`ApiModule`) — every route is
 * authenticated by default, not opt-in per controller, so a new endpoint
 * added later cannot forget it.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly credentials: readonly {
    readonly digest: Buffer;
    readonly principal: AuthPrincipal;
  }[];

  constructor() {
    const adminKey = process.env.API_ADMIN_KEY ?? process.env.API_KEY;
    if (!adminKey) {
      // docs/09-configuration.md rule 1: fail at startup, never lazily. A
      // guard that silently accepted every request because the key was
      // unset would be worse than the process refusing to boot.
      throw new Error(
        "API_ADMIN_KEY is not set (legacy API_KEY is accepted during migration)",
      );
    }
    const configured: { key: string; principal: AuthPrincipal }[] = [
      {
        key: adminKey,
        principal: { id: principalId("admin", adminKey), kind: "admin" },
      },
    ];
    addCredential(configured, "automation", process.env.API_AUTOMATION_KEY, {
      kind: "automation",
    });
    // ADR-075: Hermes reporting application feedback (a response, an
    // interview, an outcome) it read from its own Gmail access is a
    // materially different trust level from "runs a pipeline stage" —
    // ADR-047's own least-privilege reasoning argues against folding this
    // into `automation`, which can spend LLM/Telegram budget and touch
    // collection. This principal reaches only `POST /mcp`; per-tool scoping
    // (list_postings, mark_applied/unmark_applied, the two application-event
    // tools — never discard_posting or any run_* tool) is enforced inside
    // `mcp.controller.ts`, the same way `automation` itself is scoped below
    // the REST-route allowlist here.
    addCredential(configured, "feedback", process.env.API_FEEDBACK_KEY, {
      kind: "feedback",
    });
    for (const source of ["catho", "indeed", "linkedin"] as const) {
      addCredential(
        configured,
        `ingest:${source}`,
        process.env[`INGEST_${source.toUpperCase()}_API_KEY`],
        { kind: "source-ingest", source },
      );
    }
    const digests = configured.map(({ key }) => digest(key).toString("hex"));
    if (new Set(digests).size !== digests.length) {
      throw new Error(
        "API credentials for different principals must use distinct values",
      );
    }
    this.credentials = configured.map(({ key, principal }) => ({
      digest: digest(key),
      principal,
    }));
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;

    if (!header?.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException(
        "Missing or malformed Authorization header",
      );
    }

    const provided = header.slice(BEARER_PREFIX.length);
    // Both sides hashed to a fixed-length digest before comparing: a raw
    // `timingSafeEqual` on the tokens themselves throws on unequal length
    // (rejecting a short guess faster than a long one, a timing leak of
    // exactly the kind this function exists to prevent) and hashing first
    // removes the length signal entirely, not just the length mismatch.
    const providedDigest = digest(provided);
    const credential = this.credentials.find(({ digest: expected }) =>
      timingSafeEqual(providedDigest, expected),
    );
    if (!credential) {
      throw new UnauthorizedException("Invalid API key");
    }

    authorizeRequest(request, credential.principal);
    (request as AuthenticatedRequest).authPrincipal = credential.principal;

    return true;
  }
}

function addCredential(
  configured: { key: string; principal: AuthPrincipal }[],
  label: string,
  key: string | undefined,
  principal:
    | { readonly kind: "admin" }
    | { readonly kind: "automation" }
    | { readonly kind: "source-ingest"; readonly source: string }
    | { readonly kind: "feedback" },
): void {
  if (!key) return;
  configured.push({
    key,
    principal: { ...principal, id: principalId(label, key) } as AuthPrincipal,
  });
}

function principalId(label: string, key: string): string {
  return `${label}:${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

function authorizeRequest(request: Request, principal: AuthPrincipal): void {
  if (principal.kind === "admin") return;

  // Express accepts a trailing slash for these routes by default. Normalize it
  // before comparing capabilities so `/runs/collect/external/` cannot bypass
  // the same policy enforced for `/runs/collect/external`.
  const path =
    request.path.length > 1 ? request.path.replace(/\/+$/, "") : request.path;
  if (principal.kind === "automation") {
    const allowed =
      (request.method === "GET" &&
        (path === "/health" ||
          path === "/runs" ||
          /^\/runs\/[^/]+$/.test(path))) ||
      (request.method === "POST" &&
        new Set([
          "/runs/collect",
          "/runs/dedup",
          "/runs/deliver",
          "/market/study-plan",
          "/mcp",
        ]).has(path));
    if (!allowed) deny();
    return;
  }

  if (principal.kind === "feedback") {
    // No pipeline-triggering or spend-incurring route — everything this
    // principal can actually do (list_postings, mark_applied/
    // unmark_applied, record/list application events) is a Hermes tool call
    // over MCP, scoped further per-tool inside `mcp.controller.ts`.
    const allowed =
      (request.method === "GET" && path === "/health") ||
      (request.method === "POST" && path === "/mcp");
    if (!allowed) deny();
    return;
  }

  if (request.method !== "POST" || path !== "/runs/collect/external") deny();
  const bodySource =
    typeof request.body === "object" && request.body !== null
      ? (request.body as { source?: unknown }).source
      : undefined;
  if (bodySource !== principal.source) deny();
}

function deny(): never {
  throw new ForbiddenException("Credential does not grant this capability");
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

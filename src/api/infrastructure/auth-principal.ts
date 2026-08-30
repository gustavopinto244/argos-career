import { ForbiddenException } from "@nestjs/common";
import type { Request } from "express";

export type AuthPrincipal =
  | {
      readonly id: string;
      readonly kind: "admin";
    }
  | {
      readonly id: string;
      readonly kind: "automation";
    }
  | {
      readonly id: string;
      readonly kind: "source-ingest";
      readonly source: string;
    }
  | {
      readonly id: string;
      readonly kind: "feedback";
    };

export type AuthenticatedRequest = Request & {
  authPrincipal?: AuthPrincipal;
};

export function principalFromRequest(request: Request): AuthPrincipal {
  const principal = (request as AuthenticatedRequest).authPrincipal;
  if (!principal)
    throw new ForbiddenException("Authenticated principal missing");
  return principal;
}

export function requirePrincipalKind(
  principal: AuthPrincipal,
  allowed: readonly AuthPrincipal["kind"][],
): void {
  if (!allowed.includes(principal.kind)) {
    throw new ForbiddenException("Credential does not grant this capability");
  }
}

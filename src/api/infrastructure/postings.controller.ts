import {
  Controller,
  Delete,
  Body,
  Get,
  Param,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { ApplicationEventKind } from "../../feedback/domain/application-event";
import { principalFromRequest } from "./auth-principal";
import { FeedbackService } from "./feedback.service";
import { PostingsService } from "./postings.service";

export interface DiscardBody {
  readonly reason?: string;
}

export interface RecordApplicationEventBody {
  readonly kind: ApplicationEventKind;
  readonly note?: string;
  readonly occurredAt?: string;
}

/**
 * Human decisions, not a run — deliberately its own controller rather than
 * routes bolted onto `RunsController`, whose docblock scopes itself to
 * "read-only run inspection and stage re-execution." Discarding or marking a
 * posting applied is neither.
 *
 * No `GET /postings` here (ADR-072) — the listing query is exposed only as
 * the `list_postings` MCP tool, by explicit choice: Hermes is meant to be
 * the consumer of the corpus, not a second REST client for it. The
 * applied/unapplied toggle gets REST anyway, symmetric with `discard`,
 * because it is a state you (not just Hermes) plausibly want to flip
 * directly.
 *
 * `application-events` (ADR-075) gets the same REST symmetry as `applied`,
 * for the same reason: unlike a bulk corpus read, this is a single-posting
 * write the operator plausibly wants to make by hand — seeing a rejection
 * email themselves before Hermes notices. Only the admin credential reaches
 * this controller at all (`ApiKeyGuard`'s `feedback` principal is scoped to
 * `POST /mcp` only), so `recordedBy` here is always the operator's own
 * principal id, never Hermes's.
 */
@Controller("postings")
export class PostingsController {
  constructor(
    private readonly postings: PostingsService,
    private readonly feedback: FeedbackService,
  ) {}

  @Post(":fingerprint/discard")
  discard(
    @Param("fingerprint") fingerprint: string,
    @Body() body: DiscardBody = {},
  ) {
    return this.postings.discard(fingerprint, body.reason);
  }

  @Post(":fingerprint/applied")
  markApplied(@Param("fingerprint") fingerprint: string) {
    return this.postings.markApplied(fingerprint);
  }

  @Delete(":fingerprint/applied")
  unmarkApplied(@Param("fingerprint") fingerprint: string) {
    return this.postings.unmarkApplied(fingerprint);
  }

  @Post(":fingerprint/application-events")
  recordApplicationEvent(
    @Param("fingerprint") fingerprint: string,
    @Body() body: RecordApplicationEventBody,
    @Req() request: Request,
  ) {
    return this.feedback.record(
      { fingerprint, ...body },
      principalFromRequest(request).id,
    );
  }

  @Get(":fingerprint/application-events")
  listApplicationEvents(@Param("fingerprint") fingerprint: string) {
    return { fingerprint, events: this.feedback.list(fingerprint) };
  }
}

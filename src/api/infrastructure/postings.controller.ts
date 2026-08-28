import { Controller, Delete, Body, Param, Post } from "@nestjs/common";
import { PostingsService } from "./postings.service";

export interface DiscardBody {
  readonly reason?: string;
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
 */
@Controller("postings")
export class PostingsController {
  constructor(private readonly postings: PostingsService) {}

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
}

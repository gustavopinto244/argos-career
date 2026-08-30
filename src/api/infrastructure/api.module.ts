import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { ApiKeyGuard } from "./api-key.guard";
import {
  DEFAULT_THROTTLER_LIMIT,
  DEFAULT_THROTTLER_TTL_MS,
} from "./throttler-limits";
import { collectorProvider } from "./collector.provider";
import {
  criteriaProvider,
  profileProvider,
  taxonomyProvider,
} from "./config.provider";
import { databaseProvider } from "./database.provider";
import { FeedbackService } from "./feedback.service";
import { MarketController } from "./market.controller";
import { MarketService } from "./market.service";
import { McpController } from "./mcp.controller";
import { notifierProvider } from "./notifier.provider";
import { PostingsController } from "./postings.controller";
import { PostingsService } from "./postings.service";
import { RunsController } from "./runs.controller";
import { RunsService } from "./runs.service";
import { runLockProvider } from "../../scheduling/infrastructure/run-lock.provider";

/**
 * M9: the HTTP surface Hermes (a different machine, `CLAUDE.md` §10)
 * reaches over Tailscale — REST (`RunsController`) and MCP
 * (`McpController`), both thin over the one `RunsService`. `ApiKeyGuard`
 * registered as `APP_GUARD` — global, not per-controller — so a controller
 * added later is authenticated by default rather than by remembering to
 * add `@UseGuards`; that includes `/mcp`, MCP-over-HTTP is still HTTP.
 * `COLLECTOR` and `NOTIFIER` are factory providers, not `new
 * GupyCollector()`/`new TelegramNotifier()` inline, specifically so tests
 * can override them and the stage re-execution paths never make a real
 * network call in the suite.
 *
 * `runLockProvider` (ADR-024) is imported from `scheduling/infrastructure`
 * rather than duplicated here — it and `SchedulingModule`'s copy resolve
 * `RUN_LOCK` to the same exported singleton, so `RunsService`'s REST/MCP
 * stage triggers and `SchedulerService`'s cron ticks guard each other.
 *
 * `ThrottlerGuard` is a second global `APP_GUARD`, registered after
 * `ApiKeyGuard` (docs/audit AC-021) — NestJS runs guards in registration
 * order, so an unauthenticated request is still rejected before it can
 * consume any rate-limit budget. This is the generous, every-route
 * default (`throttler-limits.ts`); the tighter limit on `collect`/
 * `deliver`/`ingestExternal` — real OpenRouter spend, a real Telegram
 * send — is enforced in `RunsService` itself, not here: those three are
 * also reachable through `McpController`'s single `/mcp` route, invisible
 * to a per-HTTP-route guard, so the check lives in the one place both
 * controllers actually call. `RunLock` already stops two `deliver` runs
 * from overlapping; it says nothing about a leaked key calling either
 * protocol in a tight sequential loop. See `throttler-limits.ts` for the
 * actual numbers. ADR-047 partitions this budget by the authenticated
 * principal's non-secret identifier.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([
      { ttl: DEFAULT_THROTTLER_TTL_MS, limit: DEFAULT_THROTTLER_LIMIT },
    ]),
  ],
  controllers: [
    RunsController,
    MarketController,
    PostingsController,
    McpController,
  ],
  providers: [
    databaseProvider,
    collectorProvider,
    notifierProvider,
    criteriaProvider,
    profileProvider,
    taxonomyProvider,
    RunsService,
    MarketService,
    PostingsService,
    FeedbackService,
    runLockProvider,
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class ApiModule {}

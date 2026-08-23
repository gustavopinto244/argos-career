#!/usr/bin/env python3
"""
Collects Indeed postings via `python-jobspy` and pushes them to
argos-career's authenticated ingest endpoint.

ADR-027 (why this runs outside argos-career's own container — no Docker
socket mounted there, this is a fully separate process) and ADR-028 (why
this is allowed to break CLAUDE.md's polite-collector rule for this one
library and this one host — jobspy's Indeed scraper cannot be configured to
use an honest User-Agent, and apis.indeed.com's robots.txt disallows
everything regardless).

One run, one exit — this is the "ephemeral container" `docker run --rm`
runs on a schedule (see argos-indeed-collect.timer), not a long-lived
process. Never on the critical path: a failure here means Indeed's
postings are stale until the next scheduled run, nothing else in the
pipeline depends on it succeeding (principle 1, extended to a source that
lives outside the app entirely).

Required environment:
  ARGOS_API_URL   e.g. http://100.x.x.x:3000 (Atlas's Tailscale address)
  ARGOS_INGEST_API_KEY   an Indeed-only ingest credential

Optional environment (defaults below):
  SEARCH_TERMS (comma-separated; SEARCH_TERM singular still accepted, see
  below), LOCATION, COUNTRY_INDEED, RESULTS_WANTED, DRY_RUN, DRY_RUN_OUTPUT
"""

import json
import os
import sys
import time

import requests
from jobspy import scrape_jobs

# Measured, not guessed (docs/11-known-issues.md B13's follow-up,
# 2026-08-23) -- probed against real Indeed results, 50 rows each, before
# picking a default: "estagio" alone returned 6/50 titles matching this
# project's tracks (dev/security/automation); "estagio ti" returned 30/50,
# including exact-track hits ("Estagiário Full-Stack", "Estagiário DevOps",
# "Estágio em Desenvolvimento de Software (Back-end / Full Stack)",
# "TBG - ESTÁGIO - CIÊNCIA DA COMPUTAÇÃO") and real employers (Nubank).
# "estagio backend"/"estagio devops" were also tried and rejected as too
# narrow -- 0 and 3 rows respectively, the same near-zero-volume trap
# criteria.yaml's own Gupy query comments already document.
DEFAULT_SEARCH_TERM = "estagio ti"

# Multi-term default (ADR-060, 2026-08-23), measured with
# `npm run probe:indeed` against a real `--dry-run` scrape (50 rows/term,
# Rio de Janeiro) applying the *real* pre-filter/track/location rules, not a
# title-only guess. Kept alongside DEFAULT_SEARCH_TERM (still the fallback
# when only the singular SEARCH_TERM is set) so `resolve_search_terms`'s
# precedence is legible from the constants alone:
#
#   term                              rows  on-track, in-region
#   estagio ti                          50  9   (already the sole default)
#   estagio desenvolvimento             50  2
#   estagio suporte                     50  3
#   estagio seguranca da informacao     50  2
#   estagio infraestrutura              32  4
#
# Deliberately NOT added, both measured with real volume and titles that
# genuinely classify onto a track, but zero net after the full pre-filter
# (location/age), not zero because the term is off-topic:
#   estagio dados          "ESTAGIÁRIO DE TI | DESENVOLVIMENTO" classified
#                           dev+automation but failed location_not_allowed;
#                           track `data` (planned, not yet built) would
#                           likely change this term's yield -- re-probe once
#                           it lands.
#   estagio programador    real dev-track hits (BairesDev's Node.js/Java/
#                           React trainee postings) but all failed too_old
#                           -- these listings were already stale the day
#                           they were probed, a source characteristic, not
#                           a term problem.
DEFAULT_SEARCH_TERMS = [
    DEFAULT_SEARCH_TERM,
    "estagio desenvolvimento",
    "estagio suporte",
    "estagio seguranca da informacao",
    "estagio infraestrutura",
]
DEFAULT_LOCATION = "Rio de Janeiro, Brazil"
DEFAULT_COUNTRY_INDEED = "Brazil"
DEFAULT_RESULTS_WANTED = "50"

# Pause between terms within one run, same politeness discipline
# `criteria.yaml`'s `collection.queryIntervalMs` applies to Gupy/Sólides
# queries (CLAUDE.md §6) -- ADR-028's exception is scoped to the single
# `apis.indeed.com` request shape jobspy makes, not to hammering it back to
# back with no gap between terms.
TERM_INTERVAL_SECONDS = 3


def env(name: str, default: str | None = None, required: bool = False) -> str:
    value = os.environ.get(name, default)
    if required and not value:
        print(f"ERROR: {name} is required", file=sys.stderr)
        sys.exit(1)
    return value or ""


def resolve_search_terms() -> list[str]:
    """`SEARCH_TERMS` (plural, comma-separated) takes priority; falls back to
    the original singular `SEARCH_TERM` for compatibility with any
    deployment that already sets it (a real request for exactly one term
    should not silently become five); and only then to
    `DEFAULT_SEARCH_TERMS`. Whitespace-only entries are dropped rather than
    sent to jobspy as an empty-string search.

    The default is the new *list*, not the old single term -- the same call
    B13's follow-up made for `DEFAULT_SEARCH_TERM` itself ("the fix is the
    new default, not a config edit that could drift from a future fresh
    install"): Atlas's real `.env` carries no `SEARCH_TERM`/`SEARCH_TERMS`
    override today, so changing the default is what actually reaches
    production.
    """
    plural = os.environ.get("SEARCH_TERMS")
    if plural:
        terms = [t.strip() for t in plural.split(",") if t.strip()]
        if terms:
            return terms
    singular = os.environ.get("SEARCH_TERM")
    if singular and singular.strip():
        return [singular.strip()]
    return DEFAULT_SEARCH_TERMS


def scrape_term(
    term: str, location: str, country_indeed: str, results_wanted: int
) -> tuple[list[dict], bool]:
    """One term, one `scrape_jobs` call. Returns the rows (already converted
    through `to_json`/`json.loads`, matching `main`'s previous single-term
    conversion) and whether this term alone looks truncated at its own
    budget -- the same heuristic `main` used before multi-term existed,
    applied per term because jobspy gives no other signal
    (docs/audit PR-015).
    """
    print(f"jobspy: searching Indeed for '{term}' in '{location}' (up to {results_wanted})")
    jobs = scrape_jobs(
        site_name=["indeed"],
        search_term=term,
        location=location,
        country_indeed=country_indeed,
        results_wanted=results_wanted,
    )
    print(f"jobspy: {len(jobs)} rows returned for '{term}'")
    if len(jobs) == 0:
        return [], False
    # jobspy returns a pandas DataFrame; round-tripping through its own
    # to_json is what turns NaN into proper JSON null (a bare json.dumps on
    # the DataFrame's dict form does not) — the same conversion used to
    # capture the real fixture this source's schema/normalizer were fitted
    # against (ADR-027).
    rows = json.loads(jobs.to_json(orient="records", date_format="iso"))
    return rows, len(jobs) >= results_wanted


def main() -> None:
    search_terms = resolve_search_terms()
    location = env("LOCATION", DEFAULT_LOCATION)
    country_indeed = env("COUNTRY_INDEED", DEFAULT_COUNTRY_INDEED)
    try:
        results_wanted = int(env("RESULTS_WANTED", DEFAULT_RESULTS_WANTED))
    except ValueError as cause:
        raise SystemExit("ERROR: RESULTS_WANTED must be a positive integer") from cause
    if results_wanted <= 0:
        raise SystemExit("ERROR: RESULTS_WANTED must be a positive integer")

    # DRY_RUN skips the ingest POST entirely and, instead of talking to
    # argos-career, writes every scraped row to a mounted file — the input
    # `scripts/probe-indeed-terms.ts` reads to measure a candidate term
    # against the *real* pre-filter/track rules before it ever earns a spot
    # in SEARCH_TERMS (same "measure before adding" discipline ADR-018 and
    # B13's follow-up already used for Gupy/Indeed). Neither
    # ARGOS_API_URL nor ARGOS_INGEST_API_KEY is required in this mode.
    dry_run = env("DRY_RUN", "").strip().lower() in ("1", "true", "yes")

    api_url = ""
    api_key = ""
    if not dry_run:
        api_url = env("ARGOS_API_URL", required=True).rstrip("/")
        api_key = env("ARGOS_INGEST_API_KEY", required=True)

    all_rows: list[dict] = []
    seen_ids: set[str] = set()
    any_truncated = False
    per_term_rows: dict[str, list[dict]] = {}
    for index, term in enumerate(search_terms):
        if index > 0:
            time.sleep(TERM_INTERVAL_SECONDS)
        rows, truncated = scrape_term(term, location, country_indeed, results_wanted)
        any_truncated = any_truncated or truncated
        per_term_rows[term] = rows
        for row in rows:
            row_id = row.get("id")
            # Dedup across terms before ever building the postings list --
            # two terms can legitimately return the same real posting
            # (e.g. "estagio ti" and a future overlapping term), and a
            # duplicate sourceId in one ingest batch is wasted, not merely
            # redundant.
            if row_id and row_id not in seen_ids:
                seen_ids.add(row_id)
                all_rows.append(row)

    print(
        f"jobspy: {len(all_rows)} unique rows across {len(search_terms)} "
        f"term(s) ({', '.join(search_terms)})"
    )

    if dry_run:
        output_path = env("DRY_RUN_OUTPUT", "/app/output/dry-run.json")
        with open(output_path, "w", encoding="utf-8") as handle:
            json.dump(
                {"terms": search_terms, "perTerm": per_term_rows, "rows": all_rows},
                handle,
            )
        print(f"DRY_RUN: wrote {len(all_rows)} rows to {output_path}, not ingesting")
        return

    if len(all_rows) == 0:
        print("nothing to ingest, exiting")
        return

    # jobspy's own row id is the natural sourceId — stable per posting, the
    # same field the normalizer's schema requires.
    postings = [
        {"sourceId": row["id"], "payload": row} for row in all_rows if row.get("id")
    ]
    skipped = len(all_rows) - len(postings)
    if skipped:
        print(f"WARNING: {skipped} row(s) had no id, skipped")

    body = {"source": "indeed", "postings": postings, "truncated": any_truncated}
    response = requests.post(
        f"{api_url}/runs/collect/external",
        json=body,
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=120,
        allow_redirects=False,
    )
    print(f"ingest: HTTP {response.status_code}")
    print(response.text[:2000])
    response.raise_for_status()


if __name__ == "__main__":
    main()

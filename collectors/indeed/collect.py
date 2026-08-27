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
  below), LOCATION, COUNTRY_INDEED, RESULTS_WANTED, INCLUDE_REMOTE,
  DRY_RUN, DRY_RUN_OUTPUT
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

# A second pass over the same terms asking Indeed's own remote facet
# (ADR-070). Off by default: turning it on doubles the number of requests a
# run makes, and ADR-028's robots.txt exception is scoped narrowly enough
# that quietly doubling traffic is not something to enable for everyone.
#
# Why it is worth having at all: this collector has always been pinned to
# `LOCATION`, so a remote internship advertised nationally was unreachable
# no matter which term ran. Measured on the real corpus 2026-08-26, remote
# postings deliver at 21.4% against 1.4% for onsite -- roughly 15x -- and
# `country_indeed` stays "Brazil", so the pass stays national (ADR-068).
#
# `RESULTS_WANTED` is shared by both passes, so enabling this roughly
# doubles a run's ceiling rather than splitting the existing budget.
DEFAULT_INCLUDE_REMOTE = ""

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
    term: str,
    location: str,
    country_indeed: str,
    results_wanted: int,
    is_remote: bool = False,
) -> tuple[list[dict], bool]:
    """One term, one `scrape_jobs` call. Returns the rows (already converted
    through `to_json`/`json.loads`, matching `main`'s previous single-term
    conversion) and whether this term alone looks truncated at its own
    budget -- the same heuristic `main` used before multi-term existed,
    applied per term because jobspy gives no other signal
    (docs/audit PR-015).

    `is_remote` asks Indeed's own remote facet rather than filtering rows
    after the fact (ADR-070). It is the source's declaration, which is what
    `indeed-normalizer.ts` reads off `is_remote` to set `workMode: "remote"`
    -- the same "read what the source states, do not infer it from prose"
    rule ADR-063 established for InfoJobs.
    """
    # The remote pass searches the COUNTRY, not LOCATION. Passing the city
    # alongside `is_remote` keeps the query geo-scoped and defeats the
    # purpose: measured against the live source 2026-08-27, one term returned
    # 5 remote rows (3 surviving the pre-filter) scoped to
    # "Rio de Janeiro, Brazil" against 50 rows (19 surviving) scoped to
    # "Brazil" -- a nationally-advertised remote internship simply is not
    # returned by a city-scoped query. ADR-070 and this collector's README
    # both already described the pass this way; the code did not do it.
    #
    # The location pass keeps LOCATION untouched: widening it to the country
    # makes things worse, not better (18 surviving rows became 6), because
    # nationwide ONSITE postings crowd out the city's own and are then
    # rejected on location anyway.
    scope = country_indeed if is_remote else location
    print(f"jobspy: searching Indeed for '{term}' in '{scope}' (up to {results_wanted})")
    jobs = scrape_jobs(
        site_name=["indeed"],
        search_term=term,
        location=scope,
        country_indeed=country_indeed,
        results_wanted=results_wanted,
        is_remote=is_remote,
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
    include_remote = env("INCLUDE_REMOTE", DEFAULT_INCLUDE_REMOTE).strip().lower() in (
        "1",
        "true",
        "yes",
    )

    api_url = ""
    api_key = ""
    if not dry_run:
        api_url = env("ARGOS_API_URL", required=True).rstrip("/")
        api_key = env("ARGOS_INGEST_API_KEY", required=True)

    all_rows: list[dict] = []
    seen_ids: set[str] = set()
    any_truncated = False
    failed_terms: list[str] = []
    per_term_rows: dict[str, list[dict]] = {}

    # One pass per (term, scope). The location pass always runs; the remote
    # pass is opt-in (ADR-070). Built as an explicit list rather than a
    # nested loop so the politeness gap, the per-term failure guard and the
    # cross-term dedup below all keep applying uniformly -- a remote pass
    # must not get weaker guarantees than the location one.
    #
    # `label` distinguishes the two scopes in `per_term_rows`/`failed_terms`:
    # the same term run locally and remotely are different queries with
    # different yields, and collapsing them would make `probe:indeed`'s
    # per-term output unreadable and hide which scope failed.
    passes: list[tuple[str, bool, str]] = [
        (term, False, term) for term in search_terms
    ]
    if include_remote:
        passes += [(term, True, f"{term} [remote]") for term in search_terms]

    for index, (term, is_remote, label) in enumerate(passes):
        if index > 0:
            time.sleep(TERM_INTERVAL_SECONDS)
        # One term failing must not discard the terms that already
        # succeeded. Before this guard existed, a single `scrape_jobs`
        # raising (a network blip, Indeed rate-limiting one query, a parse
        # error inside jobspy) propagated straight out of `main` and
        # nothing was ingested at all -- proven with a stubbed jobspy:
        # two terms returned real rows, the third raised, and the ingest
        # POST never happened. That is the same "a broken source degrades,
        # it does not take everything down" rule (principle 1,
        # docs/02-architecture.md) the Node collectors follow, applied
        # within a single multi-term run.
        try:
            rows, truncated = scrape_term(
                term, location, country_indeed, results_wanted, is_remote
            )
        except Exception as cause:  # noqa: BLE001 - deliberately broad
            print(f"WARNING: term '{label}' failed, continuing: {cause}")
            failed_terms.append(label)
            per_term_rows[label] = []
            continue
        any_truncated = any_truncated or truncated
        per_term_rows[label] = rows
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
        f"jobspy: {len(all_rows)} unique rows across {len(passes)} "
        f"pass(es) over {len(search_terms)} term(s) "
        f"({', '.join(search_terms)})"
        + (" + a remote pass" if include_remote else "")
    )
    if failed_terms:
        # Loud, but not fatal: the run still ingests whatever succeeded.
        # Visible in `journalctl --user -u argos-indeed-collect`, which is
        # where B13 says to look when this source goes quiet.
        print(
            f"WARNING: {len(failed_terms)} of {len(passes)} pass(es) "
            f"failed and contributed nothing: {', '.join(failed_terms)}"
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

    if failed_terms and len(failed_terms) == len(passes):
        # Every term failed: this is a broken run, not a quiet one, and it
        # must exit non-zero so systemd records a failure. Exiting 0 here
        # would make a fully-broken collector indistinguishable from a
        # source with nothing new to offer -- the exact blind spot
        # docs/11-known-issues.md B13 documents (six silent days).
        raise SystemExit(
            f"ERROR: all {len(search_terms)} search term(s) failed; nothing collected"
        )

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

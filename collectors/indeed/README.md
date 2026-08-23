# Indeed collector

The host-side piece ADR-027 deferred and ADR-028 cleared to build: a
`jobspy`-based collector that runs **outside argos-career's own container**
(no Docker socket mounted there, deliberately — ADR-027) and pushes results
through the authenticated ingest endpoint (`POST /runs/collect/external`).

**Read ADR-027 and ADR-028 before touching this.** ADR-028 in particular:
this collector deliberately breaks CLAUDE.md §6's `robots.txt` and honest
User-Agent rules, for this one library and this one host only, with the
trade-off recorded there — not something to extend to another source by
copying this pattern.

## What runs where

- `collect.py` + `Dockerfile` build **one image**, `argos-indeed-collector:local`.
- A systemd **user** timer (`argos-indeed-collect.timer`) fires the
  **service** (`argos-indeed-collect.service`) twice daily.
- The service runs `docker run --rm argos-indeed-collector:local` — one
  ephemeral container per run, matching CLAUDE.md §6's "ephemeral Python
  container... prints JSON and exits."
- The container scrapes Indeed via `jobspy`, then `POST`s the results to
  `argos-career`'s own running container over its Tailscale address —
  container to container, both on Atlas, neither with any special
  privilege over the other.

## First-time setup on Atlas

```bash
cd ~/apps/argos-career/app/collectors/indeed

# 1. Build the image (once; rebuild after editing collect.py or Dockerfile)
docker build -t argos-indeed-collector:local .

# 2. Configure
cp .env.example .env
# edit .env: ARGOS_API_URL (Atlas's Tailscale address, argos-career's port),
# ARGOS_INGEST_API_KEY (matches ../../.env's INGEST_INDEED_API_KEY)

# 3. Try one run by hand before scheduling anything
set -a && source .env && set +a
docker run --rm \
  -e SEARCH_TERMS -e SEARCH_TERM -e LOCATION -e COUNTRY_INDEED -e RESULTS_WANTED \
  -e ARGOS_API_URL -e ARGOS_INGEST_API_KEY \
  argos-indeed-collector:local

# 4. Install the systemd user units
mkdir -p ~/.config/systemd/user
cp argos-indeed-collect.service argos-indeed-collect.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now argos-indeed-collect.timer

# 5. Confirm it's scheduled
systemctl --user list-timers argos-indeed-collect.timer

# User units need a lingering session to run without an active login —
# otherwise systemd stops user services when the SSH session ends.
loginctl enable-linger guga
```

## After editing `collect.py`

```bash
docker build -t argos-indeed-collector:local .
# next scheduled run (or a manual `systemctl --user start argos-indeed-collect.service`)
# picks up the new image automatically — no service/timer restart needed.
```

## Checking on it

```bash
systemctl --user status argos-indeed-collect.service
journalctl --user -u argos-indeed-collect.service -n 50
```

A run's outcome is also visible the normal way, once it has actually
POSTed: `GET /runs?kind=collect` on argos-career's own API — this
collector's runs are indistinguishable from Gupy/CIEE's in that listing,
by design (ADR-027, principle 2: one `collect` kind regardless of trigger).

## Changing the search

Edit `.env` (`SEARCH_TERMS`, `LOCATION`, `RESULTS_WANTED`) — no rebuild
needed, these are read at container start. Unlike Gupy/CIEE's
`config/criteria.yaml`-driven queries, this collector's search parameters
are **not** in `criteria.yaml` — a deliberate v1 simplification (ADR-027)
to avoid building cross-language config sharing between this Python script
and the Node app for a single source. Revisit if a second external
collector like this one ever exists.

`SEARCH_TERMS` (comma-separated, e.g. `"estagio ti,estagio dados"`) runs
every term in the same container invocation, deduplicates by jobspy's row
`id` across terms before ingesting, and sends one `POST` for the whole
batch (ADR-060). The original singular `SEARCH_TERM` is still read as a
one-term fallback for compatibility; the measured five-term default
(`collect.py`'s `DEFAULT_SEARCH_TERMS`) applies automatically when neither
is set.

**Measure a candidate term before adding it** — the same discipline
`npm run probe:terms` applies to Gupy queries (ADR-018):

```bash
# From this directory, scrape without ingesting:
mkdir -p dry-run-output
docker run --rm -e DRY_RUN=1 \
  -e "SEARCH_TERMS=estagio ti,estagio devops,estagio nova ideia" \
  -v "$PWD/dry-run-output:/app/output" \
  argos-indeed-collector:local

# From the repo root, apply the real pre-filter/track/location rules:
npm run probe:indeed -- collectors/indeed/dry-run-output/dry-run.json
```

A term only earns a place in `DEFAULT_SEARCH_TERMS` once it clears the same
bar every `criteria.yaml` query comment already documents: real volume that
survives the pre-filter _and_ lands in the target metro area or remote, not
a raw hit count.

## Discovery coverage gap (docs/audit AC-023) — mostly closed by ADR-060

Originally: each scheduled run issued exactly **one** jobspy search, no
rotation, so `trainee`/`estagiário`/`estagiária` variants, a `remote`-only
query, and the other RJ-metro cities `location.cities` accepts were
structurally unreachable through Indeed. `SEARCH_TERMS` (above) closes the
"one query per run" half — a run now issues several searches and merges
them before one ingest `POST`. **Still not covered**, deliberately: a
`remote`-only query and per-city queries the way Gupy/Sólides run them —
`LOCATION` stays a single value for the whole run, and jobspy's
`is_remote` filter was not probed here. Revisit if a probed `LOCATION`
rotation (or a remote-specific term) measures real on-track yield the way
the five terms in `DEFAULT_SEARCH_TERMS` did.

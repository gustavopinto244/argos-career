import { keywordMatchesText } from "./title-match";
import { ProfileTrack } from "../../profile/domain/profile";
import { Track } from "../../scoring/domain/types";
import { Criteria } from "./criteria";

/**
 * Deterministic, keyword-based track classification (docs/04-scoring-model.md
 * §trackAlignment), run in the pre-filter before any LLM call. Feeds
 * `computeTrackAlignment` directly — an empty result here is exactly the
 * "unknown" case that function already falls back to.
 *
 * Matches against the posting's **title only** — deliberately, and not for
 * the reason this comment used to give.
 *
 * It claimed `Posting` "does not retain a full description". That stopped
 * being true: `Posting.description` exists and Stage A reads it. It also
 * said to "revisit if `unknown` classification turns out to be common",
 * and it is — 2,379 of 2,768 active postings (86%) classify `unknown` by
 * title.
 *
 * So the premise was re-tested against the real corpus (2026-08-22) rather
 * than left to rot: classifying on `title + description` would newly
 * classify **438 postings**, and sampling them shows they are almost
 * entirely off-track — "Operador(a) de Caixa" and "Operador de
 * Teleatendimento" as `dev`, "Assistente de vendas" as `security`,
 * "GERENTE DE MANUTENÇÃO E REFRIGERAÇÃO" as all three. Descriptions carry
 * enough HR boilerplate ("sistemas", "segurança", "desenvolvimento", "TI")
 * to trip every keyword list, and with `rejectUnknownTrack` on (ADR-051)
 * each false positive is a real Stage A/B call spent on a posting no
 * profile could score.
 *
 * Title-only stands on that measurement, not on the stale claim. The known
 * cost is the opposite error — a genuinely on-track posting whose title
 * names no technology ("Programa de Estágio Smarthis | 2026") scores
 * `trackAlignment` 0.4 as `unknown` (docs/11-known-issues.md B9). Closing
 * that needs a higher-precision signal than raw description text; the
 * option worth exploring is deriving the score's track from Stage A's
 * *extracted requirements*, which are already boilerplate-free — a
 * scoring-model change needing its own ADR and calibration, deliberately
 * not attempted here.
 *
 * Whole-word matching via `keywordMatchesText`, **not** substring
 * (ADR-011 Amendment 2). Substring matching was the original design and was
 * measurably wrong here for the same reason it was wrong in the title
 * blocklist: `soc` matched inside "social"/"societário"/"sociais" and `api`
 * inside "fisioterapia"/"capital", classifying a physiotherapy internship
 * as `dev`. `keywordMatchesText` still matches `back-end` against
 * "Backend Developer" — hyphen-insensitivity was the real reason substring
 * matching was chosen, and it is preserved by its collapsed-word pass.
 */
export function classifyTrack(
  title: string,
  tracks: Criteria["tracks"],
  exclusions: Criteria["trackExclusions"] = {
    dev: [],
    security: [],
    automation: [],
    data: [],
  },
): Track[] {
  const matches = (keyword: string) => keywordMatchesText(title, keyword);

  const profileTracks = Object.keys(tracks) as ProfileTrack[];
  return profileTracks.filter((track) => {
    // An exclusion outranks a keyword: "ESTAGIÁRIO DE DESENVOLVIMENTO DE
    // EMBALAGENS" contains "desenvolvimento" and is not a software posting
    // (ADR-015). Checked first so the cheap negative wins before the
    // positive is even considered.
    if ((exclusions[track] ?? []).some(matches)) return false;
    return tracks[track].some(matches);
  });
}

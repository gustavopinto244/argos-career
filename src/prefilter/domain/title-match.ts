const COMBINING_MARKS = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC = /[^\p{L}\p{N}]+/gu;

/**
 * Punctuation that *joins* one term rather than separating two, so collapsing
 * it is what produces the real word: `Node.js` \u2192 `nodejs`, `back-end` \u2192
 * `backend`, `C++` \u2192 `c`. Everything else non-alphanumeric separates.
 *
 * This distinction exists because deleting *all* punctuation is wrong in one
 * direction and keeping it all is wrong in the other, and the two failures
 * are real, not hypothetical:
 *
 * - Delete everything (the original behaviour): `TI/Seguran\u00e7a` becomes the
 *   single token `tiseguranca`, so the keyword `seguran\u00e7a` does not match and
 *   a genuine security posting loses its track \u2014 with `rejectUnknownTrack`
 *   on, it is discarded as `track_unknown` before any LLM sees it.
 * - Split on everything: `Node.js` becomes `node js`, so the alias `js`
 *   matches it and a Node.js requirement is counted as a separate JavaScript
 *   mention in M10's aggregates \u2014 the exact regression the collapsed-only
 *   path was introduced to stop.
 *
 * `/` is a separator on purpose: in these titles it reads as "or" \u2014
 * `TI/Seguran\u00e7a`, `Desenvolvimento/Automa\u00e7\u00e3o`. The multi-token keyword
 * `ci/cd` is unaffected, since it normalizes to the phrase `ci cd` and
 * matches through the spaced pass either way.
 */
const JOINING_PUNCTUATION = /['`\u00b4.\-_+#]+/g;

/**
 * Title-matching normalization, deliberately **not** `normalize` from
 * `posting/domain/fingerprint.ts`: that one strips punctuation without
 * inserting anything, so "Estagiário(a)" collapses to "estagiarioa" and
 * word boundaries stop existing. Here punctuation becomes a **space**,
 * which is what makes whole-word matching possible at all.
 *
 * The two cannot be merged. The fingerprint normalizer is frozen — changing
 * it rewrites every fingerprint already stored and silently re-notifies the
 * entire corpus (ADR-007) — and it wants the opposite behaviour anyway.
 */
export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(NON_ALPHANUMERIC, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The middle ground between `normalizeTitle` (all punctuation separates) and
 * `normalize` (all punctuation vanishes): joining punctuation is deleted so
 * the term collapses into one word, and everything else becomes a space so
 * word boundaries survive. See `JOINING_PUNCTUATION` for why neither extreme
 * is correct on its own.
 */
export function normalizeCollapsingJoiners(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(JOINING_PUNCTUATION, "")
    .replace(NON_ALPHANUMERIC, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whole-word (or whole-phrase) match against a posting title.
 *
 * Substring matching was the original implementation and was measurably
 * wrong: `titleBlocklist` carries the seniority markers "III" and "IV", and
 * "iv" is a substring of ordinary Portuguese words that appear constantly in
 * real internship titles — "nível", "universitário", "afirmativa",
 * "administrativo", "civil", "executivo". Measured against the real 380-
 * posting corpus it wrongly blocked 24 postings, 9 of them genuine
 * internships including "Estágio Nível Superior - TI - Segurança da
 * Informação". The same flaw ran in the other direction on `titleRequired`,
 * where "intern" matched "interna", "internos" and "International" and let
 * non-internships through into LLM budget.
 *
 * Padding both sides with a space turns `includes` into a word-boundary test
 * while still supporting multi-word terms ("tech lead") — no regex, no
 * tokenizer. Re-measured on the same corpus: 24 false blocks removed, **zero**
 * true blocks lost ("Analista III" still blocks, since there "III" is its own
 * word), and the three false accepts gone.
 *
 * The cost, accepted: a term only matches as written, so plural and inflected
 * forms must be listed explicitly in `config/criteria.yaml` ("estágio" no
 * longer matches "Estágios"). That is the right place for it — criteria are
 * data, and a plural added there is visible in `git log`, where a stemmer
 * buried in code would not be.
 */
export function titleMatchesAny(
  title: string,
  terms: readonly string[],
): boolean {
  const haystack = ` ${normalizeTitle(title)} `;
  return terms.some((term) => {
    const needle = normalizeTitle(term);
    return needle !== "" && haystack.includes(` ${needle} `);
  });
}

/**
 * Whole-word match for a *keyword list* term against arbitrary text —
 * `tracks` and `trackExclusions` against a posting title, and M10's skill
 * taxonomy against a requirement's text. (Named `keywordMatchesTitle`
 * when ADR-011 Amendment 2 introduced it; renamed once the taxonomy
 * became a second caller and "Title" stopped being true.)
 *
 * Entries carry punctuation variants (`back-end`,
 * `node.js`, `ci/cd`, `full-stack`) that plain whole-word matching would
 * miss, and short tokens (`api`, `soc`, `ciber`) that plain substring
 * matching gets catastrophically wrong.
 *
 * ADR-011 Amendment 1 asserted these lists held no colliding short token.
 * Measured against the real corpus, that was simply false: `soc` (Security
 * Operations Center) matched inside "**soc**ial", "**soc**ietário" and
 * "redes **soc**iais", and `api` matched inside "fisioter**api**a" and
 * "c**api**tal" — classifying a physiotherapy internship as `dev` and a
 * social-media one as `security`, which then fed `trackAlignment` at 1.0
 * instead of 0.4. Amendment 2 corrects it.
 *
 * Two passes, either of which is a match:
 *
 * 1. **Word/phrase**, over punctuation-as-space text — `back-end` becomes
 *    the phrase "back end" and matches "Back-End Developer".
 * 2. **Collapsed word**, over `normalizeCollapsingJoiners` text — `back-end`
 *    collapses to "backend" and matches "Backend Developer", the
 *    hyphen-insensitivity the old substring matching existed to provide.
 *
 * Neither pass can match `api` inside `fisioterapia`, because in both the
 * candidate must occupy a whole word.
 */
export function keywordMatchesText(text: string, keyword: string): boolean {
  const spacedKeyword = normalizeTitle(keyword);
  if (spacedKeyword === "") return false;

  // A keyword that is a single token after normalization uses the collapsed
  // pass ONLY. The spaced pass splits punctuated words — "Node.js" becomes
  // the two tokens "node" and "js" — and a bare single-token keyword would
  // then match a fragment of an unrelated term: the alias `JS` matched
  // inside "Node.js", counting a Node.js requirement as a separate
  // JavaScript mention in the market aggregates.
  //
  // The collapsed pass deletes only *joining* punctuation, so "Node.js" is
  // still the single token "nodejs" (where `js` correctly does not match)
  // while "TI/Segurança" is two tokens (where `segurança` correctly does).
  // Deleting `/` here too — the original behaviour — silently cost real
  // security postings their track.
  const collapsed = ` ${normalizeCollapsingJoiners(text)} `;
  const collapsedKeyword = normalizeCollapsingJoiners(keyword);
  if (!spacedKeyword.includes(" ")) {
    return (
      collapsedKeyword !== "" && collapsed.includes(` ${collapsedKeyword} `)
    );
  }

  // Multi-token keywords need both passes: the spaced one matches
  // "back-end" against "Back-End Developer", the collapsed one against
  // "Backend Developer".
  const spaced = ` ${normalizeTitle(text)} `;
  if (spaced.includes(` ${spacedKeyword} `)) return true;
  return collapsedKeyword !== "" && collapsed.includes(` ${collapsedKeyword} `);
}

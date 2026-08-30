/**
 * Deterministic HTML-to-text conversion for a posting's description
 * (docs/audit AC-017). Sólides in particular returns real rich-text markup
 * (`h1`/`h2`/`p`/`strong`/`ul`/`li`) — sending it straight into a prompt
 * spends tokens on tag syntax the model gets no signal from, and, unbounded,
 * makes the input-size budget (`truncateDescription`) unpredictable: the
 * same visible text costs a different number of characters depending on how
 * verbose the source's markup happens to be.
 *
 * Not a general-purpose HTML parser — a small, deterministic pass tuned to
 * what job-posting rich text actually contains (headings, paragraphs, lists,
 * line breaks, bold/italic inline tags, entities). No third-party dependency:
 * this project already prefers a small hand-rolled pass over a library for
 * this kind of bounded transform (ADR-035's rejection of a retry library is
 * the same reasoning).
 */

const SCRIPT_OR_STYLE_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const LIST_ITEM_OPEN = /<li\b[^>]*>/gi;
const LINE_BREAK = /<br\s*\/?>/gi;
/** Closing tags for elements that read as their own line/paragraph in plain
 * text — headings, paragraphs, list containers, table rows, blockquotes. */
const BLOCK_CLOSE = /<\/(p|div|h[1-6]|li|ul|ol|tr|table|blockquote)>/gi;
/**
 * Requires a letter or `/` immediately after `<` — the same condition
 * `HAS_MARKUP` uses to decide whether input contains markup at all. Without
 * this, plain text such as a salary comparison ("< R$ 2000 >") reads as an
 * opening+closing tag pair and both the delimiters and everything between
 * them are silently deleted, which is exactly the kind of invisible data
 * loss AC-017 exists to prevent.
 */
const ANY_TAG = /<\/?[a-zA-Z][^>]*>/g;
const HAS_MARKUP = /<[a-zA-Z/][^>]*>/;

/**
 * A `Map`, not an object literal, because the lookup key comes from
 * untrusted posting HTML. `ENTITY_PATTERN` matches `[a-zA-Z]+`, which
 * includes every `Object.prototype` member name, and a plain object resolves
 * those through the prototype chain: `NAMED_ENTITIES["constructor"]` returned
 * the `Object` function, and `?? match` treated it as a hit. A posting
 * containing `&constructor;` had `function Object() { [native code] }`
 * spliced into its description — and from there into the Stage A prompt, the
 * `contentHash` that keys the extraction cache, and the `inputTruncated`
 * accounting. Same for `&toString;`, `&valueOf;`, `&hasOwnProperty;`.
 */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["nbsp", " "],
]);

const ENTITY_PATTERN = /&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g;

function decodeEntities(input: string): string {
  return input.replace(ENTITY_PATTERN, (match, code: string) => {
    if (code[0] === "#") {
      const isHex = code[1] === "x" || code[1] === "X";
      const codePoint = parseInt(
        isHex ? code.slice(2) : code.slice(1),
        isHex ? 16 : 10,
      );
      // `String.fromCodePoint` throws for values above U+10FFFF. Numeric
      // entities come from untrusted posting HTML, so one malformed entity
      // must degrade to the Unicode replacement character rather than abort
      // the whole score-and-deliver run. Surrogate code points are not valid
      // Unicode scalar values either, even though JS accepts them here.
      // U+0000 is excluded on top of the scalar-value rules: a null byte is
      // the field separator `hashExtractionInput` relies on, whose own
      // comment states it is "never legitimately present in posting text".
      // Decoding `&#0;` made that false, so a posting could carry a byte the
      // extraction-cache key treats as structural.
      const isUnicodeScalar =
        Number.isFinite(codePoint) &&
        codePoint > 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff);
      return isUnicodeScalar ? String.fromCodePoint(codePoint) : "\uFFFD";
    }
    return NAMED_ENTITIES.get(code) ?? match;
  });
}

export interface HtmlToTextResult {
  readonly text: string;
  /** True when the input actually contained markup this function stripped —
   * lets a caller record the reduction (AC-017's "registrando redução")
   * instead of it happening invisibly. False for input that was already
   * plain text, even if whitespace got collapsed. */
  readonly hadMarkup: boolean;
}

export function htmlToText(input: string): HtmlToTextResult {
  const hadMarkup = HAS_MARKUP.test(input);

  const withoutScripts = input.replace(SCRIPT_OR_STYLE_BLOCK, " ");
  const withLineBreaks = withoutScripts
    .replace(LIST_ITEM_OPEN, "\n- ")
    .replace(LINE_BREAK, "\n")
    .replace(BLOCK_CLOSE, "\n\n");
  const withoutTags = withLineBreaks.replace(ANY_TAG, "");
  const decoded = decodeEntities(withoutTags);

  const collapsed = decoded
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: collapsed, hadMarkup };
}

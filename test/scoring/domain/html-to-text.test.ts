import { describe, expect, it } from "vitest";
import { htmlToText } from "../../../src/scoring/domain/html-to-text";

describe("htmlToText (docs/audit AC-017)", () => {
  it("leaves plain text untouched, aside from whitespace collapsing", () => {
    const { text, hadMarkup } = htmlToText(
      "Buscamos estagiário com conhecimento em Node.js.",
    );
    expect(text).toBe("Buscamos estagiário com conhecimento em Node.js.");
    expect(hadMarkup).toBe(false);
  });

  it("strips block tags and turns them into paragraph breaks", () => {
    const { text, hadMarkup } = htmlToText(
      "<p>Primeiro parágrafo.</p><p>Segundo parágrafo.</p>",
    );
    expect(text).toBe("Primeiro parágrafo.\n\nSegundo parágrafo.");
    expect(hadMarkup).toBe(true);
  });

  it("turns <br> into a newline and <li> into a dashed line", () => {
    const { text } = htmlToText(
      "<p>Requisitos:</p><ul><li>Node.js</li><li>SQL</li></ul>Linha um<br>Linha dois",
    );
    expect(text).toContain("- Node.js");
    expect(text).toContain("- SQL");
    expect(text).toContain("Linha um\nLinha dois");
  });

  it("removes inline formatting tags without losing their text content", () => {
    const { text } = htmlToText(
      "Vaga para <strong>desenvolvedor</strong> com <em>experiência</em>.",
    );
    expect(text).toBe("Vaga para desenvolvedor com experiência.");
  });

  it("strips script and style blocks entirely, including their content", () => {
    const { text } = htmlToText(
      "<p>Visível</p><script>alert('x')</script><style>.a{color:red}</style><p>Também visível</p>",
    );
    expect(text).not.toContain("alert");
    expect(text).not.toContain("color:red");
    expect(text).toContain("Visível");
    expect(text).toContain("Também visível");
  });

  it("decodes named HTML entities", () => {
    const { text } = htmlToText("Node.js &amp; Express &lt;framework&gt;");
    expect(text).toBe("Node.js & Express <framework>");
  });

  it("decodes numeric and hex HTML entities", () => {
    const { text } = htmlToText("Caf&#233; com leite &#x2014; grátis");
    expect(text).toBe("Café com leite — grátis");
  });

  it("replaces invalid Unicode numeric entities instead of throwing", () => {
    expect(htmlToText("bad: &#x110000; and &#xD800;").text).toBe(
      "bad: � and �",
    );
  });

  it("leaves an entity-like sequence that isn't a real entity alone", () => {
    const { text } = htmlToText("R&D team");
    expect(text).toBe("R&D team");
  });

  it("collapses runs of blank lines to at most one", () => {
    const { text } = htmlToText("<p>A</p><br><br><br><p>B</p>");
    expect(text).toBe("A\n\nB");
  });

  it("strips any remaining unrecognized tag", () => {
    const { text, hadMarkup } = htmlToText(
      '<div class="x"><span data-y="1">conteúdo</span></div>',
    );
    expect(text).toBe("conteúdo");
    expect(hadMarkup).toBe(true);
  });

  it("preserves text with a bare '<'/'>' comparison instead of reading it as a tag", () => {
    // A real risk with a naive "strip anything between < and >" pass: a
    // salary figure like "< R$ 2000" reads as an opening tag, ">" pairs
    // with it as a closing one, and everything in between -- the actual
    // number -- silently disappears before the model ever sees it.
    const { text, hadMarkup } = htmlToText("Remuneração < R$ 2000 > acordo");
    expect(text).toBe("Remuneração < R$ 2000 > acordo");
    expect(hadMarkup).toBe(false);
  });

  it("returns an empty string for empty input", () => {
    expect(htmlToText("")).toEqual({ text: "", hadMarkup: false });
  });
});

describe("entity decoding does not resolve through Object.prototype", () => {
  // `ENTITY_PATTERN` matches [a-zA-Z]+, which includes every prototype member
  // name, and the lookup used to be a plain object literal — so a posting
  // containing `&constructor;` had `function Object() { [native code] }`
  // spliced into its description, and from there into the Stage A prompt and
  // the contentHash that keys the extraction cache.
  it.each([
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])(
    "leaves &%s; untouched instead of injecting a prototype member",
    (name) => {
      const input = `Vaga &${name}; devs`;
      expect(htmlToText(input).text).toBe(input);
    },
  );

  it("still decodes the entities it actually knows", () => {
    expect(htmlToText("A &amp; B").text).toBe("A & B");
    expect(htmlToText("&lt;tag&gt;").text).toBe("<tag>");
    expect(htmlToText("a&nbsp;b").text).toBe("a b");
    expect(htmlToText("Caf&#233;").text).toBe("Café");
  });

  it("refuses to decode &#0; into a real null byte", () => {
    // `hashExtractionInput` uses \0 as its field separator and documents it
    // as "never legitimately present in posting text" — decoding this made
    // that invariant false.
    const decoded = htmlToText("Nulo &#0; aqui").text;
    expect(decoded).not.toContain("\0");
    expect(decoded).toBe("Nulo � aqui");
  });
});

import { describe, expect, it } from "vitest";
import {
  normalizerFor,
  registeredSources,
} from "../../../src/posting/infrastructure/normalizer-registry";

const NOW = new Date("2026-08-16T03:00:00Z");

describe("normalizerFor", () => {
  it("dispatches each known source to its own normalizer", () => {
    expect(normalizerFor("gupy")).toBeTypeOf("function");
    expect(normalizerFor("ciee")).toBeTypeOf("function");
    expect(normalizerFor("gupy")).not.toBe(normalizerFor("ciee"));
  });

  it("returns null for an unregistered source instead of a silent no-op", () => {
    // The distinction this encodes: an unregistered source is a wiring bug,
    // not a degraded source. A no-op normalizer would drop every posting and
    // look exactly like a source that returned nothing.
    expect(normalizerFor("jooble")).toBeNull();
    expect(normalizerFor("")).toBeNull();
  });

  it("does not treat inherited Object properties as registered sources", () => {
    expect(normalizerFor("toString")).toBeNull();
    expect(normalizerFor("constructor")).toBeNull();
  });

  it("routes a payload to the normalizer that understands it", () => {
    const gupy = normalizerFor("gupy")!;
    const posting = gupy(
      {
        source: "gupy",
        sourceId: "1",
        payload: { id: 1, name: "Estágio Backend", careerPageName: "Acme" },
      },
      NOW,
    );
    expect(posting?.company).toBe("Acme");
  });

  it("lists what this build can normalize", () => {
    expect(registeredSources()).toEqual([
      "catho",
      "ciee",
      "gupy",
      "indeed",
      "infojobs",
      "linkedin",
      "nerdin",
      "solides",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { cleanClips, expandTokens, extractClipAction, tokenize } from "../src/tokenizer.js";

describe("tokenize", () => {
  it("lowercases, splits on whitespace, and stems", () => {
    // "animal" stems to "anim" via Porter stemmer
    expect(tokenize("Wolf Animal")).toEqual(["wolf", "anim"]);
  });

  it("splits camelCase into separate tokens", () => {
    const tokens = tokenize("WolfRun");
    expect(tokens).toContain("wolf");
    expect(tokens).toContain("run");
  });

  it("splits ACRONym → ACRO + nym", () => {
    const tokens = tokenize("GLBFile");
    expect(tokens).toContain("glb");
    expect(tokens).toContain("file");
  });

  it("treats underscores as separators", () => {
    expect(tokenize("Sword_Slash")).toEqual(expect.arrayContaining(["sword", "slash"]));
  });

  it("treats pipes as separators", () => {
    expect(tokenize("hit|react")).toEqual(expect.arrayContaining(["hit", "react"]));
  });

  it("treats dashes as separators", () => {
    // "poly" stems to "poli" via Porter stemmer
    expect(tokenize("low-poly")).toEqual(expect.arrayContaining(["low", "poli"]));
  });

  it("filters stopwords", () => {
    const tokens = tokenize("the wolf and the tree");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("and");
    expect(tokens).toContain("wolf");
    expect(tokens).toContain("tree");
  });

  it("filters single-character tokens", () => {
    expect(tokenize("a b c wolf")).toEqual(["wolf"]);
  });

  it("returns empty array for all-stopword input", () => {
    expect(tokenize("the and or")).toEqual([]);
  });
});

describe("expandTokens", () => {
  it("passes through tokens with no synonyms unchanged", () => {
    expect(expandTokens(["wolf"])).toEqual(["wolf"]);
  });

  it("expands run → gallop, running, sprint", () => {
    const expanded = expandTokens(["run"]);
    expect(expanded).toContain("run");
    expect(expanded).toContain("gallop");
    expect(expanded).toContain("running");
    expect(expanded).toContain("sprint");
  });

  it("expands attack → bite, punch, slash", () => {
    const expanded = expandTokens(["attack"]);
    expect(expanded).toContain("bite");
    expect(expanded).toContain("punch");
    expect(expanded).toContain("slash");
  });

  it("expands die → death, dead (not 'die' itself — synonym replaces query intent)", () => {
    const expanded = expandTokens(["die"]);
    expect(expanded).toContain("death");
    expect(expanded).toContain("dead");
  });

  it("is one-directional: gallop does NOT expand to quad animals", () => {
    const expanded = expandTokens(["gallop"]);
    expect(expanded).not.toContain("cow");
    expect(expanded).not.toContain("wolf");
    expect(expanded).not.toContain("horse");
  });

  it("deduplicates expanded tokens", () => {
    const expanded = expandTokens(["run", "run"]);
    expect(expanded.filter((t) => t === "run").length).toBe(1);
  });

  it("combines multiple synonym expansions without duplicates", () => {
    // both "run" and "quad" expand to "gallop"
    const expanded = expandTokens(["run", "quad"]);
    expect(expanded.filter((t) => t === "gallop").length).toBe(1);
  });
});

describe("extractClipAction", () => {
  it("extracts the action part from a Blender armature export string", () => {
    expect(extractClipAction("TentacleArmature|TentacleArmature|Tentacle_Attack2")).toBe(
      "Tentacle_Attack2",
    );
  });

  it("returns the string as-is when no pipes present", () => {
    expect(extractClipAction("Run")).toBe("Run");
    expect(extractClipAction("Idle")).toBe("Idle");
  });

  it("skips armature segments to find the real action name", () => {
    expect(extractClipAction("WolfArmature|Wolf_Run")).toBe("Wolf_Run");
  });
});

describe("cleanClips", () => {
  it("strips armature prefixes from each clip", () => {
    const result = cleanClips(["WolfArmature|Wolf_Run", "WolfArmature|Wolf_Idle"]);
    expect(result).toContain("Wolf_Run");
    expect(result).toContain("Wolf_Idle");
  });

  it("deduplicates identical raw clips", () => {
    const result = cleanClips(["WolfArmature|Wolf_Run", "WolfArmature|Wolf_Run"]);
    expect(result.filter((c) => c === "Wolf_Run").length).toBe(1);
  });

  it("returns empty array for empty input", () => {
    expect(cleanClips([])).toEqual([]);
  });
});

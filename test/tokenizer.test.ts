import { describe, it, expect } from "vitest";
import { tokenize, extractClipAction, cleanClips, expandTokens } from "../src/tokenizer.js";

describe("tokenize", () => {
  it("splits CamelCase into separate tokens", () => {
    expect(tokenize("HitReact")).toEqual(["hit", "react"]);
  });

  it("splits underscore-separated clip names", () => {
    expect(tokenize("Jump_toIdle")).toEqual(["jump", "idle"]);
  });

  it("splits pipe-separated GLB names", () => {
    expect(tokenize("CharacterArmature|Walk")).toEqual(["character", "armature", "walk"]);
  });

  it("handles compound clip names end-to-end", () => {
    expect(tokenize("Sword_Slash")).toEqual(["sword", "slash"]);
    expect(tokenize("Swimming_Normal")).toEqual(["swimming", "normal"]);
    expect(tokenize("Idle_HitReact_Left")).toEqual(["idle", "hit", "react", "left"]);
    expect(tokenize("Gallop_Jump")).toEqual(["gallop", "jump"]);
  });

  it("removes stopwords", () => {
    expect(tokenize("the animated to a")).toEqual(["animated"]);
  });

  it("filters tokens shorter than 2 characters", () => {
    expect(tokenize("a b c walk")).toEqual(["walk"]);
  });
});

describe("extractClipAction", () => {
  it("extracts action from single ArmatureName|Action pattern", () => {
    expect(extractClipAction("CharacterArmature|Walk")).toBe("Walk");
  });

  it("extracts action from repeated armature prefix pattern", () => {
    expect(extractClipAction("TentacleArmature|TentacleArmature|Tentacle_Attack2")).toBe("Tentacle_Attack2");
  });

  it("returns the string as-is when no armature prefix exists", () => {
    expect(extractClipAction("Idle")).toBe("Idle");
    expect(extractClipAction("Walk")).toBe("Walk");
  });
});

describe("cleanClips", () => {
  it("deduplicates when raw and prefixed versions both appear", () => {
    const raw = ["Walk", "AnimalArmature|Walk", "Idle", "AnimalArmature|Idle"];
    expect(cleanClips(raw)).toEqual(["Walk", "Idle"]);
  });

  it("preserves order of first occurrence", () => {
    const raw = ["Attack", "CharacterArmature|Walk", "Walk"];
    expect(cleanClips(raw)).toEqual(["Attack", "Walk"]);
  });
});

describe("expandTokens", () => {
  it("expands 'run' to include gallop", () => {
    expect(expandTokens(["run"])).toContain("gallop");
  });

  it("expands 'attack' to include slash, punch, kick", () => {
    const expanded = expandTokens(["attack"]);
    expect(expanded).toContain("slash");
    expect(expanded).toContain("punch");
    expect(expanded).toContain("kick");
  });

  it("does NOT expand 'wolf' to 'cow' (one-directional)", () => {
    expect(expandTokens(["wolf"])).not.toContain("cow");
    expect(expandTokens(["wolf"])).not.toContain("horse");
  });

  it("expands 'quad' to include wolf, cow, horse", () => {
    const expanded = expandTokens(["quad"]);
    expect(expanded).toContain("wolf");
    expect(expanded).toContain("cow");
    expect(expanded).toContain("horse");
  });

  it("passes through unknown tokens unchanged", () => {
    expect(expandTokens(["elephant"])).toEqual(["elephant"]);
  });
});

// Pure tokenization functions — no side effects, no I/O.

import { PorterStemmer } from "natural";

export function stem(token: string): string {
  return PorterStemmer.stem(token);
}

const STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "of",
  "to",
  "a",
  "an",
  "in",
  "on",
  "at",
  "is",
  "it",
  "by",
]);

/** Split text into lowercase tokens without stemming. */
export function tokenizeRaw(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2") // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // ACRONym → ACRO nym
    .replace(/[_|.,-]/g, " ") // separators → space
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Split text into lowercase stemmed search tokens, handling CamelCase and separators. */
export function tokenize(text: string): string[] {
  return tokenizeRaw(text).map(stem);
}

/**
 * Extract the clean action name from a Blender-exported clip string.
 * "TentacleArmature|TentacleArmature|Tentacle_Attack2" → "Tentacle_Attack2"
 */
export function extractClipAction(rawClip: string): string {
  const parts = rawClip.split("|");
  const action = parts.find((p) => !/armature/i.test(p) && p.length > 2);
  return action ?? parts[parts.length - 1] ?? rawClip;
}

/** Deduplicate clip names and strip armature prefixes. */
export function cleanClips(rawClips: readonly string[]): string[] {
  return [...new Set(rawClips.map(extractClipAction))];
}

// One-directional synonyms: query keyword → extra terms to match against asset data.
// Direction matters — searching "wolf" must NOT expand to "cow".
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  run: ["run", "gallop", "running", "sprint"],
  walk: ["walk", "walking"],
  jump: ["jump", "leap", "hop", "jump_toidle", "gallop_jump"],
  attack: [
    "attack",
    "bite",
    "punch",
    "slash",
    "stab",
    "shoot",
    "sword",
    "dagger",
    "headbutt",
    "kick",
  ],
  die: ["death", "dead"],
  idle: ["idle", "standing"],
  swim: ["swim", "swimming"],
  fly: ["fly", "flying", "flap"],
  shoot: ["shoot", "gun", "fire", "reload"],
  hit: ["hitreact", "hitrecieve", "recievehit"],
  dance: ["dance", "wave", "hello"],
  chibi: ["chibi", "cute", "blocky", "cartoon"],
  human: ["character", "person", "man", "woman", "people"],
  animal: ["animal", "creature", "beast"],
  quad: ["horse", "wolf", "cow", "deer", "dog", "cat", "gallop"],
  animated: ["animated", "animation", "rig"],
};

/** Expand query tokens using synonyms (only expands from keys, never from values). */
export function expandTokens(tokens: readonly string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    const synonyms = SYNONYMS[token];
    if (synonyms) {
      for (const s of synonyms) expanded.add(s);
    }
  }
  return [...expanded];
}

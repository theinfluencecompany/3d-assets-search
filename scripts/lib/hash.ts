import { createHash } from "node:crypto";

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce(
        (acc, key) => {
          acc[key] = sortKeys((value as Record<string, unknown>)[key]);
          return acc;
        },
        {} as Record<string, unknown>,
      );
  }
  return value;
}

export function stableHash(value: unknown): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(sortKeys(value)));
  return `sha256:${hash.digest("hex")}`;
}

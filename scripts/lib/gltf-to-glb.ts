import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

interface GltfBuffer {
  uri?: string;
  byteLength: number;
}

interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}

interface GltfImage {
  uri?: string;
  mimeType?: string;
  bufferView?: number;
}

interface GltfAsset {
  buffers?: GltfBuffer[];
  bufferViews?: GltfBufferView[];
  images?: GltfImage[];
  [key: string]: unknown;
}

interface ExternalResource {
  bytes: Uint8Array;
  contentType: string | undefined;
}

function padTo4(length: number): number {
  return (4 - (length % 4)) % 4;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodeDataUri(uri: string): ExternalResource {
  const match = uri.match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
  if (!match) {
    throw new Error(`Unsupported data URI: ${uri.slice(0, 32)}...`);
  }

  const [, mimeType, base64Flag, payload] = match;
  if (payload === undefined) {
    throw new Error(`Malformed data URI: ${uri.slice(0, 32)}...`);
  }
  const bytes = base64Flag
    ? Uint8Array.from(Buffer.from(payload, "base64"))
    : Uint8Array.from(Buffer.from(decodeURIComponent(payload), "utf8"));
  return { bytes, contentType: mimeType };
}

function inferMimeType(pathname: string): string | undefined {
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ktx2")) return "image/ktx2";
  return undefined;
}

async function fetchResource(uri: string): Promise<ExternalResource> {
  if (uri.startsWith("data:")) {
    return decodeDataUri(uri);
  }

  const res = await fetch(uri);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${uri}`);
  }

  const contentType = res.headers.get("content-type")?.split(";")[0] ?? inferMimeType(uri);
  return {
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: contentType || undefined,
  };
}

async function runCommand(args: string[]): Promise<{ stdout: Uint8Array; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `${args[0]} exited with code ${code}`);
  }
  return { stdout: new Uint8Array(stdout), stderr };
}

function chooseMainGltf(entries: string[]): string {
  const candidates = entries
    .filter((entry) => entry.toLowerCase().endsWith(".gltf"))
    .filter((entry) => !entry.startsWith("__MACOSX/"));

  if (candidates.length === 0) {
    throw new Error("ZIP does not contain a .gltf file");
  }

  candidates.sort((a, b) => {
    const depthDiff = a.split("/").length - b.split("/").length;
    if (depthDiff !== 0) return depthDiff;
    return a.length - b.length;
  });

  return candidates[0]!;
}

async function buildGlbFromParsedGltf(
  gltf: GltfAsset,
  loadResourceByUri: (uri: string) => Promise<ExternalResource>,
): Promise<Uint8Array> {
  const bufferViews = [...(gltf.bufferViews ?? [])];

  const originalBuffers = gltf.buffers ?? [];
  const resolvedBuffers = await Promise.all(
    originalBuffers.map(async (buffer, index) => {
      if (!buffer.uri) {
        throw new Error(`glTF buffer ${index} is missing uri and cannot be externalized`);
      }
      return loadResourceByUri(buffer.uri);
    }),
  );

  const imageInfos = await Promise.all(
    (gltf.images ?? []).map(async (image, index) => {
      if (image.bufferView !== undefined && !image.uri) {
        return null;
      }
      if (!image.uri) {
        throw new Error(`glTF image ${index} has neither uri nor bufferView`);
      }
      return loadResourceByUri(image.uri);
    }),
  );

  const binaryParts: Uint8Array[] = [];
  const bufferBaseOffsets: number[] = [];
  let totalBinaryLength = 0;

  for (const resource of resolvedBuffers) {
    bufferBaseOffsets.push(totalBinaryLength);
    binaryParts.push(resource.bytes);
    totalBinaryLength += resource.bytes.length;
    const padding = padTo4(resource.bytes.length);
    if (padding > 0) {
      binaryParts.push(new Uint8Array(padding));
      totalBinaryLength += padding;
    }
  }

  for (const view of bufferViews) {
    const baseOffset = bufferBaseOffsets[view.buffer];
    if (baseOffset === undefined) {
      throw new Error(`bufferView references missing buffer index ${view.buffer}`);
    }
    view.buffer = 0;
    view.byteOffset = baseOffset + (view.byteOffset ?? 0);
  }

  const images = [...(gltf.images ?? [])];
  for (const [index, image] of images.entries()) {
    const info = imageInfos[index];
    if (!info) continue;

    const imageBufferView: GltfBufferView = {
      buffer: 0,
      byteOffset: totalBinaryLength,
      byteLength: info.bytes.length,
    };
    bufferViews.push(imageBufferView);
    binaryParts.push(info.bytes);
    totalBinaryLength += info.bytes.length;
    const padding = padTo4(info.bytes.length);
    if (padding > 0) {
      binaryParts.push(new Uint8Array(padding));
      totalBinaryLength += padding;
    }

    delete image.uri;
    image.bufferView = bufferViews.length - 1;
    const mimeType = image.mimeType ?? info.contentType;
    if (!mimeType) {
      throw new Error(`Could not determine mimeType for image ${index}`);
    }
    image.mimeType = mimeType;
  }

  const binChunk = concatBytes(binaryParts);
  const updated: GltfAsset = {
    ...gltf,
    buffers: [{ byteLength: binChunk.length }],
    bufferViews,
    images,
  };

  for (const buffer of updated.buffers ?? []) {
    delete buffer.uri;
  }

  const jsonChunk = Buffer.from(JSON.stringify(updated), "utf8");
  const jsonPadding = padTo4(jsonChunk.length);
  const jsonChunkPadded = new Uint8Array(jsonChunk.length + jsonPadding);
  jsonChunkPadded.set(jsonChunk, 0);
  jsonChunkPadded.fill(0x20, jsonChunk.length);

  const binPadding = padTo4(binChunk.length);
  const binChunkPadded = new Uint8Array(binChunk.length + binPadding);
  binChunkPadded.set(binChunk, 0);

  const totalLength = 12 + 8 + jsonChunkPadded.length + 8 + binChunkPadded.length;
  const glb = new Uint8Array(totalLength);
  const view = new DataView(glb.buffer);

  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, totalLength, true);

  let offset = 12;
  view.setUint32(offset, jsonChunkPadded.length, true);
  view.setUint32(offset + 4, 0x4e4f534a, true);
  offset += 8;
  glb.set(jsonChunkPadded, offset);
  offset += jsonChunkPadded.length;

  view.setUint32(offset, binChunkPadded.length, true);
  view.setUint32(offset + 4, 0x004e4942, true);
  offset += 8;
  glb.set(binChunkPadded, offset);

  return glb;
}

export async function convertGltfToGlb(gltfUrl: string): Promise<Uint8Array> {
  return convertGltfToGlbWithIncludes(gltfUrl);
}

export async function convertGltfToGlbWithIncludes(
  gltfUrl: string,
  includeUrls?: Record<string, string>,
): Promise<Uint8Array> {
  const gltfRes = await fetch(gltfUrl);
  if (!gltfRes.ok) {
    throw new Error(`Failed to fetch glTF: HTTP ${gltfRes.status}`);
  }

  const gltf = (await gltfRes.json()) as GltfAsset;
  const baseUrl = new URL(gltfUrl);
  return buildGlbFromParsedGltf(gltf, (uri) =>
    fetchResource(
      uri.startsWith("data:")
        ? uri
        : (includeUrls?.[uri] ??
            includeUrls?.[posix.normalize(uri)] ??
            new URL(uri, baseUrl).toString()),
    ),
  );
}

export async function convertZipToGlb(zipUrl: string): Promise<Uint8Array> {
  const zipRes = await fetch(zipUrl);
  if (!zipRes.ok) {
    throw new Error(`Failed to fetch ZIP: HTTP ${zipRes.status}`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), "polyhaven-zip-"));
  const zipPath = join(tempDir, "asset.zip");

  try {
    await writeFile(zipPath, new Uint8Array(await zipRes.arrayBuffer()));

    const listResult = await runCommand(["/usr/bin/unzip", "-Z1", zipPath]);
    const entries = new TextDecoder()
      .decode(listResult.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const mainGltf = chooseMainGltf(entries);
    const entrySet = new Set(entries);

    const gltfBytes = (await runCommand(["/usr/bin/unzip", "-p", zipPath, mainGltf])).stdout;
    const gltf = JSON.parse(new TextDecoder().decode(gltfBytes)) as GltfAsset;

    return buildGlbFromParsedGltf(gltf, async (uri) => {
      if (uri.startsWith("data:")) {
        return decodeDataUri(uri);
      }

      const resolved = posix.normalize(posix.join(posix.dirname(mainGltf), uri));
      const exact = entrySet.has(resolved) ? resolved : uri;
      if (!entrySet.has(exact)) {
        throw new Error(`Missing ZIP entry for ${uri} (resolved to ${resolved})`);
      }

      const bytes = (await runCommand(["/usr/bin/unzip", "-p", zipPath, exact])).stdout;
      return {
        bytes,
        contentType: inferMimeType(exact),
      };
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

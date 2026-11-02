/**
 * Outils PNG purs (sans DOM) : lecture des chunks et suppression de tout
 * chunk auxiliaire (eXIf, tEXt, iTXt, zTXt, tIME, iCCP, pHYs...).
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Chunks conservés : strictement ce qu'il faut pour décoder l'image RGBA. */
const KEEP = new Set(["IHDR", "PLTE", "tRNS", "IDAT", "IEND"]);

export interface PngChunk {
  type: string;
  offset: number;
  length: number;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

export function listPngChunks(bytes: Uint8Array): PngChunk[] {
  if (!isPng(bytes)) throw new Error("Ce n'est pas un PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: PngChunk[] = [];
  let p = 8;
  while (p + 8 <= bytes.length) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (p + 12 + length > bytes.length) throw new Error("PNG tronqué");
    chunks.push({ type, offset: p, length });
    p += 12 + length;
    if (type === "IEND") break;
  }
  return chunks;
}

/** Renvoie un PNG ne contenant que IHDR, PLTE, tRNS, IDAT et IEND. */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const chunks = listPngChunks(bytes);
  const kept = chunks.filter((c) => KEEP.has(c.type));
  const size = 8 + kept.reduce((n, c) => n + 12 + c.length, 0);
  const out = new Uint8Array(size);
  out.set(bytes.subarray(0, 8), 0);
  let p = 8;
  for (const c of kept) {
    out.set(bytes.subarray(c.offset, c.offset + 12 + c.length), p);
    p += 12 + c.length;
  }
  return out;
}

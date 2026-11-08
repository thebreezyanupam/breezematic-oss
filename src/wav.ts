import fs from 'node:fs';
import path from 'node:path';

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataBytes = samples.length * 2;

  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);

  const body = Buffer.alloc(dataBytes);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0));
    body.writeInt16LE(Math.round(sample * 32767), i * 2);
  }

  return Buffer.concat([header, body]);
}

export function writeWavPcm16(file: string, samples: Float32Array, sampleRate: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodeWavPcm16(samples, sampleRate));
}

export function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

/**
 * The inverse of the above, for reading a cached line back.
 *
 * Deliberately narrow: it reads what `encodeWavPcm16` writes -- mono, 16-bit,
 * one `data` chunk -- and nothing else, because that is the only thing this
 * codebase ever asks it to read. A general WAV parser would be more code and
 * more ways to be subtly wrong about a file that this program produced itself.
 *
 * The chunk is still located by walking rather than assumed at byte 44: some
 * encoders write a LIST or fact chunk before the data, and a fixed offset
 * would read the metadata as audio and produce a very loud noise.
 */
export function readWavPcm16(file: string): { samples: Float32Array; rate: number } {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(`${path.basename(file)} is not a RIFF file`);
  }

  let rate = 24_000;
  let at = 12;
  while (at + 8 <= buffer.length) {
    const id = buffer.toString('ascii', at, at + 4);
    const size = buffer.readUInt32LE(at + 4);
    const body = at + 8;

    if (id === 'fmt ') rate = buffer.readUInt32LE(body + 4);
    if (id === 'data') {
      const end = Math.min(body + size, buffer.length);
      const samples = new Float32Array(Math.floor((end - body) / 2));
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buffer.readInt16LE(body + i * 2) / 32768;
      }
      return { samples, rate };
    }
    // Chunks are word-aligned, and an odd size carries a pad byte.
    at = body + size + (size % 2);
  }
  throw new Error(`${path.basename(file)} has no data chunk`);
}

import { staticFile } from 'remotion';
import { isFootageFile } from '../schema.js';

/**
 * Where a beat's picture is served from. The test itself lives in the schema,
 * so the renderer and the pipeline cannot drift on what counts as footage.
 */
export const isFootage = isFootageFile;

export function mediaSrc(file: string): string {
  return staticFile(`${isFootage(file) ? 'videos' : 'images'}/${file}`);
}

/** Restore local JSON graphs from the compressed snapshots shipped in Git. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

// An optional data directory makes restoration usable and testable in isolation.
const dataDir = process.argv[2]
  ? path.resolve(process.argv[2])
  : fileURLToPath(new URL('../public/data/', import.meta.url));

for (const mode of ['gta', 'ontario']) {
  const destination = path.join(dataDir, `${mode}.json`);
  try {
    const existing = await fs.stat(destination);
    if (!existing.isFile()) throw new Error(`Expected a file at ${destination}`);
    console.log(`${mode}: keeping existing JSON graph`);
    continue;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const compressed = await fs.readFile(`${destination}.gz`);
  const graph = gunzipSync(compressed);
  JSON.parse(graph.toString('utf8'));
  // Never replace an existing graph, including one created during restoration.
  await fs.writeFile(destination, graph, { flag: 'wx' });
  console.log(`${mode}: restored ${graph.length.toLocaleString('en-US')} bytes`);
}

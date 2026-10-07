/** Validate the bundled real graph artifacts and gzip round trips. */
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/data');
for (const mode of ['gta', 'ontario']) {
  const original = await fs.readFile(path.join(dataDir, `${mode}.json`));
  const compressed = await fs.readFile(path.join(dataDir, `${mode}.json.gz`));
  assert.deepEqual(gunzipSync(compressed), original, `${mode}: gzip round trip`);
  const graph = JSON.parse(original.toString());
  assert.equal(graph.metadata.nodeCount, graph.nodes.length);
  assert.equal(graph.metadata.edgeCount, graph.edges.length);
  assert.ok(graph.nodes.length > 100000, `${mode}: actual regional graph`);
  let sum = 0;
  const directionCounts = { both: 0, forward: 0, reverse: 0 };
  for (const [i, edge] of graph.edges.entries()) {
    const [u, v, km, minutes, cls, name, direction, gi] = edge;
    const shape = graph.geometry[gi];
    assert.ok(graph.nodes[u] && graph.nodes[v] && shape?.length >= 2, `${mode}: edge ${i} references`);
    assert.deepEqual(shape[0], graph.nodes[u], `${mode}: edge ${i} starts at source`);
    assert.deepEqual(shape.at(-1), graph.nodes[v], `${mode}: edge ${i} ends at target`);
    assert.ok(km > 0 && minutes > 0 && Number.isFinite(km + minutes), `${mode}: edge ${i} metric`);
    assert.ok(cls >= 0 && cls < graph.classes.length && name >= 0 && name < graph.names.length);
    assert.ok([-1, 0, 1].includes(direction));
    assert.notEqual(graph.classes[cls], 'service');
    directionCounts[direction === 0 ? 'both' : direction === 1 ? 'forward' : 'reverse']++;
    sum += km;
  }
  assert.ok(Math.abs(sum - graph.metadata.totalKm) <= 0.00051, `${mode}: denominator sums physical edges once`);
  assert.ok(directionCounts.forward > 0 && directionCounts.both > 0);
  assert.ok(graph.metadata.rawSha256?.length === 64);
  if (mode === 'gta') assert.ok(graph.metadata.ontarioAreaFilter?.excludedOutsideOntarioWays > 0);
  console.log(JSON.stringify({ mode, valid: true, nodes: graph.nodes.length, edges: graph.edges.length, totalKm: graph.metadata.totalKm, directionCounts, gzipBytes: compressed.length }));
}

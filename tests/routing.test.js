import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { buildGraph, route, calculateReachable, reachableIntervals, arrivalAt, nearestRoad } from '../src/routing.js';

function dataset(nodes, entries) {
  return { nodes, edges: entries.map(([u, v, km, minutes, oneWay = 0], i) => [u, v, km, minutes, 0, 0, oneWay, i]), geometry: entries.map(([u, v]) => [nodes[u], nodes[v]]) };
}
function close(actual, expected, tolerance = 1e-7) { assert.ok(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`); }

test('Dijkstra respects one-way restrictions and takes a directed detour', () => {
  const data = dataset([[0, 0], [0.02, 0], [0.02, 0.02]], [[0, 1, 2, 2, 1], [1, 2, 2, 3, 1], [2, 0, 2, 4, 1]]);
  const result = route(buildGraph(data), data.nodes[1]);
  close(result.nodeTimes[0], 7);
  close(result.nodeTimes[1], 0);
  close(result.nodeTimes[2], 3);
});

test('shortest time follows a longer fast road instead of a shorter slow road', () => {
  const data = dataset([[0, 0], [0.02, 0], [0.01, 0.01]], [[0, 1, 1, 10], [0, 2, 2, 2], [2, 1, 2, 2]]);
  const result = route(buildGraph(data), data.nodes[0]);
  close(result.nodeTimes[1], 4);
  close(result.maxMinutes, 7); // The middle of the slow road is last to flood.
});

test('disconnected roads remain unreachable and remain in the denominator', () => {
  const data = dataset([[0, 0], [0.02, 0], [1, 1], [1.02, 1]], [[0, 1, 2, 10], [2, 3, 8, 20]]);
  const result = route(buildGraph(data), [0, 0]);
  assert.equal(result.nodeTimes[2], Infinity);
  close(result.connectedKm, 2);
  close(result.maxMinutes, 10);
  close(calculateReachable(data, result, 100).percent, 20);
  assert.deepEqual(reachableIntervals(data, result, 1, 100), []);
});

test('middle-road snapping starts at the virtual origin instead of a junction', () => {
  const data = dataset([[0, 0], [0.1, 0]], [[0, 1, 10, 10]]);
  const graph = buildGraph(data);
  const result = route(graph, [0.04, 0]);
  close(result.snap.fraction, 0.4);
  close(result.nodeTimes[0], 4);
  close(result.nodeTimes[1], 6);
  close(result.maxMinutes, 6);
  close(calculateReachable(data, result, 2).lengthKm, 4);
  const intervals = reachableIntervals(data, result, 0, 2);
  close(intervals[0][0], 0.2);
  close(intervals[0][1], 0.6);
  close(arrivalAt(graph, result, [0.05, 0]).minutes, 1);
});

test('a source inside a one-way road cannot reach the road behind it without a return path', () => {
  const data = dataset([[0, 0], [0.1, 0]], [[0, 1, 10, 10, 1]]);
  const graph = buildGraph(data);
  const result = route(graph, [0.04, 0]);
  assert.equal(result.nodeTimes[0], Infinity);
  close(result.nodeTimes[1], 6);
  close(result.connectedKm, 6);
  close(calculateReachable(data, result, 100).lengthKm, 6);
  close(calculateReachable(data, result, 2).lengthKm, 2);
  assert.equal(arrivalAt(graph, result, [0.02, 0]).minutes, Infinity);
});

test('reverse one-way snapping only reaches the permitted half of the source edge', () => {
  const data = dataset([[0, 0], [0.1, 0]], [[0, 1, 10, 10, -1]]);
  const result = route(buildGraph(data), [0.04, 0]);
  close(result.nodeTimes[0], 4);
  assert.equal(result.nodeTimes[1], Infinity);
  close(result.maxMinutes, 4);
  close(calculateReachable(data, result, 2).lengthKm, 2);
  close(calculateReachable(data, result, 100).lengthKm, 4);
});

test('fronts meeting from both ends count physical length once', () => {
  const data = dataset([[0, 0], [0.02, 0], [0.01, 0.01]], [[0, 1, 10, 10], [0, 2, 1, 1], [2, 1, 1, 1]]);
  const result = route(buildGraph(data), data.nodes[2]);
  close(calculateReachable(data, result, 3).lengthKm, 6);
  close(calculateReachable(data, result, 6).lengthKm, 12);
  close(calculateReachable(data, result, 30).lengthKm, 12);
  close(result.maxMinutes, 6);
  assert.deepEqual(reachableIntervals(data, result, 0, 6), [[0, 1]]);
});

test('time index agrees with merged road intervals for a directed graph and a middle-edge origin', () => {
  const data = dataset([[0, 0], [0.1, 0], [0.1, 0.1], [0, 0.1]], [[0, 1, 10, 10, 1], [1, 2, 3, 2], [2, 3, 5, 3], [3, 0, 2, 1, 1], [0, 2, 11, 13]]);
  const result = route(buildGraph(data), [0.04, 0]);
  for (let t = 0; t < result.maxMinutes + 1; t += 0.137) {
    const expected = data.edges.reduce((total, edge, i) => total + reachableIntervals(data, result, i, t).reduce((sum, [a, b]) => sum + (b - a) * edge[2], 0), 0);
    close(calculateReachable(data, result, t).lengthKm, expected, 1e-6);
  }
});

test('route cache reuses common origins and separates speed assumptions', () => {
  const data = dataset([[0, 0], [0.1, 0]], [[0, 1, 10, 10]]);
  const graph = buildGraph(data, { cacheSize: 1 });
  const first = route(graph, [0, 0]);
  const cached = route(graph, [0, 0]);
  assert.equal(first.cacheHit, false);
  assert.equal(cached.cacheHit, true);
  assert.equal(first.nodeTimes, cached.nodeTimes);
  const faster = route(graph, [0, 0], { speedMultiplier: 2 });
  close(faster.maxMinutes, 5);
  assert.equal(faster.cacheHit, false);
  assert.equal(route(graph, [0, 0]).cacheHit, false);
});

test('snapping follows curved geometry and reports off-network gap', () => {
  const data = dataset([[0, 0], [0.1, 0.1]], [[0, 1, 20, 20]]);
  data.geometry[0] = [[0, 0], [0.1, 0], [0.1, 0.1]];
  const snap = nearestRoad(buildGraph(data), [0.05, 0.001]);
  close(snap.coordinate[0], 0.05);
  close(snap.coordinate[1], 0);
  close(snap.fraction, 0.25);
  assert.ok(snap.distanceKm > 0.11 && snap.distanceKm < 0.12);
});

test('a long connected network determines its own maximum above eight hours', () => {
  const data = dataset([[0, 0], [1, 0], [2, 0]], [[0, 1, 500, 600], [1, 2, 500, 600]]);
  const result = route(buildGraph(data), [0, 0]);
  close(result.maxMinutes, 1200);
  close(calculateReachable(data, result, 600).percent, 50);
  close(calculateReachable(data, result, Infinity).percent, 100);
});

test('spatial index finds the closest geometry across multiple index branches', () => {
  const nodes = [], entries = [];
  for (let i = 0; i < 100; i++) {
    nodes.push([i * 0.01, 0], [i * 0.01, 0.1]);
    entries.push([2 * i, 2 * i + 1, 10, 10]);
  }
  const graph = buildGraph(dataset(nodes, entries));
  const snap = nearestRoad(graph, [0.734, 0.03]);
  assert.equal(snap.edgeIndex, 73);
  close(snap.fraction, 0.3);
  close(snap.coordinate[0], 0.73);
});

test('worker reports missing HTML fallback data clearly, retries failed loads, and caches successful loads', async () => {
  const originalFetch = globalThis.fetch;
  const originalSelf = globalThis.self;
  const responses = [];
  const data = dataset([[0, 0], [0.1, 0]], [[0, 1, 10, 10]]);
  let fetches = 0;
  globalThis.self = { postMessage: (message) => responses.push(message) };
  globalThis.fetch = async () => {
    fetches++;
    return fetches <= 2
      ? new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } })
      : new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  };
  try {
    await import('../src/routing.worker.js?routing-test');
    await self.onmessage({ data: { id: 1, type: 'load', mode: 'gta' } });
    assert.equal(responses[0].type, 'error');
    assert.equal(responses[0].error, 'The road dataset is unavailable. Rebuild or download the road data, then retry.');
    await self.onmessage({ data: { id: 2, type: 'load', mode: 'gta' } });
    assert.equal(responses[1].type, 'loaded');
    await self.onmessage({ data: { id: 3, type: 'route', mode: 'gta', origin: [0, 0] } });
    assert.equal(responses[2].type, 'route');
    close(responses[2].result.maxMinutes, 10);
    assert.equal(fetches, 3);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});

test('worker loads gzip-only data and accepts transparently decompressed gzip responses', async () => {
  const originalFetch = globalThis.fetch;
  const originalSelf = globalThis.self;
  const data = dataset([[0, 0], [0.1, 0]], [[0, 1, 10, 10]]);
  try {
    for (const compressed of [true, false]) {
      const responses = [], urls = [];
      globalThis.self = { postMessage: (message) => responses.push(message) };
      globalThis.fetch = async (url) => {
        urls.push(url);
        return new Response(compressed ? gzipSync(JSON.stringify(data)) : JSON.stringify(data), {
          headers: compressed ? { 'content-type': 'application/gzip' } : { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        });
      };
      await import(`../src/routing.worker.js?gzip-test-${compressed}`);
      await self.onmessage({ data: { id: 1, type: 'load', mode: 'ontario' } });
      assert.equal(responses[0].type, 'loaded');
      await self.onmessage({ data: { id: 2, type: 'route', mode: 'ontario', origin: [0, 0], destinations: [{ name: 'Destination', coordinates: [0.1, 0] }] } });
      assert.equal(responses[1].type, 'route');
      close(responses[1].destinations[0].minutes, 10);
      assert.deepEqual(urls, ['/data/ontario.json.gz']);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSelf === undefined) delete globalThis.self;
    else globalThis.self = originalSelf;
  }
});

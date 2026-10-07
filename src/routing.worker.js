import { buildGraph, route, arrivalAt, nearestRoad } from './routing.js';

const graphLoads = new Map();
const unavailableMessage = 'The road dataset is unavailable. Rebuild or download the road data, then retry.';

async function readDataset(mode) {
  let body;
  try {
    const response = await fetch(`/data/${mode}.json.gz`);
    if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) throw new Error(unavailableMessage);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // Some static hosts transparently decompress .gz assets. Inspect the
    // bytes rather than assuming a second decompression is necessary.
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Gzip decompression is unavailable in this browser.');
      body = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    } else body = new TextDecoder().decode(bytes);
    if (!body.trimStart().startsWith('{')) throw new Error(unavailableMessage);
  } catch {
    // Local preprocessing also retains the plain JSON source graph.
    const response = await fetch(`/data/${mode}.json`);
    if (!response.ok || /text\/html/i.test(response.headers.get('content-type') || '')) throw new Error(unavailableMessage);
    body = await response.text();
  }
  if (!body.trimStart().startsWith('{')) throw new Error(unavailableMessage);
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(unavailableMessage); }
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error(unavailableMessage);
  return data;
}

async function getGraph(mode) {
  if (!['ontario', 'gta'].includes(mode)) throw new Error('Unknown road-network mode.');
  if (!graphLoads.has(mode)) {
    graphLoads.set(mode, (async () => {
      const data = await readDataset(mode);
      return buildGraph(data, { cacheSize: 3 });
    })().catch((error) => {
      graphLoads.delete(mode);
      throw error;
    }));
  }
  return graphLoads.get(mode);
}

self.onmessage = async ({ data: request }) => {
  const { id, type, mode = 'ontario' } = request;
  try {
    const graph = await getGraph(mode);
    if (type === 'load') {
      self.postMessage({ id, type: 'loaded', mode, data: graph.data });
    } else if (type === 'route') {
      const result = route(graph, request.origin, { speedMultiplier: request.speedMultiplier ?? 1 });
      const destinations = (request.destinations || []).map((destination) => {
        const coordinate = Array.isArray(destination) ? destination : destination.coordinates || destination.coordinate;
        return { ...(Array.isArray(destination) ? { coordinates: destination } : destination), ...arrivalAt(graph, result, coordinate) };
      });
      // Structured clone retains the worker's cached typed arrays for reuse.
      self.postMessage({ id, type: 'route', mode, result, destinations });
    } else if (type === 'snap') {
      self.postMessage({ id, type: 'snap', mode, snap: nearestRoad(graph, request.coordinate) });
    } else {
      throw new Error(`Unknown routing request: ${type}`);
    }
  } catch (error) {
    self.postMessage({ id, type: 'error', mode, error: error.message || String(error) });
  }
};

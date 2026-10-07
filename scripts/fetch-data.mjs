/**
 * Download and preprocess genuine OpenStreetMap roads for the explorer.
 * Run: node --preserve-symlinks --preserve-symlinks-main scripts/fetch-data.mjs [gta|ontario|all]
 * Raw responses are cached in .data-cache. Refresh explicitly with --refresh.
 * OSM data © OpenStreetMap contributors, ODbL 1.0.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, '.data-cache');
const output = path.join(root, 'public/data');
await fs.mkdir(cache, { recursive: true });
await fs.mkdir(output, { recursive: true });
const endpoint = process.env.OVERPASS_ENDPOINT || 'https://overpass-api.de/api/interpreter';
const ua = 'OntarioDriveTimeExplorer/1.0 (local educational road accessibility app; OpenStreetMap data preprocessing)';
const classes = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service'];
const defaults = [100, 60, 90, 50, 80, 50, 70, 40, 60, 40, 40, 50, 20, 20];
const datasets = {
  gta: {
    title: 'Greater Toronto and Hamilton area — detailed road extract',
    bbox: [-80.25, 43.05, -78.5, 44.3],
    scope: 'Ontario OSM roads in a fixed Greater Toronto and Hamilton area bounding box. Motorways through residential/unclassified/living streets are included; service roads (including parking aisles and driveways) are excluded. The box extends beyond the GTA and is not an administrative boundary. Extract coverage is partial at its edges.',
    query: `[out:json][timeout:180][maxsize:268435456];way["highway"~"^(${classes.join('|')})$"](43.05,-80.25,44.3,-78.5);out body geom;`,
  },
  ontario: {
    title: 'Ontario — major-road network',
    bbox: [-95.17, 41.67, -74.32, 56.87],
    scope: 'Ontario OSM motorway, trunk, primary and secondary roads and their links. Local, residential, tertiary, service and other minor roads are excluded; this is a major-road subset, not all drivable roads in Ontario.',
    query: '[out:json][timeout:180][maxsize:268435456];area["ISO3166-2"="CA-ON"]["boundary"="administrative"]->.ontario;way(area.ontario)["highway"~"^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link)$"];out body geom;',
  },
};
const gtaOntarioMask = {
  query: `[out:json][timeout:120][maxsize:134217728];area["ISO3166-2"="CA-ON"]["boundary"="administrative"]->.ontario;way(area.ontario)["highway"~"^(${classes.join('|')})$"](43.05,-80.25,44.3,-78.5);out ids;`,
};

function distance(a, b) {
  const rad = Math.PI / 180;
  const dp = (b[1] - a[1]) * rad;
  const dl = (b[0] - a[0]) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dl / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function permitted(tags) {
  const access = tags.motorcar ?? tags.motor_vehicle ?? tags.vehicle ?? tags.access;
  // Destination/customer/private/permit roads are unavailable to unrestricted through travel.
  return !['no', 'private', 'customers', 'delivery', 'destination', 'agricultural', 'forestry', 'permit'].includes(access);
}

function speed(tags, index) {
  const value = tags.maxspeed || '';
  const numeric = Number.parseFloat(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.min(130, /mph/i.test(value) ? numeric * 1.609344 : numeric);
  return defaults[index];
}

function direction(tags) {
  if (['-1', 'reverse'].includes(tags.oneway)) return -1;
  if (['no', '0', 'false'].includes(tags.oneway)) return 0;
  if (['yes', '1', 'true'].includes(tags.oneway) || tags.highway === 'motorway' || tags.junction === 'roundabout') return 1;
  return 0;
}

function simplify(shape, toleranceKm = 0.005) {
  if (shape.length <= 2) return shape;
  const cos = Math.cos((shape[0][1] + shape.at(-1)[1]) / 2 * Math.PI / 180);
  const tolerance2 = (toleranceKm / 111.195) ** 2;
  const keep = new Uint8Array(shape.length);
  keep[0] = keep[shape.length - 1] = 1;
  const stack = [[0, shape.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    const ax = shape[start][0] * cos, ay = shape[start][1];
    const dx = shape[end][0] * cos - ax, dy = shape[end][1] - ay;
    const denominator = dx * dx + dy * dy;
    let furthest = -1, max = tolerance2;
    for (let i = start + 1; i < end; i++) {
      const px = shape[i][0] * cos - ax, py = shape[i][1] - ay;
      const t = denominator ? Math.max(0, Math.min(1, (px * dx + py * dy) / denominator)) : 0;
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > max) { max = d; furthest = i; }
    }
    if (furthest >= 0) { keep[furthest] = 1; stack.push([start, furthest], [furthest, end]); }
  }
  return shape.filter((_, i) => keep[i]);
}

async function fetchRaw(mode, definition) {
  const file = path.join(cache, `${mode}-osm.json`);
  if (!process.argv.includes('--refresh')) {
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed.elements?.length && !parsed.remark) return { raw, parsed };
    } catch {}
  }
  console.log(`Downloading ${mode} from ${endpoint}…`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'User-Agent': ua, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: definition.query }),
    signal: AbortSignal.timeout(420000),
  });
  if (!response.ok) throw new Error(`Overpass ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  const raw = await response.text();
  const parsed = JSON.parse(raw);
  if (parsed.remark) throw new Error(`Incomplete Overpass response: ${parsed.remark}`);
  if (!parsed.elements?.length) throw new Error('The Overpass extract is empty.');
  await fs.writeFile(file, raw);
  console.log(`Cached ${(raw.length / 1048576).toFixed(1)} MiB, ${parsed.elements.length.toLocaleString()} OSM ways.`);
  return { raw, parsed };
}

function build(mode, definition, raw, parsed) {
  const ways = parsed.elements.filter(w => w.type === 'way' && w.nodes?.length > 1 && w.geometry?.length === w.nodes.length && w.tags?.highway !== 'service' && permitted(w.tags || {}));
  const references = new Map();
  for (const way of ways) for (const id of new Set(way.nodes)) references.set(id, (references.get(id) || 0) + 1);
  const nodes = [];
  const nodeIndex = new Map();
  const names = [];
  const nameIndex = new Map();
  const edges = [];
  const geometry = [];
  const taggedSpeedWays = ways.filter(w => Number.parseFloat(w.tags?.maxspeed) > 0).length;
  let totalKm = 0;
  let originalGeometryPoints = 0;
  let simplifiedGeometryPoints = 0;
  const classStats = {};
  function indexNode(id, coordinate) {
    if (!nodeIndex.has(id)) { nodeIndex.set(id, nodes.length); nodes.push(coordinate); }
    return nodeIndex.get(id);
  }
  function indexName(text) {
    if (!nameIndex.has(text)) { nameIndex.set(text, names.length); names.push(text); }
    return nameIndex.get(text);
  }
  for (const way of ways) {
    const tags = way.tags || {};
    const ci = classes.indexOf(tags.highway);
    if (ci < 0) continue;
    const name = indexName(tags.name || tags.ref || classes[ci].replaceAll('_', ' '));
    const kmh = speed(tags, ci);
    const oneway = direction(tags);
    let start = 0;
    for (let i = 1; i < way.nodes.length; i++) {
      const isClosedMidpoint = way.nodes[0] === way.nodes.at(-1) && i === Math.floor(way.nodes.length / 2);
      if (i < way.nodes.length - 1 && references.get(way.nodes[i]) < 2 && !isClosedMidpoint) continue;
      const shape = way.geometry.slice(start, i + 1).map(p => [Number(p.lon.toFixed(6)), Number(p.lat.toFixed(6))]);
      const lengthKm = shape.slice(1).reduce((sum, point, j) => sum + distance(shape[j], point), 0);
      if (lengthKm > 0.000001) {
        const u = indexNode(way.nodes[start], shape[0]);
        const v = indexNode(way.nodes[i], shape.at(-1));
        const simplified = simplify(shape);
        originalGeometryPoints += shape.length;
        simplifiedGeometryPoints += simplified.length;
        const g = geometry.push(simplified) - 1;
        const roundedKm = Number(lengthKm.toFixed(6));
        totalKm += roundedKm;
        edges.push([u, v, roundedKm, Number((lengthKm / kmh * 60).toFixed(6)), ci, name, oneway, g]);
        classStats[classes[ci]] ??= { edges: 0, lengthKm: 0 };
        classStats[classes[ci]].edges++;
        classStats[classes[ci]].lengthKm += roundedKm;
      }
      start = i;
    }
  }
  const parent = Int32Array.from(nodes, (_, i) => i);
  function find(n) { while (parent[n] !== n) { parent[n] = parent[parent[n]]; n = parent[n]; } return n; }
  for (const [u, v] of edges) parent[find(u)] = find(v);
  const components = new Map();
  for (let i = 0; i < nodes.length; i++) { const c = find(i); components.set(c, (components.get(c) || 0) + 1); }
  const metadata = {
    id: mode, title: definition.title, scope: definition.scope, bbox: definition.bbox,
    source: 'OpenStreetMap', sourceUrl: 'https://www.openstreetmap.org/copyright', license: 'ODbL 1.0',
    attribution: '© OpenStreetMap contributors', endpoint,
    retrievedAt: new Date().toISOString(), osmTimestamp: parsed.osm3s?.timestamp_osm_base || null,
    rawSha256: createHash('sha256').update(raw).digest('hex'), query: definition.query,
    totalKm: Number(totalKm.toFixed(3)), nodeCount: nodes.length, edgeCount: edges.length,
    osmWayCount: ways.length, downloadedWayCount: parsed.elements.length,
    weakComponentCount: components.size, largestWeakComponentNodes: Math.max(...components.values()),
    taggedSpeedWays, defaultSpeedWays: ways.length - taggedSpeedWays,
    classStats: Object.fromEntries(Object.entries(classStats).map(([key, value]) => [key, { ...value, lengthKm: Number(value.lengthKm.toFixed(3)) }])),
    geometrySimplification: { method: 'Douglas-Peucker', toleranceMetres: 5, originalGeometryPoints, simplifiedGeometryPoints, note: 'Length and travel time are calculated from original geometry; only displayed and snapped line geometry is simplified. Endpoints and graph intersections are preserved.' },
    defaultSpeedKph: Object.fromEntries(classes.map((c, i) => [c, defaults[i]])),
    edgeSchema: ['fromNode', 'toNode', 'lengthKm', 'freeFlowMinutes', 'classIndex', 'nameIndex', 'oneway', 'geometryIndex'],
    onewayValues: { '0': 'both directions', '1': 'fromNode to toNode', '-1': 'toNode to fromNode' },
    lengthDefinition: 'Sum of imported physical OSM way segments, counted once each. Separate carriageways are separate OSM ways and counted separately.',
    boundarySelection: 'Ways selected by the OpenStreetMap Ontario administrative area. Whole selected ways retain their endpoint geometry, so a boundary-crossing way can extend slightly outside the selection boundary.',
    speedModel: 'OSM numeric maxspeed (mph converted), otherwise the documented per-class default. No traffic or intersection delays. Posted limits capped at 130 km/h.',
    limitations: [
      'Reachability applies only to the imported road network, not all real-world roads.',
      'Turn restrictions, timed/conditional restrictions, closures, traffic and intersection delays are not modelled.',
      'Directional maxspeed tags are not modelled; a single maxspeed/default applies to each way.',
      'Access tags use motorcar, then motor_vehicle, then vehicle, then access. Restricted/private/destination-only ways are excluded.',
      'One-way tags, motorway defaults and roundabouts are respected. One-way conditional and reversible lanes are not modelled.',
      'Nodes at grade-separated crossings are not joined unless OpenStreetMap shares the node.',
    ],
  };
  return { metadata, classes, names, nodes, edges, geometry };
}

const requested = process.argv[2] || 'all';
for (const [mode, definition] of Object.entries(datasets)) {
  if (requested !== 'all' && requested !== mode) continue;
  const { raw, parsed } = await fetchRaw(mode, definition);
  let maskInfo = null;
  if (mode === 'gta') {
    const mask = await fetchRaw('gta-ontario-way-ids', gtaOntarioMask);
    const allowed = new Set(mask.parsed.elements.map(w => w.id));
    const originalCount = parsed.elements.length;
    parsed.elements = parsed.elements.filter(w => allowed.has(w.id));
    maskInfo = { query: gtaOntarioMask.query, sha256: createHash('sha256').update(mask.raw).digest('hex'), osmTimestamp: mask.parsed.osm3s?.timestamp_osm_base, excludedOutsideOntarioWays: originalCount - parsed.elements.length };
    console.log(`Ontario area filter retained ${parsed.elements.length.toLocaleString()} ways; excluded ${maskInfo.excludedOutsideOntarioWays.toLocaleString()} outside Ontario.`);
  }
  const graph = build(mode, definition, raw, parsed);
  if (maskInfo) graph.metadata.ontarioAreaFilter = maskInfo;
  const serialized = JSON.stringify(graph);
  await fs.writeFile(path.join(output, `${mode}.json`), serialized);
  const compressed = gzipSync(serialized, { level: 9 });
  await fs.writeFile(path.join(output, `${mode}.json.gz`), compressed);
  await fs.writeFile(path.join(output, `${mode}-metadata.json`), JSON.stringify(graph.metadata, null, 2) + '\n');
  console.log(JSON.stringify({ mode, jsonBytes: serialized.length, gzipBytes: compressed.length, ...Object.fromEntries(['nodeCount', 'edgeCount', 'totalKm', 'weakComponentCount', 'largestWeakComponentNodes', 'osmTimestamp'].map(k => [k, graph.metadata[k]])) }));
}
const provenance = { generatedAt: new Date().toISOString(), roads: {}, context: { source: 'Natural Earth', sourceUrl: 'https://www.naturalearthdata.com/', license: 'Public domain', scale: '1:50 million' } };
for (const mode of Object.keys(datasets)) {
  try { provenance.roads[mode] = JSON.parse(await fs.readFile(path.join(output, `${mode}-metadata.json`), 'utf8')); } catch {}
}
await fs.writeFile(path.join(output, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');

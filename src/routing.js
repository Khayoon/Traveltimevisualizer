/**
 * Road-network routing, independent of the renderer.
 *
 * Compact edges: [from, to, km, minutes, class, name, oneWay, geometry].
 * oneWay is 0 (both), 1 (from -> to), or -1 (to -> from). Road length
 * always counts each geometry once, irrespective of direction.
 */
const EARTH_KM = 6371.0088;
const DEG = Math.PI / 180;
const KM_PER_DEG = EARTH_KM * DEG;
const EPS = 1e-10;

export function haversine(a, b) {
  const dLat = (b[1] - a[1]) * DEG;
  const dLon = (b[0] - a[0]) * DEG;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * DEG) * Math.cos(b[1] * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(Math.min(1, h)));
}

export function edgeGeometry(data, edgeIndex) {
  const edge = data.edges[edgeIndex];
  return data.geometry?.[edge[7]] || [data.nodes[edge[0]], data.nodes[edge[1]]];
}

class MinHeap {
  constructor() { this.ids = []; this.costs = []; }
  get size() { return this.ids.length; }
  push(id, cost) {
    let i = this.ids.length;
    this.ids.push(id); this.costs.push(cost);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.costs[p] <= cost) break;
      this.ids[i] = this.ids[p]; this.costs[i] = this.costs[p]; i = p;
    }
    this.ids[i] = id; this.costs[i] = cost;
  }
  pop() {
    const result = [this.ids[0], this.costs[0]];
    const id = this.ids.pop(); const cost = this.costs.pop();
    if (!this.ids.length) return result;
    let i = 0;
    while (true) {
      let c = i * 2 + 1;
      if (c >= this.ids.length) break;
      if (c + 1 < this.ids.length && this.costs[c + 1] < this.costs[c]) c++;
      if (this.costs[c] >= cost) break;
      this.ids[i] = this.ids[c]; this.costs[i] = this.costs[c]; i = c;
    }
    this.ids[i] = id; this.costs[i] = cost;
    return result;
  }
}

function buildSpatialIndex(data) {
  const boxes = new Float64Array(data.edges.length * 4);
  const order = new Uint32Array(data.edges.length);
  for (let i = 0; i < data.edges.length; i++) {
    order[i] = i;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of edgeGeometry(data, i)) {
      x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
      x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
    }
    boxes.set([x0, y0, x1, y1], i * 4);
  }
  function partition(lo, hi, nth, axis) {
    const center = (id) => boxes[id * 4 + axis] + boxes[id * 4 + axis + 2];
    while (lo < hi) {
      const pivot = center(order[(lo + hi) >> 1]);
      let a = lo, b = hi;
      while (a <= b) {
        while (center(order[a]) < pivot) a++;
        while (center(order[b]) > pivot) b--;
        if (a <= b) { const t = order[a]; order[a++] = order[b]; order[b--] = t; }
      }
      if (nth <= b) hi = b;
      else if (nth >= a) lo = a;
      else break;
    }
  }
  function build(lo, hi) {
    const node = { lo, hi, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = lo; i < hi; i++) {
      const j = order[i] * 4;
      node.x0 = Math.min(node.x0, boxes[j]); node.y0 = Math.min(node.y0, boxes[j + 1]);
      node.x1 = Math.max(node.x1, boxes[j + 2]); node.y1 = Math.max(node.y1, boxes[j + 3]);
    }
    if (hi - lo > 24) {
      const mid = (lo + hi) >> 1;
      const axis = (node.x1 - node.x0) * 0.7 > node.y1 - node.y0 ? 0 : 1;
      partition(lo, hi - 1, mid, axis);
      node.left = build(lo, mid); node.right = build(mid, hi);
    }
    return node;
  }
  return { order, root: data.edges.length ? build(0, data.edges.length) : null };
}

/** Prepare compact adjacency arrays and a bounding-volume tree for road snaps. */
export function buildGraph(data, { cacheSize = 6 } = {}) {
  if (!Array.isArray(data.nodes) || !Array.isArray(data.edges)) throw new Error('Invalid road dataset.');
  const degree = new Uint32Array(data.nodes.length);
  let totalKm = 0;
  for (const edge of data.edges) {
    const [u, v, length, time, , , direction] = edge;
    if (!Number.isInteger(u) || !Number.isInteger(v) || u < 0 || v < 0 || u >= degree.length || v >= degree.length || !(length > 0) || !(time > 0) || !Number.isFinite(length) || !Number.isFinite(time) || ![-1, 0, 1].includes(direction)) {
      throw new Error('Invalid road edge: node indexes, lengths, travel times, and directions must be valid.');
    }
    if (direction >= 0) degree[u]++;
    if (direction <= 0) degree[v]++;
    totalKm += length;
  }
  const offsets = new Uint32Array(degree.length + 1);
  for (let i = 0; i < degree.length; i++) offsets[i + 1] = offsets[i] + degree[i];
  const destinations = new Uint32Array(offsets[degree.length]);
  const costs = new Float64Array(destinations.length);
  const cursor = offsets.slice();
  for (const edge of data.edges) {
    const [u, v, , time, , , direction] = edge;
    if (direction >= 0) { const j = cursor[u]++; destinations[j] = v; costs[j] = time; }
    if (direction <= 0) { const j = cursor[v]++; destinations[j] = u; costs[j] = time; }
  }
  return { data, offsets, destinations, costs, totalKm, spatial: buildSpatialIndex(data), cache: new Map(), cacheSize };
}

/**
 * Find the closest position along a road, using a spatial index and a local
 * equirectangular projection. The reported off-network gap uses haversine km.
 * Snap distance is not silently converted to fictitious driving time.
 */
export function nearestRoad(graph, coordinate) {
  if (!Array.isArray(coordinate) || coordinate.length < 2 || !coordinate.every(Number.isFinite)) throw new Error('Origin must be a valid [longitude, latitude].');
  if (!graph.spatial.root) throw new Error('This dataset contains no routable roads.');
  const scaleX = Math.cos(coordinate[1] * DEG) * KM_PER_DEG;
  const scaleY = KM_PER_DEG;
  const boxDistance = (box) => {
    const dx = Math.max(box.x0 - coordinate[0], 0, coordinate[0] - box.x1) * scaleX;
    const dy = Math.max(box.y0 - coordinate[1], 0, coordinate[1] - box.y1) * scaleY;
    return dx * dx + dy * dy;
  };
  let best = Infinity, found;
  const stack = [graph.spatial.root];
  while (stack.length) {
    const box = stack.pop();
    if (boxDistance(box) > best) continue;
    if (box.left) {
      const left = boxDistance(box.left), right = boxDistance(box.right);
      if (left < right) { stack.push(box.right, box.left); }
      else { stack.push(box.left, box.right); }
      continue;
    }
    for (let k = box.lo; k < box.hi; k++) {
      const edgeIndex = graph.spatial.order[k];
      const points = edgeGeometry(graph.data, edgeIndex);
      let accumulated = 0, total = 0;
      const lengths = [];
      for (let i = 1; i < points.length; i++) { const len = haversine(points[i - 1], points[i]); lengths.push(len); total += len; }
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1], b = points[i];
        const ax = (a[0] - coordinate[0]) * scaleX, ay = (a[1] - coordinate[1]) * scaleY;
        const dx = (b[0] - a[0]) * scaleX, dy = (b[1] - a[1]) * scaleY;
        const denominator = dx * dx + dy * dy;
        const fraction = denominator ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / denominator)) : 0;
        const squared = (ax + fraction * dx) ** 2 + (ay + fraction * dy) ** 2;
        if (squared < best) {
          best = squared;
          const snapped = [a[0] + fraction * (b[0] - a[0]), a[1] + fraction * (b[1] - a[1])];
          found = { edgeIndex, fraction: total ? (accumulated + fraction * lengths[i - 1]) / total : 0, coordinate: snapped, distanceKm: haversine(coordinate, snapped) };
        }
        accumulated += lengths[i - 1];
      }
    }
  }
  if (!found) throw new Error('This dataset contains no valid road geometry.');
  return found;
}

function edgeArrivalPieces(data, result, i) {
  const duration = data.edges[i][3] / result.speedMultiplier;
  const a = result.forwardTimes[i], b = result.backwardTimes[i];
  const source = result.snap.edgeIndex === i;
  const f = result.snap.fraction;
  const direction = data.edges[i][6];
  const domains = source && f > 0 && f < 1 ? [[0, f], [f, 1]] : [[0, 1]];
  const pieces = [];
  for (const [lo, hi] of domains) {
    let ascending = a, descending = b + duration;
    if (source && lo >= f && direction >= 0) ascending = Math.min(ascending, -f * duration);
    if (source && hi <= f && direction <= 0) descending = Math.min(descending, f * duration);
    const arrival = (x) => Math.min(ascending + x * duration, descending - x * duration);
    const crossing = (descending - ascending) / (2 * duration);
    const cuts = Number.isFinite(crossing) && crossing > lo && crossing < hi ? [lo, crossing, hi] : [lo, hi];
    for (let j = 1; j < cuts.length; j++) {
      const x0 = cuts[j - 1], x1 = cuts[j];
      pieces.push({ x0, x1, t0: Math.max(0, arrival(x0)), t1: Math.max(0, arrival(x1)) });
    }
  }
  return pieces;
}

function buildReachabilityIndex(data, result) {
  const events = new Map();
  const touched = [], complete = [];
  let connectedKm = 0, maxMinutes = 0;
  const add = (t, delta) => events.set(t, (events.get(t) || 0) + delta);
  for (let i = 0; i < data.edges.length; i++) {
    let earliest = Infinity, latest = 0, allReachable = true;
    for (const piece of edgeArrivalPieces(data, result, i)) {
      const start = Math.min(piece.t0, piece.t1), end = Math.max(piece.t0, piece.t1);
      if (!Number.isFinite(end)) { allReachable = false; continue; }
      const length = (piece.x1 - piece.x0) * data.edges[i][2];
      connectedKm += length;
      earliest = Math.min(earliest, start); latest = Math.max(latest, end);
      maxMinutes = Math.max(maxMinutes, end);
      if (end > start) { const slope = length / (end - start); add(start, slope); add(end, -slope); }
    }
    if (Number.isFinite(earliest)) touched.push(earliest);
    if (allReachable) complete.push(latest);
  }
  const times = Float64Array.from(Array.from(events.keys()).sort((a, b) => a - b));
  const lengths = new Float64Array(times.length), slopes = new Float64Array(times.length);
  let length = 0, slope = 0, previous = 0;
  for (let i = 0; i < times.length; i++) {
    length += slope * (times[i] - previous);
    slope += events.get(times[i]);
    lengths[i] = Math.max(0, Math.min(connectedKm, length)); slopes[i] = Math.max(0, slope);
    previous = times[i];
  }
  if (times.length) { lengths[times.length - 1] = connectedKm; slopes[times.length - 1] = 0; }
  return { curveTimes: times, curveLengths: lengths, curveSlopes: slopes, touchedTimes: Float64Array.from(touched.sort((a, b) => a - b)), completeTimes: Float64Array.from(complete.sort((a, b) => a - b)), connectedKm, maxMinutes };
}

/** Compute full directed shortest-time paths from a virtual point on a road. */
export function route(graph, origin, { speedMultiplier = 1 } = {}) {
  if (!(speedMultiplier > 0) || !Number.isFinite(speedMultiplier)) throw new Error('Speed multiplier must be positive.');
  const key = `${origin?.[0]},${origin?.[1]}:${speedMultiplier}`;
  if (graph.cache.has(key)) {
    const cached = graph.cache.get(key);
    graph.cache.delete(key); graph.cache.set(key, cached);
    return { ...cached, cacheHit: true };
  }
  const snap = nearestRoad(graph, origin);
  const edge = graph.data.edges[snap.edgeIndex];
  const nodeTimes = new Float64Array(graph.data.nodes.length).fill(Infinity);
  const heap = new MinHeap();
  const seed = (node, cost) => { if (cost < nodeTimes[node]) { nodeTimes[node] = cost; heap.push(node, cost); } };
  // At an actual endpoint one may take any outgoing street, including when
  // the snapped edge itself leads into (rather than out of) that intersection.
  if (snap.fraction <= EPS) seed(edge[0], 0);
  if (snap.fraction >= 1 - EPS) seed(edge[1], 0);
  if (edge[6] <= 0) seed(edge[0], snap.fraction * edge[3] / speedMultiplier);
  if (edge[6] >= 0) seed(edge[1], (1 - snap.fraction) * edge[3] / speedMultiplier);
  while (heap.size) {
    const [node, time] = heap.pop();
    if (time > nodeTimes[node]) continue;
    for (let j = graph.offsets[node]; j < graph.offsets[node + 1]; j++) {
      const next = graph.destinations[j];
      const cost = time + graph.costs[j] / speedMultiplier;
      if (cost < nodeTimes[next]) { nodeTimes[next] = cost; heap.push(next, cost); }
    }
  }
  const forwardTimes = new Float64Array(graph.data.edges.length);
  const backwardTimes = new Float64Array(graph.data.edges.length);
  for (let i = 0; i < graph.data.edges.length; i++) {
    const e = graph.data.edges[i];
    forwardTimes[i] = e[6] >= 0 ? nodeTimes[e[0]] : Infinity;
    backwardTimes[i] = e[6] <= 0 ? nodeTimes[e[1]] : Infinity;
  }
  const result = { origin: origin.slice(), snap, nodeTimes, forwardTimes, backwardTimes, speedMultiplier, totalKm: graph.totalKm, cacheHit: false };
  Object.assign(result, buildReachabilityIndex(graph.data, result));
  if (graph.cacheSize > 0) {
    graph.cache.set(key, result);
    if (graph.cache.size > graph.cacheSize) graph.cache.delete(graph.cache.keys().next().value);
  }
  return result;
}

function upperBound(array, value) {
  let lo = 0, hi = array.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (array[mid] <= value) lo = mid + 1; else hi = mid; }
  return lo;
}

/** O(log N) exact length statistics, including partial and overlapping roads. */
export function calculateReachable(data, result, timeMinutes) {
  const time = Math.min(result.maxMinutes, Math.max(0, Number(timeMinutes) || 0));
  const i = upperBound(result.curveTimes, time) - 1;
  const lengthKm = i < 0 ? 0 : Math.max(0, Math.min(result.connectedKm, result.curveLengths[i] + result.curveSlopes[i] * (time - result.curveTimes[i])));
  const fullEdges = upperBound(result.completeTimes, time);
  const touchedEdges = upperBound(result.touchedTimes, time > 0 ? time - Number.EPSILON : -1);
  return { lengthKm, percent: result.totalKm ? lengthKm / result.totalKm * 100 : 0, fullEdges, partialEdges: Math.max(0, touchedEdges - fullEdges), reachableEdges: touchedEdges, totalKm: result.totalKm, connectedKm: result.connectedKm };
}

/** Fractions along one physical road that can actually be reached by time t. */
export function reachableIntervals(data, result, edgeIndex, timeMinutes) {
  if (timeMinutes < 0) return [];
  const edge = data.edges[edgeIndex];
  const duration = edge[3] / result.speedMultiplier;
  const intervals = [];
  const forward = (timeMinutes - result.forwardTimes[edgeIndex]) / duration;
  const backward = (timeMinutes - result.backwardTimes[edgeIndex]) / duration;
  if (forward > 0) intervals.push([0, Math.min(1, forward)]);
  if (backward > 0) intervals.push([Math.max(0, 1 - backward), 1]);
  if (result.snap.edgeIndex === edgeIndex && timeMinutes > 0) {
    const f = result.snap.fraction, d = timeMinutes / duration;
    const lo = edge[6] <= 0 ? Math.max(0, f - d) : f;
    const hi = edge[6] >= 0 ? Math.min(1, f + d) : f;
    if (hi > lo) intervals.push([lo, hi]);
  }
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + EPS) previous[1] = Math.max(previous[1], interval[1]);
    else merged.push(interval);
  }
  return merged;
}

/** Estimated arrival at a snapped destination, preserving one-way travel. */
export function arrivalAt(graph, result, coordinate) {
  const snap = nearestRoad(graph, coordinate);
  const edge = graph.data.edges[snap.edgeIndex];
  const duration = edge[3] / result.speedMultiplier;
  let minutes = Math.min(result.forwardTimes[snap.edgeIndex] + snap.fraction * duration, result.backwardTimes[snap.edgeIndex] + (1 - snap.fraction) * duration);
  if (snap.fraction <= EPS) minutes = Math.min(minutes, result.nodeTimes[edge[0]]);
  if (snap.fraction >= 1 - EPS) minutes = Math.min(minutes, result.nodeTimes[edge[1]]);
  if (snap.edgeIndex === result.snap.edgeIndex) {
    const delta = snap.fraction - result.snap.fraction;
    if (Math.abs(delta) <= EPS || (delta >= 0 && edge[6] >= 0) || (delta <= 0 && edge[6] <= 0)) minutes = Math.min(minutes, Math.abs(delta) * duration);
  }
  return { minutes, snap };
}

export const prepareGraph = buildGraph;

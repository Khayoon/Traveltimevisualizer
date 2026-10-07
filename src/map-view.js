import L from 'leaflet';
import { haversine, reachableIntervals } from './routing.js';

const PALETTE = ['#137f78', '#d45b40', '#b58a2f', '#547cb0', '#a87993'];
const TILE_REFERENCE_ZOOM = 8;
const REFERENCE_SCALE = 2 ** TILE_REFERENCE_ZOOM;
const ONTARIO_BOUNDS = [[41.65, -95.25], [56.92, -74.15]];
const GTA_BOUNDS = [[43.05, -80.25], [44.3, -78.5]];
const MAJOR_CITIES = new Set(['Toronto', 'Ottawa', 'Thunder Bay', 'Timmins', 'Kenora', 'Sault Ste. Marie']);
const REGIONAL_CITIES = new Set([...MAJOR_CITIES, 'Windsor', 'London', 'Hamilton', 'Kingston', 'Sudbury', 'North Bay', 'Kitchener', 'Peterborough']);
const osmClasses = ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service'];
let localContextPromise;

function loadLocalContext() {
  if (!localContextPromise) {
    const base = import.meta.env.BASE_URL || '/';
    const read = async (name) => {
      const response = await fetch(`${base}data/${name}`);
      if (!response.ok) throw new Error(`Local map context: HTTP ${response.status}`);
      return response.json();
    };
    localContextPromise = Promise.allSettled([read('ontario-boundary.geojson'), read('lakes.geojson')]).then(([boundary, lakes]) => ({
      boundary: boundary.status === 'fulfilled' ? boundary.value : null,
      lakes: lakes.status === 'fulfilled' ? lakes.value : null,
    }));
  }
  return localContextPromise;
}

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const coordinateOf = (city) => city?.coordinates || city?.coords || (Number.isFinite(city?.lon) ? [city.lon, city.lat] : null);
const classGroup = (name) => /motorway/.test(name) ? 0 : /^trunk/.test(name) ? 1 : /^primary/.test(name) ? 2 : /^secondary/.test(name) ? 3 : 4;

function project([lng, lat]) {
  const sin = Math.sin(Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180);
  return [256 * (lng / 360 + 0.5), 128 * (1 - Math.log((1 + sin) / (1 - sin)) / (2 * Math.PI))];
}

function geometryFor(data, edge) {
  const shape = (data.geometry || data.geometries || [])[edge[7]];
  return shape?.length > 1 ? shape : [data.nodes[edge[0]], data.nodes[edge[1]]];
}

function readableTime(value) {
  if (!Number.isFinite(value)) return 'Not connected to this origin';
  const minutes = Math.max(0, Math.round(value));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Leaflet handles navigation; two canvases render the actual routing graph. */
export function createMap(container, { onOrigin, onRoad, onViewChange } = {}) {
  const map = L.map(container, {
    zoomControl: false,
    attributionControl: true,
    minZoom: 3,
    maxZoom: 18,
    preferCanvas: true,
    zoomSnap: 0.25,
    zoomDelta: 0.75,
    worldCopyJump: false,
    maxBounds: [[37, -103], [61, -66]],
    maxBoundsViscosity: 0.6,
  });
  map.attributionControl.setPrefix(false);
  container.style.background = '#eff0e7';
  map.attributionControl.addAttribution('Roads &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · Context: <a href="https://www.naturalearthdata.com/">Natural Earth</a>');
  L.control.scale({ position: 'bottomright', imperial: false, maxWidth: 110 }).addTo(map);
  map.fitBounds(ONTARIO_BOUNDS, { padding: [28, 28] });

  const roadPane = map.createPane('driveRoads');
  roadPane.style.zIndex = '420';
  roadPane.style.pointerEvents = 'none';
  for (const [name, zIndex] of [['atlasLand', 300], ['atlasWater', 320], ['atlasBoundary', 380], ['atlasLabels', 410]]) {
    const pane = map.createPane(name);
    pane.style.zIndex = String(zIndex);
    pane.style.pointerEvents = 'none';
  }
  const baseCanvas = L.DomUtil.create('canvas', 'road-network-canvas', roadPane);
  const activeCanvas = L.DomUtil.create('canvas', 'road-network-canvas road-network-active', roadPane);
  for (const canvas of [baseCanvas, activeCanvas]) {
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
  }
  const baseContext = baseCanvas.getContext('2d', { alpha: true });
  const activeContext = activeCanvas.getContext('2d', { alpha: true });
  const cityLayer = L.layerGroup().addTo(map);
  const geographyLabels = L.layerGroup().addTo(map);
  let data = null, result = null, time = 0, mode = 'ontario';
  let shapes = [], spatialIndex = new Map(), visible = [], cities = [];
  let originMarker = null, originCoordinates = null, originName = '', boundary = null, land = null, lakes = null, context = null;
  let selectMode = false, destroyed = false, needsBase = true, frame = null;
  let lastPaint = 0, view = null, hoverTimer = 0;
  let tooltip = null, hoveredEdge = -1;
  const syncCleanups = [];

  function paintBoundary() {
    if (boundary) { map.removeLayer(boundary); boundary = null; }
    if (land) { map.removeLayer(land); land = null; }
    const geometry = data?.boundary || context?.boundary;
    if (!geometry) return;
    land = L.geoJSON(geometry, { pane: 'atlasLand', style: { stroke: false, fillColor: '#f8f7ee', fillOpacity: 0.76 }, interactive: false }).addTo(map);
    boundary = L.geoJSON(geometry, { pane: 'atlasBoundary', style: { color: '#849883', weight: 1.1, opacity: 0.65, fill: false, dashArray: '5 4' }, interactive: false }).addTo(map);
  }

  function refreshGeographyLabels() {
    geographyLabels.clearLayers();
    const zoom = map.getZoom();
    const label = (coordinates, name, kind = 'water') => {
      const isWater = kind === 'water';
      const html = `<span style="display:block;white-space:nowrap;text-align:center;transform:translate(-50%,-50%);font-family:Archivo,Arial,sans-serif;font-size:${isWater ? zoom >= 8 ? 12 : 10 : 13}px;font-weight:${isWater ? 400 : 500};font-style:${isWater ? 'italic' : 'normal'};letter-spacing:${isWater ? '1.1px' : '4px'};color:${isWater ? '#77978d' : '#9ba891'};text-shadow:0 1px 2px #f4f5ec90;">${escapeHTML(name)}</span>`;
      L.marker([coordinates[1], coordinates[0]], { pane: 'atlasLabels', icon: L.divIcon({ className: 'atlas-geography-label', iconSize: [0, 0], html }), interactive: false, keyboard: false }).addTo(geographyLabels);
    };
    if (mode === 'ontario' && zoom < 7) {
      label([-86.4, 51.25], 'ONTARIO', 'province');
      label([-75.8, 48.45], 'QUÉBEC', 'province');
      label([-85.55, 44.1], 'MICHIGAN', 'province');
    }
    const major = new Set(['Lake Ontario', 'Lake Erie', 'Lake Huron', 'Lake Superior', 'Lake Michigan']);
    const regional = new Set([...major, 'Lake Nipigon', 'Lake Simcoe', 'Lake Nipissing', 'Lake of the Woods']);
    for (const feature of context?.lakes?.features || []) {
      const name = feature.properties?.name;
      if (!name || !(zoom >= 7 ? regional : major).has(name)) continue;
      const bounds = L.geoJSON(feature).getBounds();
      const center = bounds.getCenter();
      label([center.lng, center.lat], name);
    }
  }

  loadLocalContext().then((loaded) => {
    if (destroyed) return;
    context = loaded;
    paintBoundary();
    if (loaded.lakes) lakes = L.geoJSON(loaded.lakes, { pane: 'atlasWater', style: { color: '#ccdcd3', weight: 0.6, opacity: 0.8, fillColor: '#deebe5', fillOpacity: 1 }, interactive: false }).addTo(map);
    container.dataset.basemapStatus = loaded.boundary && loaded.lakes ? 'local' : 'partial';
    refreshGeographyLabels();
  });

  function indexData() {
    shapes = new Array(data.edges.length);
    spatialIndex = new Map();
    const classes = data.classes || osmClasses;
    for (let index = 0; index < data.edges.length; index++) {
      const edge = data.edges[index];
      const coordinates = geometryFor(data, edge);
      const points = new Float64Array(coordinates.length * 2);
      const distances = new Float32Array(coordinates.length);
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, total = 0;
      for (let i = 0; i < coordinates.length; i++) {
        const [x, y] = project(coordinates[i]);
        points[i * 2] = x;
        points[i * 2 + 1] = y;
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        if (i) {
          total += haversine(coordinates[i - 1], coordinates[i]);
        }
        distances[i] = total;
      }
      if (total > 0) for (let i = 1; i < distances.length; i++) distances[i] /= total;
      else distances[distances.length - 1] = 1;
      const type = classes[edge[4]] || osmClasses[edge[4]] || 'unclassified';
      shapes[index] = { points, distances, minX, minY, maxX, maxY, group: classGroup(type), type };
      const startX = Math.floor(minX * REFERENCE_SCALE / 256);
      const endX = Math.floor(maxX * REFERENCE_SCALE / 256);
      const startY = Math.floor(minY * REFERENCE_SCALE / 256);
      const endY = Math.floor(maxY * REFERENCE_SCALE / 256);
      for (let x = startX; x <= endX; x++) for (let y = startY; y <= endY; y++) {
        const key = `${x}:${y}`;
        if (!spatialIndex.has(key)) spatialIndex.set(key, []);
        spatialIndex.get(key).push(index);
      }
    }
  }

  function updateView() {
    const size = map.getSize();
    if (!size.x || !size.y) return false;
    const scale = 2 ** map.getZoom();
    const topLeft = map.project(map.containerPointToLatLng([0, 0]), map.getZoom());
    view = { width: size.x, height: size.y, scale, x: topLeft.x, y: topLeft.y };
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const position = map.containerPointToLayerPoint([0, 0]);
    for (const canvas of [baseCanvas, activeCanvas]) {
      L.DomUtil.setPosition(canvas, position);
      const width = Math.round(size.x * ratio), height = Math.round(size.y * ratio);
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      canvas.style.width = `${size.x}px`; canvas.style.height = `${size.y}px`;
    }
    for (const ctx of [baseContext, activeContext]) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    }
    const padding = 8;
    const minX = (topLeft.x - padding) / scale, minY = (topLeft.y - padding) / scale;
    const maxX = (topLeft.x + size.x + padding) / scale, maxY = (topLeft.y + size.y + padding) / scale;
    const seen = new Set();
    visible = [];
    for (let x = Math.floor(minX * REFERENCE_SCALE / 256); x <= Math.floor(maxX * REFERENCE_SCALE / 256); x++) {
      for (let y = Math.floor(minY * REFERENCE_SCALE / 256); y <= Math.floor(maxY * REFERENCE_SCALE / 256); y++) {
        for (const index of spatialIndex.get(`${x}:${y}`) || []) {
          if (seen.has(index)) continue;
          seen.add(index);
          const shape = shapes[index];
          if (shape.maxX >= minX && shape.minX <= maxX && shape.maxY >= minY && shape.minY <= maxY) visible.push(index);
        }
      }
    }
    return true;
  }

  function traceFull(ctx, shape) {
    const p = shape.points, s = view.scale;
    ctx.moveTo(p[0] * s - view.x, p[1] * s - view.y);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * s - view.x, p[i + 1] * s - view.y);
  }

  function tracePartial(ctx, shape, start, end) {
    if (start <= 0 && end >= 1) { traceFull(ctx, shape); return; }
    const p = shape.points, cumulative = shape.distances, s = view.scale;
    let began = false;
    for (let i = 1; i < cumulative.length; i++) {
      const a = cumulative[i - 1], b = cumulative[i];
      if (b < start || a > end || b <= a) continue;
      const lo = Math.max(0, (start - a) / (b - a));
      const hi = Math.min(1, (end - a) / (b - a));
      if (hi <= lo) continue;
      const x = p[(i - 1) * 2], y = p[(i - 1) * 2 + 1];
      const dx = p[i * 2] - x, dy = p[i * 2 + 1] - y;
      if (!began) { ctx.moveTo((x + dx * lo) * s - view.x, (y + dy * lo) * s - view.y); began = true; }
      ctx.lineTo((x + dx * hi) * s - view.x, (y + dy * hi) * s - view.y);
      if (b >= end) break;
    }
  }

  function paint(timestamp) {
    frame = null;
    if (destroyed) return;
    if (!needsBase && timestamp - lastPaint < 48) { frame = requestAnimationFrame(paint); return; }
    lastPaint = timestamp;
    if (needsBase) {
      if (!updateView()) return;
      baseContext.clearRect(0, 0, view.width, view.height);
      const zoom = map.getZoom();
      for (let group = 4; group >= 0; group--) {
        baseContext.beginPath();
        baseContext.strokeStyle = group <= 1 ? '#acb3aa' : '#c4c7bd';
        baseContext.globalAlpha = group <= 1 ? 0.7 : 0.46;
        baseContext.lineWidth = Math.max(0.45, [1.35, 1.15, 0.9, 0.7, 0.5][group] + (zoom - 8) * 0.12);
        for (const index of visible) if (shapes[index].group === group) traceFull(baseContext, shapes[index]);
        baseContext.stroke();
      }
      baseContext.globalAlpha = 1;
      needsBase = false;
    }
    if (!view) return;
    activeContext.clearRect(0, 0, view.width, view.height);
    if (!result || !data) return;
    const zoom = map.getZoom();
    for (let group = 4; group >= 0; group--) {
      activeContext.beginPath();
      activeContext.strokeStyle = PALETTE[group];
      activeContext.globalAlpha = group === 4 ? 0.88 : 1;
      activeContext.lineWidth = Math.max(0.6, [2.15, 1.8, 1.4, 1.15, 0.8][group] + (zoom - 8) * 0.17);
      for (const index of visible) {
        const shape = shapes[index];
        if (shape.group !== group) continue;
        const entry = Math.min(result.forwardTimes[index], result.backwardTimes[index]);
        if (entry >= time && result.snap.edgeIndex !== index) continue;
        if (entry + data.edges[index][3] / result.speedMultiplier <= time) { traceFull(activeContext, shape); continue; }
        for (const [start, end] of reachableIntervals(data, result, index, time)) tracePartial(activeContext, shape, start, end);
      }
      activeContext.stroke();
    }
    activeContext.globalAlpha = 1;
  }

  function schedule(base = false) {
    needsBase ||= base;
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function refreshCities() {
    cityLayer.clearLayers();
    const zoom = map.getZoom();
    for (const city of cities) {
      const coordinates = coordinateOf(city);
      if (!coordinates) continue;
      if (zoom < 5.75 && !MAJOR_CITIES.has(city.name)) continue;
      if (zoom >= 5.75 && zoom < 8 && !REGIONAL_CITIES.has(city.name)) continue;
      const isOrigin = city.name === originName || (originCoordinates && Math.abs(coordinates[0] - originCoordinates[0]) < 0.008 && Math.abs(coordinates[1] - originCoordinates[1]) < 0.008);
      if (isOrigin) continue;
      const icon = L.divIcon({ className: 'atlas-city-marker', iconSize: [0, 0], iconAnchor: [0, 0], html: `<span style="position:absolute;width:4px;height:4px;margin:-2px;border-radius:50%;background:#687770;box-shadow:0 0 0 2px #f7f6efbd"></span><span style="position:absolute;left:7px;top:-8px;white-space:nowrap;font-family:Archivo,Arial,sans-serif;font-size:${zoom > 9 ? 11 : 10}px;line-height:16px;letter-spacing:.015em;color:#5b6a61;text-shadow:0 1px 2px #fff,0 -1px 2px #fff,1px 0 2px #fff;cursor:pointer">${escapeHTML(city.name)}</span>` });
      const marker = L.marker([coordinates[1], coordinates[0]], { icon, keyboard: true, title: `Start from ${city.name}`, zIndexOffset: -100 });
      marker.on('click', (event) => { L.DomEvent.stopPropagation(event); onOrigin?.(city); });
      marker.addTo(cityLayer);
    }
  }

  function nearestRoad(point, radius = 8) {
    if (!view || !data) return null;
    let nearest = null, best = radius * radius;
    const s = view.scale;
    for (const index of visible) {
      const shape = shapes[index];
      if (point.x < shape.minX * s - view.x - radius || point.x > shape.maxX * s - view.x + radius || point.y < shape.minY * s - view.y - radius || point.y > shape.maxY * s - view.y + radius) continue;
      const p = shape.points;
      for (let i = 2; i < p.length; i += 2) {
        const ax = p[i - 2] * s - view.x, ay = p[i - 1] * s - view.y;
        const bx = p[i] * s - view.x, by = p[i + 1] * s - view.y;
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / (dx * dx + dy * dy || 1)));
        const d = (point.x - ax - t * dx) ** 2 + (point.y - ay - t * dy) ** 2;
        if (d < best) { best = d; nearest = { index, fraction: shape.distances[i / 2 - 1] + t * (shape.distances[i / 2] - shape.distances[i / 2 - 1]) }; }
      }
    }
    return nearest;
  }

  function roadInfo(hit) {
    const edge = data.edges[hit.index], shape = shapes[hit.index];
    const names = data.names || data.roadNames || [];
    const forward = result?.forwardTimes;
    const backward = result?.backwardTimes;
    let arrival = Infinity;
    if (forward) {
      const duration = edge[3] / result.speedMultiplier;
      arrival = Math.min(forward[hit.index] + duration * hit.fraction, backward[hit.index] + duration * (1 - hit.fraction));
      if (result.snap.edgeIndex === hit.index) {
        const delta = hit.fraction - result.snap.fraction;
        if (delta === 0 || (delta >= 0 && edge[6] >= 0) || (delta <= 0 && edge[6] <= 0)) arrival = Math.min(arrival, Math.abs(delta) * duration);
      }
    }
    return { edgeIndex: hit.index, name: names[edge[5]] || 'Unnamed road', roadClass: shape.type.replaceAll('_', ' '), lengthKm: edge[2], travelMinutes: edge[3], speedKmh: edge[3] > 0 ? edge[2] / edge[3] * 60 : 0, arrivalMinutes: arrival, reachable: arrival <= time, oneway: edge[6] !== 0 };
  }

  function closeTooltip() {
    if (tooltip) map.closeTooltip(tooltip);
    tooltip = null;
    hoveredEdge = -1;
  }

  function showRoad(hit, latlng) {
    const info = roadInfo(hit);
    if (hoveredEdge === hit.index && tooltip) { tooltip.setLatLng(latlng); return info; }
    closeTooltip();
    const element = document.createElement('div');
    element.style.cssText = 'font:11px/1.6 Archivo,Arial,sans-serif;color:#34453b;min-width:130px;';
    element.innerHTML = `<strong style="font-size:12px">${escapeHTML(info.name)}</strong><br><span style="text-transform:capitalize">${escapeHTML(info.roadClass)}</span> · ${info.lengthKm.toFixed(1)} km<br><span style="font-family:monospace">${readableTime(info.arrivalMinutes)}</span> from origin`;
    tooltip = L.tooltip({ className: 'atlas-road-tooltip', direction: 'top', offset: [0, -8], opacity: 1 }).setLatLng(latlng).setContent(element).addTo(map);
    hoveredEdge = hit.index;
    return info;
  }

  map.on('mousemove', (event) => {
    if (selectMode || performance.now() - hoverTimer < 85) return;
    hoverTimer = performance.now();
    const hit = nearestRoad(event.containerPoint);
    if (hit) showRoad(hit, event.latlng); else closeTooltip();
  });
  map.on('mouseout', closeTooltip);
  map.on('click', (event) => {
    if (selectMode) { onOrigin?.({ name: 'Dropped pin', coordinates: [event.latlng.lng, event.latlng.lat], custom: true }); return; }
    const hit = nearestRoad(event.containerPoint, 12);
    if (hit) onRoad?.(showRoad(hit, event.latlng));
  });
  map.on('move zoom resize viewreset', () => schedule(true));
  map.on('zoomstart movestart', closeTooltip);
  map.on('zoomend', () => { refreshCities(); refreshGeographyLabels(); });
  map.on('moveend', () => onViewChange?.({ center: [map.getCenter().lng, map.getCenter().lat], zoom: map.getZoom() }));
  const resizeObserver = new ResizeObserver((entries) => {
    if (destroyed || !entries[0]?.contentRect.width || !entries[0]?.contentRect.height) return;
    map.invalidateSize({ animate: false, debounceMoveend: true });
    schedule(true);
  });
  resizeObserver.observe(container);

  const api = {
    _map: map,
    setData(next) {
      data = next; result = null;
      paintBoundary();
      if (data) indexData(); else { shapes = []; spatialIndex = new Map(); }
      closeTooltip(); schedule(true);
    },
    setRoute(next) { result = next; closeTooltip(); schedule(); },
    setTime(minutes) { time = Math.max(0, Number(minutes) || 0); schedule(); },
    setOrigin(coordinates, name = 'Origin') {
      originCoordinates = coordinates;
      originName = name;
      if (originMarker) map.removeLayer(originMarker);
      const icon = L.divIcon({ className: 'atlas-origin-marker', iconSize: [26, 26], iconAnchor: [13, 13], html: `<span style="position:absolute;inset:4px;border:2px solid #153f37;border-radius:50%;background:#f9f8f1;box-shadow:0 0 0 4px #faf9f0aa"></span><span style="position:absolute;left:12px;top:0;height:26px;width:1px;background:#153f37"></span><span style="position:absolute;top:12px;left:0;width:26px;height:1px;background:#153f37"></span><span style="position:absolute;left:10px;top:10px;width:6px;height:6px;background:#153f37;border-radius:50%"></span><span style="position:absolute;left:32px;top:4px;white-space:nowrap;font:600 11px/18px Archivo,Arial,sans-serif;color:#173c32;text-shadow:0 1px 3px #fff,0 -1px 3px #fff,1px 0 3px #fff;">${escapeHTML(name)}</span>` });
      originMarker = L.marker([coordinates[1], coordinates[0]], { icon, zIndexOffset: 1000, title: `Driving from ${name}` }).addTo(map);
      refreshCities();
    },
    setCities(next) { cities = next || []; refreshCities(); },
    setMode(next) { mode = next; refreshCities(); refreshGeographyLabels(); },
    fitRegion(next = mode) {
      mode = next;
      const bbox = data?.metadata?.bbox;
      const bounds = mode === 'gta' && bbox?.length === 4 ? [[bbox[1], bbox[0]], [bbox[3], bbox[2]]] : mode === 'gta' ? GTA_BOUNDS : ONTARIO_BOUNDS;
      map.fitBounds(bounds, { padding: [24, 28], animate: !window.matchMedia('(prefers-reduced-motion: reduce)').matches, duration: 0.65 });
    },
    zoomIn() { map.zoomIn(); },
    zoomOut() { map.zoomOut(); },
    resetView() { api.fitRegion(mode); },
    invalidateSize() { map.invalidateSize({ animate: false }); schedule(true); },
    setSelectMode(enabled) { selectMode = !!enabled; container.style.cursor = selectMode ? 'crosshair' : ''; container.classList.toggle('selecting-origin', selectMode); closeTooltip(); },
    syncWith(other) {
      if (!other?._map || other._map === map) return () => {};
      const target = other._map;
      let busy = false;
      const synchronize = (source, destination) => {
        if (busy || destroyed) return;
        const a = source.getCenter(), b = destination.getCenter();
        if (a.equals(b, 1e-7) && source.getZoom() === destination.getZoom()) return;
        busy = true;
        destination.setView(a, source.getZoom(), { animate: false });
        busy = false;
      };
      const forward = () => synchronize(map, target), backward = () => synchronize(target, map);
      map.on('move', forward); target.on('move', backward);
      forward();
      const cleanup = () => { map.off('move', forward); target.off('move', backward); };
      syncCleanups.push(cleanup);
      return cleanup;
    },
    destroy() { destroyed = true; resizeObserver.disconnect(); if (frame) cancelAnimationFrame(frame); for (const cleanup of syncCleanups) cleanup(); map.remove(); },
  };
  schedule(true);
  return api;
}

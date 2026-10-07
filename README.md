# Ontario Drive-Time Explorer

An interactive transportation atlas with real OpenStreetMap road geometry and shortest-time graph routing. The default view starts in Toronto at zero minutes. No API key is required.

## Run locally

Requires Node.js 22.12+.

```powershell
git clone https://github.com/Khayoon/Traveltimevisualizer.git
cd Traveltimevisualizer
npm install
npm run dev
```

On Windows, use `npm.cmd` in place of `npm` if PowerShell blocks npm's script shim. A portable Windows launcher is included as `Start-Explorer.cmd`.

```powershell
npm test
npm run build
npm run preview
```

## What is included

- Ontario: motorway, trunk, primary and secondary roads and their links across the province. **This is a major-road subset, not all Ontario roads.**
- GTA/Golden Horseshoe: a detailed regional extract with residential, living-street, unclassified, tertiary and major roads, within the documented bounding box. Parking aisles and service roads are omitted to keep the graph practical.
- Directed shortest-time routing in a worker, including one-way and reverse one-way roads, roundabouts, access filtering, numeric speed-limit tags and explicit class defaults.
- Origins snap to real road interiors. A virtual source permits partial travel in each legal direction from that position. The snap distance is visible; off-network access time is not included.
- Progressive segment illumination follows the driving time at every point. Reachable lengths are unions of intervals, so meeting road fronts never double-count distance.
- City arrivals use the same graph calculation. Disconnected roads remain unreachable, including in the percentage denominator.
- Province-wide time range derives from the furthest reachable point; GTA uses a granular 180-minute exploration window.
- Searchable municipalities, submitted address lookup, map origins, synchronized comparison, keyboard-accessible slider, play/pause, and shared URL state.
- Bundled fonts, boundary and lake geometry. No remote basemap or raster-tile service is required. Only address lookup uses an external service.

## Data and reproducibility

See `public/data/provenance.json`, `{mode}-metadata.json`, and `boundary-source.json` for extraction queries, timestamps, hashes, filtering and speed assumptions. Roads are © OpenStreetMap contributors, licensed ODbL 1.0. Natural Earth geographic context is public domain. The raw Overpass responses are cached locally in `.data-cache/` and excluded from Git. Published compressed graphs can be downloaded from the app.

The repository includes the exact compressed snapshots at `public/data/gta.json.gz` and `public/data/ontario.json.gz`. During `npm install`, the `prepare` script restores missing plain JSON copies for local data validation and routing benchmarks, without downloading data or replacing existing copies. These redundant plain JSON files are ignored by Git; the app loads the compressed snapshots directly. If install scripts were disabled, restore the copies manually with `npm run prepare`.

```powershell
npm run data
node scripts/fetch-context.mjs
```

The road downloader reuses raw cached responses; only explicitly refresh when a new snapshot is needed. The Overpass public service may be busy or rate-limited. Do not parallelize or repeatedly force-refresh large queries. `OVERPASS_ENDPOINT` can select an alternative endpoint. The script derives its workspace from its own absolute location, not the current shell directory.

## Architecture

`src/routing.js` is a renderer-independent directed graph engine: CSR adjacency, binary heap Dijkstra, spatial snapping index, origin LRU cache, and a sorted reachability event curve for logarithmic-time length queries. `src/routing.worker.js` loads compressed graphs and performs routing off the UI thread. The renderer in `src/map-view.js` uses Leaflet navigation with two custom Canvas layers, spatial culling, cached projected geometry, and progressive partial-edge drawing. It does not rebuild a large GeoJSON source on each animation frame.

`src/main.js` owns UI, comparison and URL state; `src/cities.js` contains municipality-centre coordinates, **not hardcoded travel times**. `src/style.css` provides the editorial desktop layout and the compact mobile control sheet. `scripts/fetch-data.mjs` prepares true junction topology while preserving original segment lengths and simplifying display geometry.

For a complete provincial all-road product, replace the major-road extract with a server-side routing graph built from a full Ontario PBF; serve zoom-dependent vector tiles keyed to precomputed per-edge costs. That extension is not represented as complete in this build. The current worker/cache architecture supports common and arbitrary origins on the included datasets without pretending the subset is complete.

## Model limitations

These are free-flow estimates, not navigation instructions. Traffic, signal delays, turn restrictions, conditional access, weather, seasonal closures and cross-border detours are not modelled. Numeric speed limits are used where present; directional speed tags are not. Missing limits use documented class assumptions. The graph cannot route outside its extraction boundary and re-enter. Separate OSM carriageways count separately in road length. A nearest mapped road may be disconnected from the origin, and the UI reports that honestly.

Address search uses the public Photon demo API only on explicit submission, throttled and cached per client. Public service availability is not guaranteed; replace this with a self-hosted Photon endpoint for large-scale deployment. City selection and map-origin selection work without it.

## Validation

`tests/routing.test.js` covers speed-weighted shortest paths, directed detours, disconnected components, partial source edges, reversed one-way travel, overlap unions, geometry-aware snapping, reachability curves, cache behaviour, and durations beyond eight hours. Worker tests cover recoverable data-loading failures. See `VALIDATION.md` for the real-data and browser checks performed for this build.

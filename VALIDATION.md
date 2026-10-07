# Validation — 6 October 2026

## Automated checks

- 14 routing and worker tests passed with `node --test tests/routing.test.js`.
- Data validation passed: graph indices, real geometry endpoints, positive edge lengths/costs, direction flags, access/class exclusions, source hashes, gzip round-trips, and summed denominator lengths.
- Vite production build passed. Production ships only compressed road graphs; the largest file is the 9,077,142-byte GTA graph.

## Real-data measurements

| Dataset | Road segments | Mapped km | Toronto maximum | First route |
| --- | ---: | ---: | ---: | ---: |
| Ontario major-road subset | 136,659 | 52,813.741 | 21h 51m | 867 ms |
| GTA detailed extract | 237,745 | 39,559.492 | 1h 38m | 1,058 ms |

Measurements are single local Node runs, not a hardware-independent performance guarantee. The GTA UI intentionally offers a 0–180 minute window. Reachability saturates earlier from central origins. Ontario derives its slider limit from the chosen origin, rounded up to the next hour.

On the final GTA graph, 10,000 indexed reachability calculations took 13 ms. Detailed local benchmark output is in the ignored `artifacts/route-benchmark.json`; reproduce with `node scripts/benchmark-routing.mjs gta` or `ontario`. Browser rendering and memory differ from Node measurements.

## Browser verification

Verified using the Codex in-app Chromium browser at desktop size and a 390 × 844 mobile viewport:

- True road illumination in Ontario and GTA; bundled boundaries/lakes render without external tile calls.
- Toronto at zero minutes gives zero reachable kilometres.
- Province time slider reaches 22 hours from Toronto and 24 hours from Ottawa, derived from routing.
- Play/pause advances and stops the same slider and metrics; keyboard Home returns to zero.
- Changing Toronto to Ottawa recalculates arrivals and road reachability.
- Toronto/Mississauga and Toronto/Hamilton comparison displays distinct reachable networks at the same threshold.
- Switching regions loads the correct graph and denominator.
- Known address submission returned Toronto City Hall through Photon and selected it as an origin.
- Arbitrary map-point selection moved the origin and recalculated routing, with its snap distance displayed.
- Share view copied a URL containing mode, minutes and custom-origin coordinates; direct URL loading restored comparison.
- Methodology dialog, graph downloads and data-provenance links are accessible on mobile.
- Mobile timeline visibility was corrected and visually rechecked.
- Production preview served the compressed-only build successfully, including both simultaneous comparison routes.

## Scope limits

Ontario coverage is explicitly a major-road subset. The GTA extract has a fixed regional boundary; service/parking roads are omitted. This is a free-flow network model, not live traffic or turn-restriction-aware navigation. No optional equal-time territory or fastest-origin destination feature is claimed. See README and dataset metadata for the complete assumptions.

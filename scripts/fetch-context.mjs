/** Download genuine Natural Earth map context. Public domain, 1:50m scale. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/data');
await fs.mkdir(output, { recursive: true });
const sourceBase = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/';
async function get(file) {
  const response = await fetch(sourceBase + file, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  return response.json();
}
const provinces = await get('ne_50m_admin_1_states_provinces.geojson');
const ontario = provinces.features.find(f => f.properties.name === 'Ontario');
if (!ontario) throw new Error('Ontario boundary not found in Natural Earth data.');
const source = { name: 'Natural Earth', url: 'https://www.naturalearthdata.com/', license: 'Public domain', scale: '1:50 million', retrievedAt: new Date().toISOString() };
await fs.writeFile(path.join(output, 'ontario-boundary.geojson'), JSON.stringify({ type: 'FeatureCollection', source, features: [ontario] }));
const lakes = await get('ne_50m_lakes.geojson');
function coordinates(c, points = []) {
  if (typeof c[0] === 'number') points.push(c);
  else for (const child of c) coordinates(child, points);
  return points;
}
const localLakes = lakes.features.filter(f => coordinates(f.geometry.coordinates).some(([lon, lat]) => lon >= -96 && lon <= -73 && lat >= 41 && lat <= 57));
await fs.writeFile(path.join(output, 'lakes.geojson'), JSON.stringify({ type: 'FeatureCollection', source, features: localLakes.map(f => ({ ...f, properties: { name: f.properties.name, scalerank: f.properties.scalerank } })) }));
console.log(`Saved Ontario boundary and ${localLakes.length} lake features.`);

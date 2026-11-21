'use strict';
/**
 * Builds a self-hosted basemap extract from OpenStreetMap through Overpass.
 *
 *   node scripts/build-basemap.js
 *   BBOX="38.60,8.80,39.05,9.15" OUT="backend/basemaps/addis-osm.json" node scripts/build-basemap.js
 *
 * The result is a GeoJSON file served from /basemaps on the app origin. No tile server, no API key
 * and no third-party request at runtime. Data © OpenStreetMap contributors, ODbL 1.0 — the map UI
 * displays the attribution and the file carries it in its metadata.
 *
 * The default extract is central Addis Ababa because the seeded SiteTrackerPro projects are there.
 * For another project area, change BBOX and rerun; a large extract is intentionally not committed.
 */

const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const BBOX = process.env.BBOX || '38.60,8.80,39.05,9.15';
const OUT = path.resolve(process.env.OUT || path.join(__dirname, '..', 'backend', 'basemaps', 'addis-osm.json'));
const ENDPOINTS = (process.env.OVERPASS_ENDPOINTS
  || 'https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter')
  .split(',').map(value => value.trim()).filter(Boolean);
const USER_AGENT = 'SiteTrackerPro-GIS/1.0 (basemap extract; contact: admin@example.com)';

if (!/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/.test(BBOX)) {
  console.error('BBOX must be west,south,east,north.');
  process.exit(1);
}

const query = `[out:json][timeout:180];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"](${BBOX});
  way["railway"~"^(rail|subway|light_rail)$"](${BBOX});
  way["natural"="water"](${BBOX});
  way["waterway"~"^(river|stream|canal)$"](${BBOX});
  way["leisure"~"^(park|garden|pitch|stadium|nature_reserve)$"](${BBOX});
  way["landuse"~"^(forest|grass|recreation_ground|cemetery|industrial|residential|commercial|farmland)$"](${BBOX});
  node["place"~"^(city|town|suburb|neighbourhood|village)$"](${BBOX});
);
out geom;`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchOverpass() {
  let lastError = null;
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const started = Date.now();
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': USER_AGENT,
            Accept: 'application/json'
          },
          body: new URLSearchParams({ data: query }).toString()
        });
        const text = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 180).replace(/\s+/g, ' ')}`);
        const payload = JSON.parse(text);
        if (!Array.isArray(payload.elements)) throw new Error('Overpass response has no elements array.');
        console.log(`Fetched ${payload.elements.length} elements from ${endpoint} in ${Date.now() - started} ms`);
        return payload;
      } catch (error) {
        lastError = error;
        console.warn(`Attempt ${attempt} on ${endpoint} failed: ${error.message}`);
        await sleep(attempt * 3000);
      }
    }
  }
  throw lastError || new Error('No Overpass endpoint answered.');
}

const round = value => Math.round(value * 1e5) / 1e5;

function ringFrom(geometry) {
  const ring = geometry
    .map(point => [round(point.lon), round(point.lat)])
    .filter((coordinate, index, all) => index === 0 || coordinate[0] !== all[index - 1][0] || coordinate[1] !== all[index - 1][1]);
  if (ring.length < 3) return null;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
  return ring.length >= 4 ? ring : null;
}

function lineFrom(geometry) {
  const line = geometry
    .map(point => [round(point.lon), round(point.lat)])
    .filter((coordinate, index, all) => index === 0 || coordinate[0] !== all[index - 1][0] || coordinate[1] !== all[index - 1][1]);
  return line.length >= 2 ? line : null;
}

function convert(payload) {
  const features = [];
  const places = [];
  const counts = {};

  for (const element of payload.elements) {
    const tags = element.tags || {};

    if (element.type === 'node' && tags.place) {
      places.push({
        lon: round(element.lon),
        lat: round(element.lat),
        name: tags['name:en'] || tags.name || tags.place,
        localName: tags.name || null,
        place: tags.place
      });
      continue;
    }

    if (element.type !== 'way' || !Array.isArray(element.geometry) || element.geometry.length < 2) continue;

    let kind = null;
    let klass = null;
    if (tags.highway) { kind = 'road'; klass = tags.highway; }
    else if (tags.railway) { kind = 'rail'; klass = tags.railway; }
    else if (tags.natural === 'water') { kind = 'water'; klass = 'water'; }
    else if (tags.waterway) { kind = 'waterway'; klass = tags.waterway; }
    else if (tags.leisure) { kind = 'park'; klass = tags.leisure; }
    else if (tags.landuse) { kind = 'landuse'; klass = tags.landuse; }
    if (!kind) continue;

    const closed = kind === 'water' || kind === 'park' || kind === 'landuse';
    const coordinates = closed ? ringFrom(element.geometry) : lineFrom(element.geometry);
    if (!coordinates) continue;

    const properties = { kind, class: klass };
    const name = tags['name:en'] || tags.name;
    if (name) properties.name = String(name).slice(0, 120);

    features.push({
      type: 'Feature',
      properties,
      geometry: closed
        ? { type: 'Polygon', coordinates: [coordinates] }
        : { type: 'LineString', coordinates }
    });
    counts[kind] = (counts[kind] || 0) + 1;
  }

  return {
    type: 'FeatureCollection',
    metadata: {
      name: `OpenStreetMap basemap extract (${BBOX})`,
      generatedAt: new Date().toISOString(),
      source: 'OpenStreetMap via Overpass API',
      licence: 'ODbL 1.0',
      attribution: '© OpenStreetMap contributors',
      bbox: BBOX.split(',').map(Number),
      counts,
      note: 'Context basemap only. Not a survey measurement and not authoritative for engineering work.'
    },
    features,
    places
  };
}

(async () => {
  const payload = await fetchOverpass();
  const collection = convert(payload);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(collection));
  // Pre-compress for the backend route that serves this file (12 MB -> ~1.8 MB on the wire).
  fs.writeFileSync(`${OUT}.gz`, zlib.gzipSync(JSON.stringify(collection), { level: 9 }));
  const size = fs.statSync(OUT).size;
  console.log(`Wrote ${OUT}`);
  console.log(`${collection.features.length} features, ${collection.places.length} places, ${(size / 1024 / 1024).toFixed(2)} MB`);
  console.log(JSON.stringify(collection.metadata.counts));
})().catch(error => {
  console.error('Basemap build failed:', error.message);
  process.exit(1);
});

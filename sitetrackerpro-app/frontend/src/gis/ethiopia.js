// ============================================================================
// Ethiopia national reference data.
//
// Boundaries: public/geo/ethiopia-regions.geojson, derived from geoBoundaries
// gbOpen ETH ADM1 (CC BY 4.0, Open Africa / Code for Ethiopia, 2016), simplified
// to ~600 m so it stays small. That release carries 11 ADM1 units, which are the
// operational units this product uses. Ethiopia has created further regions since
// 2023 (Central Ethiopia, South Ethiopia, South West Ethiopia Peoples' Region);
// those are not in this file and the panel says so.
//
// Places: a working gazetteer of Ethiopian towns used by map search and by the
// project coverage count. Coordinates are WGS 84 (EPSG:4326), which is what the
// map draws. Survey work in Ethiopia is commonly Adindan / UTM 37N
// (EPSG:20137); see the CRS list in the GIS workspace.
// ============================================================================

// South-west and north-east corners that contain the whole country.
export const ETHIOPIA_EXTENT = [[32.95, 3.35], [47.99, 14.92]];
export const ETHIOPIA_CENTER = [39.6, 9.15];

// Display names for the ADM1 names as published, with the capital and the
// approximate label position (WGS 84). `aliases` are what people actually type.
export const ETHIOPIA_REGIONS = [
  { name: 'Addis Ababa', label: 'Addis Ababa', capital: 'Addis Ababa', kind: 'Chartered city', center: [38.74, 9.03], aliases: ['addis', 'addis abeba', 'aa'] },
  { name: 'Dire Dawa', label: 'Dire Dawa', capital: 'Dire Dawa', kind: 'Chartered city', center: [41.87, 9.6], aliases: ['dire'] },
  { name: 'Afar', label: 'Afar', capital: 'Semera', kind: 'Regional state', center: [40.9, 11.75], aliases: ['afar regional state'] },
  { name: 'Amhara', label: 'Amhara', capital: 'Bahir Dar', kind: 'Regional state', center: [38.1, 11.6], aliases: [] },
  { name: 'Beneshangul Gumu', label: 'Benishangul-Gumuz', capital: 'Asosa', kind: 'Regional state', center: [35.0, 10.6], aliases: ['benishangul', 'benishangul gumuz', 'benshangul'] },
  { name: 'Gambela', label: 'Gambela', capital: 'Gambela', kind: 'Regional state', center: [34.3, 7.8], aliases: ['gambella'] },
  { name: 'Hareri', label: 'Harari', capital: 'Harar', kind: 'Regional state', center: [42.12, 9.31], aliases: ['harar', 'hareri'] },
  { name: 'Oromia', label: 'Oromia', capital: 'Adama', kind: 'Regional state', center: [38.6, 7.9], aliases: ['oromo'] },
  { name: 'SNNPR', label: 'SNNPR', capital: 'Hawassa', kind: 'Regional state', center: [37.4, 6.6], aliases: ['snnp', 'southern nations', 'south nations'] },
  { name: 'Somali', label: 'Somali', capital: 'Jigjiga', kind: 'Regional state', center: [44.3, 7.3], aliases: ['somali region', 'sumale'] },
  { name: 'Tigray', label: 'Tigray', capital: 'Mekelle', kind: 'Regional state', center: [39.0, 13.6], aliases: ['tigrai'] }
];

// Towns and cities used for search and coverage matching. Coordinates are the
// town centre, not a survey point.
export const ETHIOPIA_PLACES = [
  { name: 'Addis Ababa', region: 'Addis Ababa', lon: 38.7578, lat: 9.0192, kind: 'Capital city' },
  { name: 'Adama', region: 'Oromia', lon: 39.2695, lat: 8.541, kind: 'City' },
  { name: 'Bahir Dar', region: 'Amhara', lon: 37.3908, lat: 11.5936, kind: 'City' },
  { name: 'Hawassa', region: 'SNNPR', lon: 38.4763, lat: 7.0581, kind: 'City' },
  { name: 'Mekelle', region: 'Tigray', lon: 39.4753, lat: 13.4967, kind: 'City' },
  { name: 'Dire Dawa', region: 'Dire Dawa', lon: 41.8661, lat: 9.6009, kind: 'City' },
  { name: 'Gondar', region: 'Amhara', lon: 37.4667, lat: 12.6, kind: 'City' },
  { name: 'Jimma', region: 'Oromia', lon: 36.8344, lat: 7.6733, kind: 'City' },
  { name: 'Dessie', region: 'Amhara', lon: 39.6333, lat: 11.1333, kind: 'City' },
  { name: 'Jigjiga', region: 'Somali', lon: 42.8, lat: 9.35, kind: 'City' },
  { name: 'Shashamane', region: 'Oromia', lon: 38.2, lat: 7.2, kind: 'Town' },
  { name: 'Bishoftu', region: 'Oromia', lon: 38.9833, lat: 8.75, kind: 'Town' },
  { name: 'Harar', region: 'Hareri', lon: 42.1181, lat: 9.3117, kind: 'City' },
  { name: 'Arba Minch', region: 'SNNPR', lon: 37.55, lat: 6.0333, kind: 'City' },
  { name: 'Axum', region: 'Tigray', lon: 38.7167, lat: 14.1167, kind: 'Town' },
  { name: 'Lalibela', region: 'Amhara', lon: 38.9833, lat: 12.0333, kind: 'Town' },
  { name: 'Gambela', region: 'Gambela', lon: 34.5833, lat: 8.25, kind: 'City' },
  { name: 'Asosa', region: 'Beneshangul Gumu', lon: 34.5333, lat: 10.0667, kind: 'City' },
  { name: 'Semera', region: 'Afar', lon: 41.0, lat: 11.7833, kind: 'City' },
  { name: 'Debre Markos', region: 'Amhara', lon: 37.7333, lat: 10.3333, kind: 'Town' },
  { name: 'Nekemte', region: 'Oromia', lon: 36.5333, lat: 9.0833, kind: 'Town' },
  { name: 'Assela', region: 'Oromia', lon: 39.1333, lat: 7.95, kind: 'Town' },
  { name: 'Woldiya', region: 'Amhara', lon: 39.6, lat: 11.8333, kind: 'Town' },
  { name: 'Kombolcha', region: 'Amhara', lon: 39.7333, lat: 11.0833, kind: 'Town' },
  { name: 'Debre Birhan', region: 'Amhara', lon: 39.5333, lat: 9.6833, kind: 'Town' },
  { name: 'Ambo', region: 'Oromia', lon: 37.85, lat: 8.9833, kind: 'Town' },
  { name: 'Wolaita Sodo', region: 'SNNPR', lon: 37.7667, lat: 6.85, kind: 'Town' },
  { name: 'Dilla', region: 'SNNPR', lon: 38.3167, lat: 6.4167, kind: 'Town' },
  { name: 'Jinka', region: 'SNNPR', lon: 36.5667, lat: 5.7833, kind: 'Town' },
  { name: 'Mizan Teferi', region: 'SNNPR', lon: 35.5833, lat: 6.9833, kind: 'Town' },
  { name: 'Bale Robe', region: 'Oromia', lon: 40.0, lat: 7.1167, kind: 'Town' },
  { name: 'Gode', region: 'Somali', lon: 43.55, lat: 5.95, kind: 'Town' },
  { name: 'Kebri Dehar', region: 'Somali', lon: 44.2667, lat: 6.7333, kind: 'Town' },
  { name: 'Moyale', region: 'Oromia', lon: 39.05, lat: 3.5333, kind: 'Border town' },
  { name: 'Metema', region: 'Amhara', lon: 36.2, lat: 12.9667, kind: 'Border town' },
  { name: 'Dembi Dolo', region: 'Oromia', lon: 34.8, lat: 8.5333, kind: 'Town' },
  { name: 'Humera', region: 'Tigray', lon: 36.6167, lat: 14.3, kind: 'Town' },
  { name: 'Shire', region: 'Tigray', lon: 38.2833, lat: 14.1, kind: 'Town' },
  { name: 'Adigrat', region: 'Tigray', lon: 39.4667, lat: 14.2833, kind: 'Town' },
  { name: 'Yirgalem', region: 'SNNPR', lon: 38.4167, lat: 6.75, kind: 'Town' },
  { name: 'Butajira', region: 'SNNPR', lon: 38.3667, lat: 8.1167, kind: 'Town' },
  { name: 'Hosaena', region: 'SNNPR', lon: 37.85, lat: 7.55, kind: 'Town' },
  { name: 'Durame', region: 'SNNPR', lon: 37.9167, lat: 7.2333, kind: 'Town' },
  { name: 'Sawla', region: 'SNNPR', lon: 36.8833, lat: 6.3, kind: 'Town' },
  { name: 'Debre Tabor', region: 'Amhara', lon: 38.0167, lat: 11.85, kind: 'Town' },
  { name: 'Finote Selam', region: 'Amhara', lon: 37.2667, lat: 10.7, kind: 'Town' },
  { name: 'Mille', region: 'Afar', lon: 40.0167, lat: 11.4167, kind: 'Town' },
  { name: 'Gewane', region: 'Afar', lon: 40.65, lat: 10.1667, kind: 'Town' }
];

const NORMALISE = (value) => String(value || '')
  .toLowerCase()
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function regionMeta(name) {
  return ETHIOPIA_REGIONS.find(region => region.name === name) || null;
}

export function regionLabel(name) {
  return regionMeta(name)?.label || name;
}

// Which region does a free-text location belong to? Places win over region names
// so "Adama" lands in Oromia even though Adama is also the Oromia capital, and
// "Harar" lands in Harari rather than being read as the region alias.
export function regionForText(text) {
  const value = NORMALISE(text);
  if (!value) return '';

  const place = ETHIOPIA_PLACES
    .map(entry => ({ entry, key: NORMALISE(entry.name) }))
    .filter(({ key }) => key && (value === key || value.includes(key) || key.includes(value)))
    // Longer names first: "Arba Minch" before "Arba".
    .sort((a, b) => b.key.length - a.key.length)[0];
  if (place) return place.entry.region;

  const region = ETHIOPIA_REGIONS.find(entry => {
    const names = [entry.name, entry.label, entry.capital, ...(entry.aliases || [])].map(NORMALISE);
    return names.some(name => name && (value === name || value.includes(name)));
  });
  return region ? region.name : '';
}

export function regionForProject(project) {
  return regionForText(project?.location) || regionForText(project?.name);
}

// One pass over the portfolio: counts per region plus the projects that could not
// be placed. Used for the map shading and the coverage list.
export function coverageByRegion(projects = []) {
  const counts = Object.fromEntries(ETHIOPIA_REGIONS.map(region => [region.name, 0]));
  const byRegion = Object.fromEntries(ETHIOPIA_REGIONS.map(region => [region.name, []]));
  const unplaced = [];

  projects.forEach(project => {
    const region = regionForProject(project);
    if (region && counts[region] !== undefined) {
      counts[region] += 1;
      byRegion[region].push(project);
    } else {
      unplaced.push(project);
    }
  });

  const placed = projects.length - unplaced.length;
  const coveredRegions = ETHIOPIA_REGIONS.filter(region => counts[region.name] > 0).length;

  return { counts, byRegion, unplaced, placed, coveredRegions, total: projects.length };
}

// Step ramp for the choropleth. Colours stay in the copper/teal family used by
// the rest of the product and remain readable under the dark basemaps.
export const COVERAGE_RAMP = ['#eef2f5', '#a9cfe0', '#6fb0cd', '#3d87aa', '#1f5c7a'];

export function coverageColour(count) {
  if (!count) return COVERAGE_RAMP[0];
  if (count >= 6) return COVERAGE_RAMP[4];
  if (count >= 3) return COVERAGE_RAMP[3];
  if (count >= 2) return COVERAGE_RAMP[2];
  return COVERAGE_RAMP[1];
}

// Search places and regions in one list for the panel.
export function searchEthiopia(query, limit = 8) {
  const term = NORMALISE(query);
  if (!term) return [];

  const places = ETHIOPIA_PLACES
    .filter(place => NORMALISE(place.name).includes(term))
    .map(place => ({
      kind: 'place',
      id: `place:${place.name}`,
      name: place.name,
      region: place.region,
      detail: `${place.kind} · ${regionLabel(place.region)}`,
      center: [place.lon, place.lat],
      zoom: 11
    }));

  const regions = ETHIOPIA_REGIONS
    .filter(region => [region.name, region.label, region.capital, ...(region.aliases || [])]
      .some(name => NORMALISE(name).includes(term)))
    .map(region => ({
      kind: 'region',
      id: `region:${region.name}`,
      name: region.label,
      region: region.name,
      detail: `${region.kind} · capital ${region.capital}`,
      center: region.center,
      zoom: 7
    }));

  return [...places, ...regions].slice(0, limit);
}

import React, { useMemo } from 'react';
import proj4 from 'proj4';

const WGS84 = '+proj=longlat +datum=WGS84 +no_defs';

// UTM zone for a longitude: Ethiopia spans 37N (36°–42°E) and 38N (42°–48°E).
function utmFor(lng) {
  const zone = Math.floor((lng + 180) / 6) + 1;
  return {
    zone,
    code: `EPSG:326${String(zone).padStart(2, '0')}`,
    def: `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`
  };
}

// Ground resolution in metres per screen pixel at the current zoom and latitude.
function scaleMetresPerPixel(zoom, lat) {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
}

export default function StatusBar({ cursor, zoom, elevation, workingCrs, layers = 0, projectName, theme }) {
  const utm = useMemo(() => (cursor ? utmFor(cursor.lng) : null), [cursor]);

  const easting = useMemo(() => {
    if (!cursor || !utm) return null;
    try {
      const [x, y] = proj4(WGS84, utm.def, [cursor.lng, cursor.lat]);
      return { x, y };
    } catch (err) {
      return null;
    }
  }, [cursor, utm]);

  const ratio = cursor ? scaleMetresPerPixel(zoom, cursor.lat) : null;
  const scaleLabel = ratio
    ? ratio >= 1000 ? `1:${Math.round((ratio * 96) / 0.0254).toLocaleString()}` : `${ratio.toFixed(2)} m/px`
    : '—';

  return (
    <footer className="telemetry" aria-label="Map telemetry">
      <span className="tel-item tel-brand"><span className="tel-dot" />{projectName || 'No project'}</span>
      <span className="tel-item">
        <span className="tel-key">LAT</span>
        {cursor ? cursor.lat.toFixed(6) : '—'}
      </span>
      <span className="tel-item">
        <span className="tel-key">LNG</span>
        {cursor ? cursor.lng.toFixed(6) : '—'}
      </span>
      <span className="tel-item tel-utm">
        <span className="tel-key">{utm ? `${utm.zone}N E` : 'E'}</span>
        {easting ? easting.x.toFixed(2) : '—'}
      </span>
      <span className="tel-item tel-utm">
        <span className="tel-key">{utm ? `${utm.zone}N N` : 'N'}</span>
        {easting ? easting.y.toFixed(2) : '—'}
      </span>
      <span className="tel-item">
        <span className="tel-key">ELEV</span>
        {Number.isFinite(elevation) ? `${elevation.toFixed(1)} m` : '—'}
      </span>
      <span className="tel-item">
        <span className="tel-key">ZOOM</span>
        {zoom.toFixed(2)}
      </span>
      <span className="tel-item">
        <span className="tel-key">SCALE</span>
        {scaleLabel}
      </span>
      <span className="tel-item">
        <span className="tel-key">LAYERS</span>
        {layers}
      </span>
      <span className="tel-item tel-spacer" />
      <span className="tel-item tel-theme">{theme === 'light' ? 'Light GIS' : 'Dark GIS'}</span>
      <span className="tel-badge" title="Working coordinate reference system">{workingCrs || 'EPSG:4326'}</span>
    </footer>
  );
}

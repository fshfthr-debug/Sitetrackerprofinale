import React from 'react';

const PAPER_ASPECTS = { A4: 297 / 210, A3: 420 / 297, Letter: 11 / 8.5 };

export function niceDistance(metres) {
  if (!Number.isFinite(metres) || metres <= 0) return 100;
  const exponent = Math.floor(Math.log10(metres));
  const base = Math.pow(10, exponent);
  const fraction = metres / base;
  const nice = fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1;
  return nice * base;
}

export function formatDistance(metres) {
  if (metres >= 1000) {
    const km = metres / 1000;
    return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
  }
  return `${Math.round(metres)} m`;
}

function LegendItem({ item }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px', breakInside: 'avoid' }}>
      <span
        style={{
          width: '18px', height: '11px', borderRadius: item.round ? '50%' : '2px',
          background: item.gradient
            ? 'linear-gradient(90deg, #f6f1e7, #cdbfa4, #7a6a50)'
            : item.color,
          border: '1px solid rgba(0,0,0,0.25)',
          flex: '0 0 auto'
        }}
      />
      <span style={{ fontSize: '10px', lineHeight: 1.2 }}>{item.label}</span>
    </div>
  );
}

function NorthArrow({ bearing }) {
  return (
    <div
      style={{
        position: 'absolute', top: '14px', right: '14px', width: '58px', height: '58px',
        borderRadius: '50%', background: 'rgba(255,255,255,0.94)', border: '1px solid rgba(0,0,0,0.25)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: '0 2px 8px rgba(0,0,0,0.22)'
      }}
      aria-label="North arrow"
    >
      <svg viewBox="0 0 60 70" width="44" height="50" style={{ transform: `rotate(${-bearing}deg)` }}>
        <polygon points="30,5 39,42 30,36 21,42" fill="#1d2730" />
        <polygon points="30,5 30,36 21,42" fill="#59636c" />
        <text x="30" y="59" textAnchor="middle" fontSize="13" fontWeight="700" fill="#1d2730">N</text>
      </svg>
    </div>
  );
}

export default function MapPrintLayout({ snapshot, settings, setSettings, onClose, project }) {
  if (!snapshot) return null;
  const paperAspect = PAPER_ASPECTS[settings.paper] || PAPER_ASPECTS.A4;
  const sheetAspect = settings.orientation === 'portrait' ? 1 / paperAspect : paperAspect;
  const imageAspect = snapshot.width / snapshot.height;
  // The captured map is drawn with object-fit: cover, so the bar keeps its map length when the
  // sheet crops the sides. percent is measured against the captured image width.
  const barWidth = Math.min(86, Math.max(8, snapshot.scale.percent * (imageAspect > sheetAspect ? imageAspect / sheetAspect : 1)));
  const legend = snapshot.legend || [];
  const subtitle = settings.subtitle || `${project ? `${project.name} · ` : ''}${snapshot.workspaceName} · ${snapshot.crs}`;

  const printCss = `
    @page { size: ${settings.paper} ${settings.orientation}; margin: 0; }
    @media print {
      body * { visibility: hidden !important; }
      #gis-print-sheet, #gis-print-sheet * { visibility: visible !important; }
      #gis-print-sheet {
        position: fixed !important; inset: 0 !important; width: 100vw !important;
        height: 100vh !important; aspect-ratio: auto !important; border-radius: 0 !important;
      }
      .gis-print-controls { display: none !important; }
    }
  `;

  return (
    <div
      className="gis-print-overlay"
      style={{
        position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(24,29,35,0.78)',
        overflow: 'auto', padding: '18px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignItems: 'center'
      }}
      role="dialog"
      aria-label="Printable map layout"
    >
      <style>{printCss}</style>
      <div className="gis-print-controls" style={{ width: 'min(1080px, 100%)' }}>
        <div style={{ background: '#f4f7fa', borderRadius: '10px', padding: '16px', marginBottom: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0 }}>Print layout</h3>
              <p style={{ margin: '4px 0 0', color: '#5b6773', fontSize: '13px' }}>
                Captures the current map view. The scale bar is calculated from that view.
              </p>
            </div>
            <button onClick={onClose} style={{ padding: '8px 12px', border: '1px solid #ccd6df', background: 'white', borderRadius: '5px', cursor: 'pointer' }}>Close</button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', marginTop: '12px' }}>
            <label style={{ fontSize: '12px', color: '#425466' }}>
              Title
              <input
                id="gis-print-title"
                value={settings.title}
                onChange={event => setSettings(current => ({ ...current, title: event.target.value }))}
                style={{ display: 'block', width: '100%', padding: '7px 8px', marginTop: '3px', border: '1px solid #ccd6df', borderRadius: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: '#425466' }}>
              Subtitle
              <input
                id="gis-print-subtitle"
                value={settings.subtitle}
                placeholder={subtitle}
                onChange={event => setSettings(current => ({ ...current, subtitle: event.target.value }))}
                style={{ display: 'block', width: '100%', padding: '7px 8px', marginTop: '3px', border: '1px solid #ccd6df', borderRadius: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: '#425466' }}>
              Paper
              <select
                id="gis-print-paper"
                value={settings.paper}
                onChange={event => setSettings(current => ({ ...current, paper: event.target.value }))}
                style={{ display: 'block', width: '100%', padding: '7px 8px', marginTop: '3px', border: '1px solid #ccd6df', borderRadius: '4px' }}
              >
                <option value="A4">A4</option>
                <option value="A3">A3</option>
                <option value="Letter">Letter</option>
              </select>
            </label>
            <label style={{ fontSize: '12px', color: '#425466' }}>
              Orientation
              <select
                id="gis-print-orientation"
                value={settings.orientation}
                onChange={event => setSettings(current => ({ ...current, orientation: event.target.value }))}
                style={{ display: 'block', width: '100%', padding: '7px 8px', marginTop: '3px', border: '1px solid #ccd6df', borderRadius: '4px' }}
              >
                <option value="landscape">Landscape</option>
                <option value="portrait">Portrait</option>
              </select>
            </label>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '14px', marginTop: '10px', fontSize: '13px' }}>
            {[['legend', 'Legend'], ['scaleBar', 'Scale bar'], ['northArrow', 'North arrow'], ['attribution', 'Attribution']].map(([key, label]) => (
              <label key={key} style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                <input
                  id={`gis-print-${key}`}
                  type="checkbox"
                  checked={settings[key]}
                  onChange={event => setSettings(current => ({ ...current, [key]: event.target.checked }))}
                />
                {label}
              </label>
            ))}
            <button
              id="gis-print-run"
              onClick={() => window.print()}
              style={{ marginLeft: 'auto', padding: '9px 16px', background: '#FF6B35', color: 'white', border: 'none', borderRadius: '5px', cursor: 'pointer', fontWeight: 700 }}
            >
              Print / save as PDF
            </button>
          </div>
        </div>
      </div>

      <div
        id="gis-print-sheet"
        data-paper={settings.paper}
        data-orientation={settings.orientation}
        style={{
          position: 'relative', width: 'min(1080px, 100%)', aspectRatio: String(sheetAspect),
          background: '#ffffff', overflow: 'hidden', boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
          flex: '0 0 auto'
        }}
      >
        <img
          src={snapshot.image}
          alt="Current map view"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />

        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, padding: '4.2% 12% 3% 4%', background: 'linear-gradient(180deg, rgba(20,26,32,0.82), rgba(20,26,32,0.48) 70%, rgba(20,26,32,0))', color: 'white' }}>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: '26px', fontWeight: 700, lineHeight: 1.15 }}>
            {settings.title || snapshot.workspaceName}
          </div>
          <div style={{ fontSize: '12px', marginTop: '5px', opacity: 0.92 }}>{subtitle}</div>
        </div>

        {settings.northArrow && <NorthArrow bearing={snapshot.bearing || 0} />}

        {settings.legend && legend.length > 0 && (
          <div style={{ position: 'absolute', right: '3.5%', bottom: '4.5%', width: legend.length > 7 ? '50%' : '29%', maxWidth: legend.length > 7 ? '430px' : '260px', maxHeight: '68%', overflow: 'hidden', background: 'rgba(255,255,255,0.94)', border: '1px solid rgba(0,0,0,0.22)', borderRadius: '3px', padding: '7px 9px' }}>
            <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', borderBottom: '1px solid #d8dde2', paddingBottom: '3px', marginBottom: '2px' }}>Legend</div>
            <div style={{ display: 'grid', gridTemplateColumns: legend.length > 7 ? '1fr 1fr' : '1fr', columnGap: '12px' }}>
              {legend.map((item, index) => <LegendItem key={`${item.label}-${index}`} item={item} />)}
            </div>
          </div>
        )}

        {settings.scaleBar && (
          <div style={{ position: 'absolute', left: '3.5%', bottom: '3.5%', background: 'rgba(255,255,255,0.9)', padding: '6px 8px', borderRadius: '3px', border: '1px solid rgba(0,0,0,0.2)' }} aria-label="Scale bar">
            <div style={{ width: `${barWidth}%`, minWidth: '70px', display: 'flex', border: '1px solid #1d2730', height: '8px' }}>
              <div style={{ flex: 1, background: '#1d2730' }} />
              <div style={{ flex: 1, background: '#ffffff' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginTop: '2px', fontFamily: 'Consolas, monospace' }}>
              <span>0</span>
              <span>{snapshot.scale.label}</span>
            </div>
          </div>
        )}

        {settings.attribution && (
          <div style={{ position: 'absolute', right: 0, left: 0, bottom: 0, padding: '2px 5px', fontSize: '8px', color: '#ffffff', background: 'rgba(20,26,32,0.55)', textAlign: 'center' }}>
            © OpenStreetMap contributors · SiteTrackerPro GIS · Coordinates EPSG:4326 / displayed EPSG:3857
          </div>
        )}
      </div>
    </div>
  );
}

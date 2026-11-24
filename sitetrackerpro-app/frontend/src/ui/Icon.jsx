import React from 'react';

// One geometry set for the whole product. 1.7px strokes, rounded joins and no
// decorative fills keep the iconography quiet next to the data.
const ICONS = {
  overview: [
    ['rect', { x: 3, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 14, y: 3, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 3, y: 14, width: 7, height: 7, rx: 1.5 }],
    ['rect', { x: 14, y: 14, width: 7, height: 7, rx: 1.5 }]
  ],
  projects: [
    ['path', { d: 'M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2h7.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z' }]
  ],
  map: [
    ['path', { d: 'm9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3Z' }],
    ['path', { d: 'M9 3v15M15 6v15' }]
  ],
  cube: [
    ['path', { d: 'm12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z' }],
    ['path', { d: 'm4 7.5 8 4.5 8-4.5M12 12v9' }]
  ],
  compass: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'm15.8 8.2-2.2 5.4-5.4 2.2 2.2-5.4 5.4-2.2Z' }]
  ],
  clipboard: [
    ['path', { d: 'M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3' }],
    ['rect', { x: 9, y: 3, width: 6, height: 4, rx: 1 }],
    ['path', { d: 'M8 12h8M8 16h5' }]
  ],
  calculator: [
    ['rect', { x: 4, y: 2.5, width: 16, height: 19, rx: 2 }],
    ['path', { d: 'M8 6.5h8M8 11h.01M12 11h.01M16 11h.01M8 15h.01M12 15h.01M16 15v4M8 19h4' }]
  ],
  receipt: [
    ['path', { d: 'M6 3h12v18l-3-2-3 2-3-2-3 2V3Z' }],
    ['path', { d: 'M9 8h6M9 12h6M9 16h3' }]
  ],
  box: [
    ['path', { d: 'M3 8.2 12 3l9 5.2v7.6L12 21l-9-5.2z' }],
    ['path', { d: 'm3 8.2 9 5.2 9-5.2M12 13.4V21' }]
  ],
  chart: [
    ['path', { d: 'M4 20V10M10 20V4M16 20v-7M22 20H2' }]
  ],
  shield: [
    ['path', { d: 'M12 3 5 6v5c0 4.6 2.9 8 7 10 4.1-2 7-5.4 7-10V6l-7-3Z' }],
    ['path', { d: 'm9 12 2 2 4-4' }]
  ],
  key: [
    ['circle', { cx: 8, cy: 8, r: 4 }],
    ['path', { d: 'm11 11 9 9M16 16l2-2M19 19l2-2' }]
  ],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  minus: [['path', { d: 'M5 12h14' }]],
  search: [
    ['circle', { cx: 11, cy: 11, r: 7 }],
    ['path', { d: 'm20 20-4-4' }]
  ],
  sparkles: [
    ['path', { d: 'm12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z' }],
    ['path', { d: 'm18.5 15 .8 2.7L22 18.5l-2.7.8-.8 2.7-.8-2.7-2.7-.8 2.7-.8.8-2.7Z' }]
  ],
  bell: [
    ['path', { d: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9' }],
    ['path', { d: 'M10 21h4' }]
  ],
  menu: [['path', { d: 'M4 7h16M4 12h16M4 17h16' }]],
  x: [['path', { d: 'm6 6 12 12M18 6 6 18' }]],
  chevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
  chevronRight: [['path', { d: 'm9 6 6 6-6 6' }]],
  chevronLeft: [['path', { d: 'm15 6-6 6 6 6' }]],
  arrowRight: [['path', { d: 'M4 12h16m-6-6 6 6-6 6' }]],
  arrowUpRight: [['path', { d: 'M7 17 17 7M8 7h9v9' }]],
  layers: [
    ['path', { d: 'm12 3 9 5-9 5-9-5 9-5Z' }],
    ['path', { d: 'm3 12 9 5 9-5M3 16l9 5 9-5' }]
  ],
  alert: [
    ['path', { d: 'M10.3 4.2 2.8 17.1A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.9L13.7 4.2a2 2 0 0 0-3.4 0Z' }],
    ['path', { d: 'M12 9v4M12 17h.01' }]
  ],
  check: [['path', { d: 'm5 12 4.2 4.2L19 6.5' }]],
  checkCircle: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'm8 12 2.6 2.6L16.5 8.8' }]
  ],
  clock: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M12 7v5l3 2' }]
  ],
  settings: [
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z' }]
  ],
  logout: [
    ['path', { d: 'M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5' }],
    ['path', { d: 'M15 8l4 4-4 4M19 12H9' }]
  ],
  user: [
    ['circle', { cx: 12, cy: 8, r: 4 }],
    ['path', { d: 'M4 21a8 8 0 0 1 16 0' }]
  ],
  upload: [
    ['path', { d: 'M12 16V4m-5 5 5-5 5 5' }],
    ['path', { d: 'M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3' }]
  ],
  download: [
    ['path', { d: 'M12 4v12m-5-5 5 5 5-5' }],
    ['path', { d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }]
  ],
  building: [
    ['path', { d: 'M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16' }],
    ['path', { d: 'M16 9h2a2 2 0 0 1 2 2v10M2 21h20' }],
    ['path', { d: 'M8 7h4M8 11h4M8 15h4' }]
  ],
  satellite: [
    ['path', { d: 'm13 4 7 7-3 3-7-7 3-3ZM7 10l7 7-3 3-7-7 3-3Z' }],
    ['path', { d: 'm10 13-3 3M4 20h.01' }]
  ],
  mapPin: [
    ['path', { d: 'M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z' }],
    ['circle', { cx: 12, cy: 10, r: 2.5 }]
  ],
  file: [
    ['path', { d: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z' }],
    ['path', { d: 'M14 3v6h6M8 13h8M8 17h5' }]
  ],
  camera: [
    ['path', { d: 'M4 7h3l1.5-2h7L17 7h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z' }],
    ['circle', { cx: 12, cy: 13, r: 3.5 }]
  ],
  wifi: [
    ['path', { d: 'M2.5 9a15 15 0 0 1 19 0M5.5 12.5a10 10 0 0 1 13 0M8.5 16a5 5 0 0 1 7 0' }],
    ['path', { d: 'M12 20h.01' }]
  ],
  activity: [['path', { d: 'M3 12h4l2.5-7 4 14 2.5-7h5' }]],
  database: [
    ['ellipse', { cx: 12, cy: 5, rx: 8, ry: 3 }],
    ['path', { d: 'M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6' }]
  ],
  locate: [
    ['circle', { cx: 12, cy: 12, r: 7 }],
    ['path', { d: 'M12 2v4M12 18v4M2 12h4M18 12h4' }],
    ['circle', { cx: 12, cy: 12, r: 2 }]
  ],
  refresh: [
    ['path', { d: 'M20 7v5h-5M4 17v-5h5' }],
    ['path', { d: 'M6.1 8A7 7 0 0 1 19 12M4.9 16A7 7 0 0 0 17.9 16' }]
  ],
  maximize: [
    ['path', { d: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5' }]
  ],
  panel: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
    ['path', { d: 'M15 4v16' }]
  ],
  command: [
    ['path', { d: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6Z' }]
  ],
  route: [
    ['circle', { cx: 6, cy: 19, r: 2 }],
    ['circle', { cx: 18, cy: 5, r: 2 }],
    ['path', { d: 'M8 19h6a4 4 0 0 0 0-8H9a3 3 0 0 1 0-6h7' }]
  ],
  help: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M9.6 9.3a2.5 2.5 0 1 1 3.7 2.3c-.8.5-1.3 1.1-1.3 2v.3' }],
    ['path', { d: 'M12 17h.01' }]
  ],
  globe: [
    ['circle', { cx: 12, cy: 12, r: 9 }],
    ['path', { d: 'M3 12h18' }],
    ['path', { d: 'M12 3c2.5 2.6 3.9 5.6 3.9 9s-1.4 6.4-3.9 9c-2.5-2.6-3.9-5.6-3.9-9S9.5 5.6 12 3Z' }]
  ],
  ruler: [
    ['path', { d: 'M3.5 14.5 14.5 3.5l6 6-11 11z' }],
    ['path', { d: 'M8 8l2 2M11 5l2 2M5 11l2 2M14 6.5l1.5 1.5M6.5 14l1.5 1.5' }]
  ],
  pen: [
    ['path', { d: 'M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z' }],
    ['path', { d: 'M14 6l4 4' }]
  ],
  cursor: [
    ['path', { d: 'M5 3l14 8-6 1.6L10 19z' }]
  ],
  scissors: [
    ['circle', { cx: 6, cy: 6, r: 2.4 }],
    ['circle', { cx: 6, cy: 18, r: 2.4 }],
    ['path', { d: 'M8 7.5 20 18M20 6 8 16.5' }]
  ],
  sun: [
    ['circle', { cx: 12, cy: 12, r: 4 }],
    ['path', { d: 'M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4' }]
  ],
  moon: [
    ['path', { d: 'M20 14.5A8 8 0 0 1 9.5 4a8.2 8.2 0 1 0 10.5 10.5z' }]
  ],
  target: [
    ['circle', { cx: 12, cy: 12, r: 8 }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
    ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3' }]
  ],
  mountain: [
    ['path', { d: 'M3 20l6.5-11 4 6 2.5-4L21 20z' }],
    ['path', { d: 'M8 14l1.5-2.4L11 14' }]
  ],
  save: [
    ['path', { d: 'M5 3h11l3 3v15H5z' }],
    ['path', { d: 'M8 3v5h7V3M8 21v-6h8v6' }]
  ]
};

export default function Icon({ name, size = 16, strokeWidth = 1.7, className = '', ...rest }) {
  const shapes = ICONS[name] || ICONS.overview;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {shapes.map(([tag, attrs], index) => React.createElement(tag, { key: index, ...attrs }))}
    </svg>
  );
}

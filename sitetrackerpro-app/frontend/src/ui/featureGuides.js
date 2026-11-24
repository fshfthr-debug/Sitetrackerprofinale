// ============================================================================
// Feature guide copy.
//
// One entry per screen. The pop-up system (FeatureGuidePopup) opens the entry
// for the screen the person is on, so every feature in the product explains
// itself where it is used rather than in a separate manual.
//
// Adding a screen: add the entry here and a line in SCREEN_META in
// shell/AppShell.jsx. Unknown screens simply get no guide.
//
// Wording rules: say what the screen is for, what to do first, and what the
// record means. No feature is described as "AI powered" or "ArcGIS parity".
// ============================================================================

export const FEATURE_GUIDES = {
  dashboard: {
    icon: 'overview',
    kicker: 'Operations / live portfolio',
    title: 'Overview — one operating picture',
    summary:
      'The overview joins every project you can see: budgets, field progress, payment-risk flags and site context. Nothing here is entered on this screen; it is assembled from the records further in.',
    steps: [
      { title: 'Read the four headline figures', body: 'Active projects, portfolio value in ETB, open risk flags and the share of projects that have reported progress.' },
      { title: 'Work the attention list', body: 'Each row names the project, the problem and the action that clears it — a missing budget, a missing location, missing field progress or a risk flag.' },
      { title: 'Open a project row', body: 'A project row opens its record, where location, budget and delivery window are edited.' },
      { title: 'Jump to the map', body: 'Open map goes to Map intelligence, where the same projects are drawn across the Ethiopian regions.' }
    ],
    tips: [
      'A project with no budget cannot show cost performance; set the budget before reading the commercial figures.',
      'A project with no site location cannot be placed on the national map. Add the location to anchor it.',
      'Cmd/Ctrl + K opens the command palette from any screen.'
    ],
    related: ['projects', 'gis', 'fraud']
  },

  projects: {
    icon: 'projects',
    kicker: 'Operations / portfolio register',
    title: 'Projects — the portfolio register',
    summary:
      'Every project is a record with a name, location, budget, client and delivery window. Field, spatial, quantity and commercial records all attach to a project.',
    steps: [
      { title: 'Scan the register', body: 'Each row shows the project, its site location, progress and status so you can see what is moving and what is stalled.' },
      { title: 'Search before you create', body: 'Use the search box to find an existing project. Duplicate projects split the evidence chain.' },
      { title: 'Open a record', body: 'Selecting a project makes it the active project and opens its record.' },
      { title: 'Create only when needed', body: 'New project opens the creation form; the location field is what places the site on the Ethiopian map.' }
    ],
    tips: [
      'The active project drives the sidebar context and what Site AI reads.',
      'Locations typed as a town or region name are matched to the national gazetteer for the coverage map.'
    ],
    related: ['new-project', 'project-details', 'dashboard']
  },

  'project-details': {
    icon: 'projects',
    kicker: 'Projects / record',
    title: 'Project record',
    summary:
      'The single home for a project: identity, location, budget, client and delivery window. Edits here are what the dashboard, the map and the commercial screens read.',
    steps: [
      { title: 'Keep the location exact', body: 'Use the site name and the town or region. The map matches it to the Ethiopian gazetteer and shows the project in that region.' },
      { title: 'Keep the budget current', body: 'Budget and spend drive cost performance, so an outdated figure makes every commercial screen wrong.' },
      { title: 'Save, then verify', body: 'After saving, the record reloads from the server. If a field did not change, the save did not land.' },
      { title: 'Delete only as an admin', body: 'Deleting a project removes its attached records. Only administrators are allowed to do it.' }
    ],
    tips: [
      'Changes are audited by account; other signed-in devices see them after their next load.',
      'Attach spatial data through Map intelligence rather than in the notes field.'
    ],
    related: ['projects', 'gis', 'surveying']
  },

  'new-project': {
    icon: 'plus',
    kicker: 'Projects / create',
    title: 'Create a project',
    summary:
      'A project must exist before field, spatial or commercial records can be attached to it. Four fields carry the most weight: name, location, budget and delivery window.',
    steps: [
      { title: 'Name it the way the site is known', body: 'Use the contract or site name so the field team recognises it.' },
      { title: 'Add the site location', body: 'Town, district or region. This is what the Ethiopia coverage map uses to place the project.' },
      { title: 'Set a budget', body: 'In ETB. Without it, cost performance and payment assurance have nothing to compare against.' },
      { title: 'Create, then add records', body: 'After creation the project becomes active; add survey control points, GIS layers, quantities and progress next.' }
    ],
    tips: [
      'If the create button does not respond, read the error on the form — it is the server reply, not a styling glitch.',
      'You can create the project first and add the exact coordinates later through Field survey.'
    ],
    related: ['projects', 'surveying', 'gis']
  },

  gis: {
    icon: 'map',
    kicker: 'Spatial operations / workspace',
    title: 'Map intelligence across Ethiopia',
    summary:
      'A map-first record of layers, terrain, survey control and georeferencing. The Ethiopia coverage panel draws the 11 regional boundaries, national place search and how your portfolio is distributed across the country.',
    steps: [
      { title: 'Choose a project and workspace', body: 'Workspace layers belong to a project. Create one workspace per project, then add datasets, survey points or terrain.' },
      { title: 'Open Ethiopia coverage', body: 'The Ethiopia button on the map toolbar opens national tools: fit to Ethiopia, boundaries, labels, coverage shading, place search and the region list.' },
      { title: 'Search a place', body: 'Type a town — Adama, Mekelle, Hawassa, Jigjiga — and the map flies there. Region names also work.' },
      { title: 'Click a region', body: 'A region pop-up opens with its capital, how many projects fall inside it and the names of those projects.' },
      { title: 'Style and inspect layers', body: 'Each layer can be coloured, filtered, labelled, sorted in the attribute table and exported as GeoJSON or CSV.' }
    ],
    tips: [
      'Switch basemaps freely: Street, Satellite, Terrain, Dark GIS, Light GIS, or the offline Addis extract.',
      'Coverage shading counts projects by the location text on their project record; it is a placement aid, not a cadastral boundary.',
      'Regional boundaries are ADM1 (2016, 11 regions). Ethiopia created additional regions after 2023, so treat these as operational units.',
      'Survey observations remain the measured record; the basemap is context only.'
    ],
    related: ['surveying', '3d-viewer', 'bim-import']
  },

  '3d-viewer': {
    icon: 'cube',
    kicker: 'Operations / digital twin',
    title: 'Digital twin',
    summary:
      'The three-dimensional view of a project: BIM models, georeferenced CAD drawings and terrain surfaces, with element identity and measurement kept alongside the model.',
    steps: [
      { title: 'Pick the project', body: 'The twin loads the models and terrain that belong to the selected project.' },
      { title: 'Navigate the model', body: 'Orbit, zoom and pan. Section planes cut the model so internal elements can be inspected.' },
      { title: 'Select an element', body: 'Selecting an element shows its identity and properties, and ties it back to the take-off quantities.' },
      { title: 'Check the take-off', body: 'Element quantities feed the quantity survey; a mismatch there is a measurement issue, not a display issue.' }
    ],
    tips: [
      'Models are only as good as their georeferencing; confirm the CRS before trusting the placement.',
      'Large models load lazily; the first open of a project is slower than the second.'
    ],
    related: ['bim-import', 'quantity-survey', 'gis']
  },

  surveying: {
    icon: 'compass',
    kicker: 'Delivery / field survey',
    title: 'Field survey — control points',
    summary:
      'Control points are the measured reference for everything else. Each point carries coordinates, a status and a description, and is exported to CSV for the instrument.',
    steps: [
      { title: 'Add a control point', body: 'Enter the point name, easting/northing (or latitude/longitude), elevation and a description of what it marks.' },
      { title: 'Set the status', body: 'Status records whether a point is observed, checked or rejected. Rejected points must not be used for setting out.' },
      { title: 'Import from the instrument', body: 'Paste or upload point text; the parser accepts comma and whitespace separated exports.' },
      { title: 'Export', body: 'Download the control point CSV before leaving site so the field record survives a lost connection.' }
    ],
    tips: [
      'Check the CRS: Ethiopian work is usually Adindan / UTM zone 37N (EPSG:20137) or WGS 84 / UTM 37N (EPSG:32637).',
      'Benchmarks are drawn larger and darker than ordinary points on the map.'
    ],
    related: ['gis', '3d-viewer', 'project-details']
  },

  'quantity-survey': {
    icon: 'clipboard',
    kicker: 'Delivery / measurement',
    title: 'Quantity survey',
    summary:
      'Measured quantities by item, with rates. This is the bridge between what was built and what can be paid for.',
    steps: [
      { title: 'Add measured items', body: 'Record description, unit, quantity and rate. Unit and rate decide the amount.' },
      { title: 'Price the lines', body: 'Unpriced lines are flagged — a certified value cannot include them.' },
      { title: 'Compare against the take-off', body: 'BIM and CAD take-offs give the expected quantity; the survey gives the measured quantity. Investigate gaps before certification.' },
      { title: 'Export', body: 'Download CSV for the commercial team or the payment certificate.' }
    ],
    tips: [
      'Quantities are evidence: annotate where a measurement came from.',
      'Rates belong to the Ethiopian standard library or the project rate; do not mix them silently.'
    ],
    related: ['materials', 'project-dashboard', '3d-viewer']
  },

  'project-dashboard': {
    icon: 'chart',
    kicker: 'Delivery / progress and budget',
    title: 'Progress & budget',
    summary:
      'Physical progress against money spent. A project can be behind schedule, ahead of spend, or both — this screen shows which.',
    steps: [
      { title: 'Record progress', body: 'Enter the percentage complete and the budget spent as at a stated date.' },
      { title: 'Read the gap', body: 'Progress below spend means money is running ahead of the work; investigate before the next payment.' },
      { title: 'Keep the history', body: 'Each entry is kept so the trend can be read, not just the latest number.' },
      { title: 'Follow the flag', body: 'A payment risk flag on this project sends you to Risk & fraud with the evidence trail.' }
    ],
    tips: [
      'Progress claims without a dated record are opinion, not evidence.',
      'The budget comes from the project record; fix it there, not here.'
    ],
    related: ['fraud', 'quantity-survey', 'dashboard']
  },

  fraud: {
    icon: 'shield',
    kicker: 'Assurance / payment risk',
    title: 'Risk & fraud',
    summary:
      'Payment-risk flags assembled from progress, quantities, materials and survey records. Each flag is a reason to look before certifying, not a verdict.',
    steps: [
      { title: 'Read the flag', body: 'Each row states the rule that fired, the project it concerns and the records behind it.' },
      { title: 'Check the evidence', body: 'Open the project record and the quantity survey that produced the number.' },
      { title: 'Record the decision', body: 'Either clear the flag with evidence or hold the payment until the record is corrected.' }
    ],
    tips: [
      'Flags are deterministic checks on stored records, not a model opinion.',
      'A cleared flag does not delete history; it records that the evidence was reviewed.'
    ],
    related: ['project-dashboard', 'quantity-survey', 'materials']
  },

  materials: {
    icon: 'box',
    kicker: 'Reference / Ethiopian standards',
    title: 'Materials library',
    summary:
      'Standard material costs and quantities for Ethiopian construction, alongside project-specific rates. Used to price quantities and to sense-check a rate.',
    steps: [
      { title: 'Search a material', body: 'Find the standard rate for cement, rebar, aggregate, formwork and similar items.' },
      { title: 'Compare with the project rate', body: 'A large gap between the standard and the project rate is a commercial question worth asking.' },
      { title: 'Apply deliberately', body: 'Applying a library rate to a quantity survey must be a decision, not a default.' }
    ],
    tips: [
      'Library rates are reference values; the contract rate governs payment.',
      'Prices move. Note the date a rate was last reviewed.'
    ],
    related: ['quantity-survey', 'project-dashboard', 'fraud']
  },

  'bim-import': {
    icon: 'upload',
    kicker: 'Workspace / models',
    title: 'BIM import',
    summary:
      'Bring IFC models into a project so elements, storeys and quantities can be inspected in the digital twin.',
    steps: [
      { title: 'Choose the project', body: 'A model belongs to one project and inherits its location context.' },
      { title: 'Upload the IFC file', body: 'IFC4 and IFC2x3 are read. Very large models take longer and should be imported on a stable connection.' },
      { title: 'Check the storeys and elements', body: 'If storeys are missing, the model’s spatial structure is incomplete; fix it in the authoring tool.' },
      { title: 'Take off quantities', body: 'Element quantities become the comparison baseline for the measured survey.' }
    ],
    tips: [
      'A model without georeferencing cannot be placed on the map; set the CRS first.',
      'Import once per revision and keep the revision name.'
    ],
    related: ['3d-viewer', 'quantity-survey', 'gis']
  },

  team: {
    icon: 'shield',
    kicker: 'Workspace / access control',
    title: 'Team & access',
    summary:
      'One role per account. Viewers read everything, analysts add and edit project data, admins also delete records and assign roles. The API enforces the role, whatever the screen offers.',
    steps: [
      { title: 'Review who has access', body: 'Each row shows the account, how many projects it owns and its current role.' },
      { title: 'Assign the lowest role that works', body: 'Start people as viewers and raise them to analyst only when they need to enter data.' },
      { title: 'Keep an admin', body: 'At least one admin is needed to manage access and delete records.' }
    ],
    tips: [
      'You cannot change your own role here; another admin must do it.',
      'A viewer who needs to edit will see a 403 from the API — that is the control working.'
    ],
    related: ['account', 'dashboard', 'projects']
  },

  account: {
    icon: 'key',
    kicker: 'Account / security',
    title: 'Account & security',
    summary:
      'Rotate your own password. The server verifies the current password and applies the same strength rules the form shows.',
    steps: [
      { title: 'Enter the current password', body: 'This proves the request is yours, not someone using an open session.' },
      { title: 'Choose a new one', body: 'At least 12 characters, different from the current password and not used elsewhere.' },
      { title: 'Confirm and save', body: 'The three local checks turn green before the request is sent; the server can still refuse.' }
    ],
    tips: [
      'You stay signed in on this device; other devices keep their session until it expires.',
      'Locked out? Use “Forgot your password?” on the sign-in screen for a one-use reset link.'
    ],
    related: ['team', 'dashboard', 'account']
  }
};

// The order used by “next feature” and the guide index.
export const GUIDE_ORDER = Object.keys(FEATURE_GUIDES);

export function guideFor(screen) {
  return FEATURE_GUIDES[screen] || null;
}

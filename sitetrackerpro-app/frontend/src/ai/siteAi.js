// Site AI question engine.
//
// Every project-specific answer is computed from records already loaded for the
// signed-in workspace. Engineering answers are transparent methods and preliminary
// calculations, not design decisions. No question text leaves the browser.

import {
  bearingArea,
  concreteQuantities,
  crewDuration,
  earnedValue,
  excavationVolume,
  masonryUnits,
  rebarWeight,
  round,
  slopeGradient
} from './engineering';

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const money = (value) => `ETB ${num(value).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (value, places = 1) => `${num(value).toFixed(places)}%`;

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function mentions(term, words) {
  return words.some(word => {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(word)}([^a-z0-9]|$)`, 'i');
    return pattern.test(term);
  });
}

function capture(term, pattern) {
  const match = term.match(pattern);
  return match ? Number(match[1]) : null;
}

function dimensions(term) {
  const match = term.match(
    /(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)?/
  );
  return match ? { length: Number(match[1]), width: Number(match[2]), depth: Number(match[3]) } : null;
}

function projectFor(question, context) {
  const term = question.toLowerCase();
  const named = context.projects.find(project =>
    project.name && term.includes(String(project.name).toLowerCase())
  );
  return named || context.project || context.projects[0] || null;
}

function progressFor(context) {
  return context.progress || null;
}

function quantityItems(context) {
  return Array.isArray(context.quantitySurvey?.items) ? context.quantitySurvey.items : [];
}

function componentsFor(context) {
  return Array.isArray(context.components) ? context.components : [];
}

function alertsFor(context) {
  return Array.isArray(context.alerts) ? context.alerts : [];
}

function controlPointsFor(context) {
  return Array.isArray(context.controlPoints) ? context.controlPoints : [];
}

function helpAnswer() {
  return {
    text: 'I answer from your workspace records, and I also do common site engineering checks. Ask in plain language.',
    bullets: [
      'Project records: progress, spend, budget, risk flags, control points, quantities, materials and model coverage.',
      'Engineering checks: concrete cement/sand/aggregate, rebar weight, block counts, excavation, footing area, slope and crew duration.',
      'Construction practice: inspection sequences, concrete curing, compaction, quality hold points, safety, claims and payment evidence.',
      'App help: where to import a take-off, record progress, set rates, verify control points or review map evidence.'
    ],
    followups: [
      'Concrete for 10 m³ C25',
      'Cost performance of the active project',
      'How many 12 mm bars do I need for 40 bars × 12 m?',
      'What needs attention?'
    ],
    tag: 'Capabilities'
  };
}

function concreteAnswer(term, context) {
  const gradeMatch = term.match(/\bc\s*(\d{2})\b/i);
  const grade = gradeMatch ? `C${gradeMatch[1]}` : 'C25';
  const volume = capture(term, /(\d+(?:\.\d+)?)\s*(?:m3|m³|cubic\s*metres?|cubic\s*meters?)/i);
  const dims = dimensions(term);
  const calculatedVolume = volume || (dims ? dims.length * dims.width * dims.depth : null);

  if (!calculatedVolume) {
    const mix = concreteQuantities({ volume: 1, grade });
    return {
      text: `For ${mix.grade} nominal concrete (${mix.mixRatio} cement : sand : aggregate), a useful site guide per cubic metre is:`,
      bullets: [
        `${mix.cementBags} bags of 50 kg cement.`,
        `${mix.sandM3} m³ sand and ${mix.aggregateM3} m³ coarse aggregate, before an allowance for wastage.`,
        `About ${mix.waterLitres} litres of water at a water/cement ratio of ${mix.waterCementRatio}; adjust for real aggregate moisture.`,
        'Give me the volume or dimensions (for example “10 m³ C25” or “5 m × 4 m × 0.2 m”) for a quantity take-off.',
        'Use the approved design mix and cube tests; nominal mixes are preliminary only.'
      ],
      followups: ['Concrete for 10 m³ C25', 'How much rebar for 12 mm × 6 m × 50 bars?', 'What is the curing requirement?'],
      tag: 'Engineering method'
    };
  }

  const takeoff = concreteQuantities({ volume: calculatedVolume, grade });
  return {
    text: `Preliminary ${takeoff.grade} concrete take-off for ${takeoff.netVolume} m³${dims ? ` (${dims.length} × ${dims.width} × ${dims.depth} m)` : ''}, including ${takeoff.wastagePercent}% wastage:`,
    bullets: [
      `${takeoff.cementBags} bags of 50 kg cement (${takeoff.cementKg} kg).`,
      `${takeoff.sandM3} m³ sand and ${takeoff.aggregateM3} m³ coarse aggregate.`,
      `About ${takeoff.waterLitres} litres of water at w/c ${takeoff.waterCementRatio}; confirm with a slump test and actual aggregate moisture.`,
      `Nominal mix used: 1 : ${takeoff.mixRatio.split(' : ')[1]} : ${takeoff.mixRatio.split(' : ')[2]}. Confirm against the approved design mix.`,
      'Order 5–10% extra for site loss only if it is not already inside the wastage allowance.'
    ],
    followups: ['Rebar for 12 mm × 12 m × 40 bars', 'Concrete curing requirements', 'How do I record this take-off?'],
    tag: 'Engineering calculation'
  };
}

function rebarAnswer(term) {
  const diameter = capture(term, /(\d+(?:\.\d+)?)\s*mm\b/i) || capture(term, /\b(8|10|12|16|20|25|32)\b/);
  const count = capture(term, /(\d+)\s*(?:pieces?|pcs?|bars?|nos?|units?)/i) || 1;
  const length = capture(term, /(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\b/i);

  if (!diameter) {
    return {
      text: 'Tell me the bar diameter, length and number of bars. Deformed steel weighs d²/162 kg per metre.',
      bullets: [
        'Example: 12 mm bars, 12 m long, 40 pieces.',
        'A 12 mm bar weighs about 0.888 kg/m; a 16 mm bar about 1.58 kg/m.',
        'Add lap lengths, anchorage, chairs and spacers separately from the cut length.'
      ],
      followups: ['Rebar for 12 mm × 12 m × 40 bars', 'What is a typical lap length?'],
      tag: 'Engineering method'
    };
  }

  if (!length) {
    const perMetre = rebarWeight({ diameterMm: diameter, lengthM: 1, count: 1 });
    return {
      text: `A ${perMetre.diameterMm} mm deformed bar weighs ${perMetre.kgPerMetre} kg per metre.`,
      bullets: [
        'Give me the cut length and number of bars for a total weight.',
        'Laps, anchorage and offcuts are additional to the theoretical cut length.'
      ],
      followups: [`Rebar for ${diameter} mm × 12 m × 40 bars`, 'What is a typical lap length?'],
      tag: 'Engineering calculation'
    };
  }

  const weight = rebarWeight({ diameterMm: diameter, lengthM: length, count });
  return {
    text: `Theoretical weight for ${weight.count} × ${weight.diameterMm} mm bars at ${weight.lengthM} m:`,
    bullets: [
      `${weight.kgPerMetre} kg/m × ${weight.lengthM} m × ${weight.count} = ${weight.totalKg} kg (${weight.totalTonnes} t).`,
      'This is the nominal mass only, before laps, anchorage, bending allowances and site wastage.',
      'Check the bar mark schedule and the approved structural drawings before ordering.'
    ],
    followups: ['Add a 10% lap and wastage allowance', 'Concrete for the same element', 'What is a typical lap length?'],
    tag: 'Engineering calculation'
  };
}

function masonryAnswer(term) {
  const area = capture(term, /(\d+(?:\.\d+)?)\s*(?:m2|m²|sq\.?\s*m|square\s*metres?)/i);
  const isBrick = mentions(term, ['brick', 'bricks']);
  if (!area) {
    return {
      text: 'Give me the wall area in m² (and the unit size if it is not a standard block).',
      bullets: [
        'A standard 400 × 200 × 200 mm block with 10 mm joints needs about 12 blocks per m².',
        'A 190 × 90 × 90 mm brick with 10 mm joints needs about 50 bricks per m².',
        'Deduct openings and add a wastage allowance; mortar is estimated separately.'
      ],
      followups: ['How many blocks for a 20 m² wall?', 'How much mortar for that wall?'],
      tag: 'Engineering method'
    };
  }

  const takeoff = isBrick
    ? masonryUnits({ wallArea: area, unitLength: 0.19, unitHeight: 0.09, unitWidth: 0.09 })
    : masonryUnits({ wallArea: area });
  return {
    text: `Preliminary ${isBrick ? 'brick' : 'block'} count for ${takeoff.wallArea} m² of wall, including 5% wastage:`,
    bullets: [
      `${takeoff.count} units (${takeoff.netCount} before wastage).`,
      `About ${takeoff.mortarM3} m³ of mortar for the joints, before bedding and wastage.`,
      'Deduct door and window openings, and confirm the actual unit size on site.',
      'Add lintels, columns, reinforcement and movement joints separately.'
    ],
    followups: ['How much mortar for that wall?', 'How many blocks per m²?', 'Concrete for the lintel'],
    tag: 'Engineering calculation'
  };
}

function earthworksAnswer(term) {
  const dims = dimensions(term);
  const length = dims?.length || capture(term, /(\d+(?:\.\d+)?)\s*m?\s*(?:long|length)/i);
  const width = dims?.width || capture(term, /(\d+(?:\.\d+)?)\s*m?\s*(?:wide|width)/i);
  const depth = dims?.depth || capture(term, /(\d+(?:\.\d+)?)\s*m?\s*(?:deep|depth)\b/i);

  if (!length || !width || !depth) {
    return {
      text: 'For an excavation take-off, give me length × width × depth in metres.',
      bullets: [
        'Bank volume is the in-situ volume; loose volume adds a bulking allowance (typically 20–30%).',
        'Add working space, side slopes, bedding and backfill separately.',
        'Check the geotechnical report and underground services before digging.'
      ],
      followups: ['Excavation for 20 m × 10 m × 2 m', 'How many truck loads is that?', 'Cut and fill guidance'],
      tag: 'Engineering method'
    };
  }

  const takeoff = excavationVolume({ length, width, depth });
  return {
    text: `Preliminary excavation for ${takeoff.lengthM} × ${takeoff.widthM} × ${takeoff.depthM} m:`,
    bullets: [
      `${takeoff.bankM3} m³ in situ (bank volume).`,
      `${takeoff.looseM3} m³ loose at 25% bulking, about ${takeoff.truckLoadsAt12M3} loads at 12 m³ per truck.`,
      'This excludes working space, side slopes, dewatering, backfill and disposal distance.',
      'Confirm the bulking factor and haulage rate with the contractor’s method statement.'
    ],
    followups: ['Cut and fill guidance', 'How long will this take with one crew?', 'What needs attention?'],
    tag: 'Engineering calculation'
  };
}

function bearingAnswer(term) {
  const load = capture(term, /(\d+(?:\.\d+)?)\s*(?:kn|kilo\s*newtons?)/i);
  const capacity = capture(term, /(\d+(?:\.\d+)?)\s*(?:kpa|kn\/m2|kn\/m²)/i);
  if (!load || !capacity) {
    return {
      text: 'For a preliminary footing check, give me the axial load in kN and the allowable bearing pressure in kPa.',
      bullets: [
        'Required area = service load × 1.1 / allowable bearing pressure.',
        'This is a sizing check only; settlement, eccentricity, uplift and reinforcement need structural design.',
        'Use the geotechnical report’s allowable pressure, not a rule-of-thumb value.'
      ],
      followups: ['Footing for 500 kN at 150 kPa', 'What is a safe bearing capacity?'],
      tag: 'Engineering method'
    };
  }

  const footing = bearingArea({ loadKN: load, allowableKPa: capacity });
  return {
    text: `Preliminary footing area for ${footing.loadKN} kN at ${footing.allowableKPa} kPa:`,
    bullets: [
      `${footing.requiredAreaM2} m² required after the ${footing.factor} load factor.`,
      `A square footing would be about ${footing.squareSideM} m × ${footing.squareSideM} m.`,
      'Check settlement, overturning, sliding, punching shear and reinforcement before adopting a size.',
      'Confirm the allowable bearing pressure and founding level from the geotechnical investigation.'
    ],
    followups: ['Concrete for that footing', 'Rebar for that footing', 'What is a safe bearing capacity?'],
    tag: 'Engineering calculation'
  };
}

function productivityAnswer(term) {
  const quantity = capture(term, /(\d+(?:\.\d+)?)\s*(?:m3|m³|m2|m²|units?|pieces?|tonnes?|t)\b/i);
  const output = capture(term, /(\d+(?:\.\d+)?)\s*(?:m3|m³|m2|m²|units?|pieces?|tonnes?|t)?\s*(?:per|\/)\s*(?:crew\s*)?day/i);
  const crews = capture(term, /(\d+)\s*crews?/i) || 1;
  if (!quantity || !output) {
    return {
      text: 'I can estimate duration from quantity and crew output. Give me both, for example “600 m³ at 50 m³ per crew day with 2 crews”.',
      bullets: [
        'Duration = quantity ÷ (output per crew day × number of crews).',
        'Use measured output from comparable work, not a target rate.',
        'Add weather, access, curing, inspection and rework allowances to the programme.'
      ],
      followups: ['600 m³ at 50 m³ per crew day with 2 crews', 'How do I build a critical path?', 'Progress on the active project'],
      tag: 'Engineering method'
    };
  }

  const duration = crewDuration({ quantity, outputPerCrewDay: output, crews });
  return {
    text: `At ${duration.outputPerCrewDay} per crew day with ${duration.crews} crew${duration.crews === 1 ? '' : 's'}:`,
    bullets: [
      `${duration.quantity} ÷ ${duration.dailyOutput} per day = ${duration.days} working days.`,
      `About ${duration.weeks} weeks at six working days per week.`,
      'Add weather, curing, inspection, rework and mobilisation allowances.',
      'Check that the output rate matches the actual method, plant and site access.'
    ],
    followups: ['How do I build a critical path?', 'What needs attention?', 'Draft an inspection checklist'],
    tag: 'Engineering calculation'
  };
}

function slopeAnswer(term) {
  const rise = capture(term, /(\d+(?:\.\d+)?)\s*m?\s*(?:rise|vertical|up|height)/i);
  const run = capture(term, /(\d+(?:\.\d+)?)\s*m?\s*(?:run|horizontal|over|across)/i);
  if (!rise || !run) {
    return {
      text: 'Give me the vertical rise and horizontal run, for example “1.5 m rise over 20 m run”.',
      bullets: [
        'Grade (%) = rise ÷ run × 100.',
        'A 1 in n slope means 1 vertical unit for every n horizontal units.',
        'For drainage and access checks, confirm the minimum and maximum grades in the design.'
      ],
      followups: ['Slope for 1.5 m rise over 20 m run', 'What is a typical drainage slope?'],
      tag: 'Engineering method'
    };
  }

  const slope = slopeGradient({ rise, run });
  return {
    text: `That slope is ${slope.percent}% (${slope.degrees}°), or 1 in ${slope.oneIn}:`,
    bullets: [
      `${slope.riseM} m rise over ${slope.runM} m run.`,
      'Confirm the required grade against the design, especially for drainage, ramps and access routes.',
      'On site, check the fall over the full length rather than a short section.'
    ],
    followups: ['What is a typical drainage slope?', 'How do I check levels on site?'],
    tag: 'Engineering calculation'
  };
}

function costAnswer(term, context, project) {
  if (!project) {
    return {
      text: 'There is no project in this workspace yet, so there is no budget or spend to compare.',
      bullets: ['Create a project and set its budget to unlock cost performance.'],
      followups: ['Brief me on the portfolio'],
      tag: 'Workspace records'
    };
  }

  const progress = progressFor(context);
  const budget = num(project.budget);
  const forecast = context.forecast || null;
  const spent = num(progress?.budget_spent);
  const complete = num(progress?.progress_percent);

  if (!progress) {
    return {
      text: `${project.name} has a budget of ${money(budget)}, but no physical progress has been recorded yet.`,
      bullets: [
        'Without progress, earned value, cost performance and the burn gap cannot be calculated.',
        'Record physical progress and spend in Progress & budget, then ask again.',
        forecast ? `The latest budget forecast splits ${money(forecast.materials)} materials, ${money(forecast.labor)} labour, ${money(forecast.equipment)} equipment and ${money(forecast.contingency)} contingency.` : 'Generate a budget forecast to see the planned allocation.',
        'Certify only against measured work and the supporting evidence trail.'
      ],
      followups: ['How do I record progress?', 'What needs attention?', 'Generate a budget forecast'],
      tag: 'Workspace records'
    };
  }

  const ev = earnedValue({ budget, spent, percentComplete: complete });
  const findings = [
    `Budget ${money(ev.budget)}; recorded spend ${money(ev.spent)} (${ev.spentPercent === null ? 'no budget set' : pct(ev.spentPercent)}).`,
    `Physical progress ${pct(ev.percentComplete)}; earned value ${money(ev.earnedValue)}.`,
    ev.cpi === null
      ? 'No spend has been recorded, so CPI is not available.'
      : `Cost performance index ${ev.cpi.toFixed(2)}${ev.cpi < 1 ? ' — work is costing more than it has earned.' : ev.cpi > 1 ? ' — work is earning more than it has cost.' : ' — cost is on plan.'}`,
    ev.burnGapPercent === null
      ? 'Burn gap is not available without a budget.'
      : `Spend is ${ev.burnGapPercent > 0 ? `${ev.burnGapPercent.toFixed(1)} points ahead of` : ev.burnGapPercent < 0 ? `${Math.abs(ev.burnGapPercent).toFixed(1)} points behind` : 'level with'} physical progress.`,
    ev.eac === null ? `Remaining budget: ${money(ev.remaining)}.` : `Forecast at completion ${money(ev.eac)}; variance ${money(ev.vac)}.`
  ];

  return {
    text: `Cost position for ${project.name}, using the latest recorded progress:`,
    bullets: findings,
    followups: ['What needs attention?', 'Summarise project status', 'Draft an inspection checklist'],
    tag: 'Workspace records'
  };
}

function progressAnswer(context, project) {
  if (!project) {
    return {
      text: 'There is no active project yet. Create one to start recording field progress.',
      bullets: ['A project unlocks survey, quantities, progress and risk records.'],
      followups: ['Brief me on the portfolio'],
      tag: 'Workspace records'
    };
  }

  const progress = progressFor(context);
  const budget = num(project.budget);
  if (!progress) {
    return {
      text: `${project.name} has no field progress recorded yet${project.location ? ` for ${project.location}` : ''}.`,
      bullets: [
        'Record physical progress in Progress & budget before comparing spend or certifying work.',
        budget > 0 ? `The project budget is ${money(budget)}.` : 'The project has no budget, so cost performance cannot be measured.',
        project.timeline ? `Delivery window: ${project.timeline}.` : 'Add a delivery window to make programme checks meaningful.',
        'Use site diaries, photos and measured quantities as the evidence behind the percentage.'
      ],
      followups: ['How do I record progress?', 'What needs attention?', 'Cost performance of the active project'],
      tag: 'Workspace records'
    };
  }

  const complete = num(progress.progress_percent);
  const spent = num(progress.budget_spent);
  const ev = earnedValue({ budget, spent, percentComplete: complete });
  return {
    text: `${project.name} is ${pct(complete)} physically complete${project.location ? ` in ${project.location}` : ''}.`,
    bullets: [
      `Recorded spend ${money(spent)}${budget > 0 ? ` of ${money(budget)} (${pct(ev.spentPercent)})` : '; no budget is set'}.`,
      progress.created_at ? `Latest progress entry: ${new Date(progress.created_at).toLocaleDateString()}.` : 'The progress entry has no timestamp.',
      ev.burnGapPercent === null ? 'Set a budget to compare spend with progress.' : `Spend is ${Math.abs(ev.burnGapPercent).toFixed(1)} points ${ev.burnGapPercent > 0 ? 'ahead of' : ev.burnGapPercent < 0 ? 'behind' : 'level with'} physical progress.`,
      project.timeline ? `Delivery window: ${project.timeline}.` : 'Add a delivery window to check programme pressure.',
      'Open Progress & budget to see the trend and forecast.'
    ],
    followups: ['Cost performance of the active project', 'What needs attention?', 'Draft an inspection checklist'],
    tag: 'Workspace records'
  };
}

function quantityAnswer(context, project) {
  if (!project) {
    return {
      text: 'There is no active project, so there is no quantity survey to report.',
      bullets: ['Create a project and import a BIM or CSV take-off first.'],
      followups: ['How do I import a take-off?'],
      tag: 'Workspace records'
    };
  }

  const items = quantityItems(context);
  if (items.length === 0) {
    return {
      text: `${project.name} has no priced quantity survey yet.`,
      bullets: [
        'Import a CSV/TSV take-off in BIM import, or paste rows from Excel.',
        'Set material rates in Quantity survey so the BoQ can be priced.',
        'Once lines exist I can summarise quantities, unpriced items and the largest cost lines.'
      ],
      followups: ['How do I import a take-off?', 'How do I set rates?', 'Materials on the active project'],
      tag: 'Workspace records'
    };
  }

  const summary = context.quantitySurvey || {};
  const priced = items.filter(item => item.priced);
  const unpriced = items.filter(item => !item.priced);
  const ranked = [...items].sort((a, b) => num(b.amount) - num(a.amount) || num(b.quantity) - num(a.quantity));
  const top = (priced.length > 0 ? ranked.filter(item => item.priced) : ranked).slice(0, 4);
  const lines = top.map(item =>
    `${item.materialType} — ${num(item.quantity).toLocaleString()} ${item.unit}${item.priced ? ` at ${money(item.rate)}/${item.unit} = ${money(item.amount)}` : ' (no rate set)'}`
  );

  return {
    text: `Quantity survey for ${project.name}: ${items.length} priced line${items.length === 1 ? '' : 's'} from ${num(summary.totalComponents).toLocaleString()} take-off components.`,
    bullets: [
      `Priced value ${money(summary.totalAmount)}; ${num(summary.pricedLines)} line${num(summary.pricedLines) === 1 ? '' : 's'} priced and ${num(summary.unpricedLines)} unpriced.`,
      ...lines,
      unpriced.length > 0 ? `Complete the ${unpriced.length} unpriced line${unpriced.length === 1 ? '' : 's'} before treating the total as final.` : 'Every line has a rate, so the priced total is complete for the current take-off.',
      'Quantities follow the imported take-off; check units and wastage assumptions against the BoQ.'
    ],
    followups: ['Materials on the active project', 'How do I set rates?', 'What needs attention?'],
    tag: 'Workspace records'
  };
}

function materialsAnswer(context, project) {
  const components = componentsFor(context);
  if (!project || components.length === 0) {
    return {
      text: project ? `${project.name} has no imported take-off components yet.` : 'There is no active project yet.',
      bullets: [
        'Import a CSV or TSV take-off in BIM import to unlock material summaries.',
        'The quantity survey and bill of materials use the same component rows.',
        'I can then group materials by type and unit without mixing units.'
      ],
      followups: ['How do I import a take-off?', 'Quantities on the active project'],
      tag: 'Workspace records'
    };
  }

  const groups = new Map();
  components.forEach(component => {
    const key = `${component.material_type || 'Unspecified'}|${component.unit || 'units'}`;
    const current = groups.get(key) || { material: component.material_type || 'Unspecified', unit: component.unit || 'units', quantity: 0, count: 0 };
    current.quantity += num(component.quantity);
    current.count += 1;
    groups.set(key, current);
  });

  const top = [...groups.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 6);
  return {
    text: `Material take-off for ${project.name}: ${components.length} components across ${groups.size} material/unit groups.`,
    bullets: [
      ...top.map(group => `${group.material}: ${round(group.quantity, 2).toLocaleString()} ${group.unit} across ${group.count} component${group.count === 1 ? '' : 's'}.`),
      'Units are never added together; the quantity survey keeps material and unit as the pricing key.',
      'Check wastage, laps and conversion factors before ordering.',
      'Open Materials to compare against the Ethiopian standard rates and project rates.'
    ],
    followups: ['Quantities on the active project', 'How do I set rates?', 'What needs attention?'],
    tag: 'Workspace records'
  };
}

function riskAnswer(context, project) {
  const alerts = alertsFor(context);
  const findings = [];
  const projects = context.projects || [];

  projects.forEach(item => {
    if (!num(item.budget)) findings.push(`${item.name} has no budget, so cost performance cannot be measured.`);
    if (!item.location) findings.push(`${item.name} has no site location, which weakens map context.`);
  });

  if (project && !progressFor(context)) {
    findings.push(`${project.name} has no recorded field progress, so payment evidence is incomplete.`);
  }

  if (alerts.length > 0) {
    const latest = alerts[0];
    findings.unshift(`${alerts.length} payment risk flag${alerts.length === 1 ? '' : 's'} on ${project?.name || 'the active project'}; latest recommendation: ${latest.recommendation || 'review'}.`);
    if (latest.fraud_score != null) findings.push(`Latest fraud score ${num(latest.fraud_score)} / 100.`);
    findings.push('Open Risk & fraud to inspect the quantity, price and delivery evidence behind each flag.');
  }

  if (findings.length === 0) {
    findings.push('No portfolio-level blockers are visible: budgets, site locations, progress and payment flags are clear for the records loaded here.');
  }

  return {
    text: 'Here is the current attention picture, grounded in the records loaded in this workspace.',
    bullets: findings,
    followups: ['Summarise project status', 'Draft an inspection checklist', 'Cost performance of the active project'],
    tag: 'Workspace records'
  };
}

function surveyAnswer(context, project) {
  const points = controlPointsFor(context);
  if (!project) {
    return {
      text: 'There is no active project, so there is no survey register to report.',
      bullets: ['Create a project to start a control network.'],
      followups: ['How do I add a control point?'],
      tag: 'Workspace records'
    };
  }

  if (points.length === 0) {
    return {
      text: `${project.name} has no control points in the register yet.`,
      bullets: [
        'Add or import control points in Field survey before setting out works.',
        'Record the CRS, vertical datum and benchmark status for every point.',
        'Verify points before using them for setting out or earthwork checks.'
      ],
      followups: ['How do I add a control point?', 'Map evidence on the active project'],
      tag: 'Workspace records'
    };
  }

  const byStatus = points.reduce((acc, point) => {
    const status = point.status || 'unknown';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const benchmarks = points.filter(point => point.is_benchmark).length;
  const statusText = Object.entries(byStatus).map(([status, count]) => `${count} ${status}`).join(', ');

  return {
    text: `Control register for ${project.name}: ${points.length} point${points.length === 1 ? '' : 's'}.`,
    bullets: [
      `Status mix: ${statusText}.`,
      `${benchmarks} point${benchmarks === 1 ? ' is a benchmark' : 's are benchmarks'}.`,
      'Use only verified points for setting out; submitted points still need a review decision.',
      'Compare survey observations with the processed DEM in Map intelligence → Survey review.'
    ],
    followups: ['Map evidence on the active project', 'Draft an inspection checklist', 'What needs attention?'],
    tag: 'Workspace records'
  };
}

function bimAnswer(context, project) {
  const components = componentsFor(context);
  const models = Array.isArray(context.models) ? context.models : [];
  if (!project) {
    return {
      text: 'There is no active project, so there is no digital twin to inspect.',
      bullets: ['Create a project and import a take-off or model first.'],
      followups: ['How do I import a take-off?'],
      tag: 'Workspace records'
    };
  }

  const materials = new Set(components.map(component => component.material_type).filter(Boolean));
  return {
    text: `Digital twin coverage for ${project.name}: ${components.length} components in ${materials.size} material group${materials.size === 1 ? '' : 's'}.`,
    bullets: [
      `${models.length} model file${models.length === 1 ? '' : 's'} recorded.`,
      components.length === 0 ? 'No components have been imported, so quantities and the twin are empty.' : 'The same components feed the quantity survey, BOM and 3D viewer.',
      'Check element identity, levels and units before relying on the model for take-off.',
      'Use Digital twin to inspect the model, terrain and section tools; use BIM import to correct take-off rows.'
    ],
    followups: ['Materials on the active project', 'Quantities on the active project', 'How do I import a take-off?'],
    tag: 'Workspace records'
  };
}

function mapAnswer(context, project) {
  const located = (context.projects || []).filter(item => item.location).length;
  return {
    text: project ? `Spatial context for ${project.name}${project.location ? ` is anchored at ${project.location}` : ' has no site location yet'}.` : 'Map intelligence is the spatial source of truth for the portfolio.',
    bullets: [
      `${located} of ${(context.projects || []).length} projects have a site location recorded.`,
      'Check the working CRS and saved georeferencing fit before placing model geometry.',
      'Use Map intelligence → Map workspace to inspect layers, annotations and the georeferencing preview.',
      'Treat OpenStreetMap context as reference only; survey observations remain the measured record.'
    ],
    followups: ['Survey control on the active project', 'What needs attention?', 'How do I georeference a model?'],
    tag: 'Workspace records'
  };
}

function inspectionAnswer(context, project) {
  const complete = project ? num(progressFor(context)?.progress_percent) : 0;
  const stage = complete < 10
    ? 'early works and foundations'
    : complete < 45
      ? 'structure and frame'
      : complete < 85
        ? 'finishes and services'
        : 'completion and handover';

  return {
    text: `A field inspection sequence for ${project?.name || 'the active project'}, at the ${stage} stage (${pct(complete)} recorded):`,
    bullets: [
      'Confirm control points, the working CRS and the current approved drawing revision before capturing observations.',
      'Photograph access, boundaries and any work covered by the next payment application.',
      'Measure quantities against the current BIM take-off and note every variance with a location.',
      'Record GPS, timestamp and the person responsible for every issue that could affect certification.',
      'Close the inspection only after photos, notes and the corrective action have synced.'
    ],
    followups: ['Quality hold points', 'Safety hazards on this project', 'What needs attention?'],
    tag: 'Construction practice'
  };
}

function constructionTopic(term, context, project) {
  if (mentions(term, ['curing', 'cure'])) {
    return {
      text: 'Concrete curing is a hold point, not an optional finish.',
      bullets: [
        'Keep exposed concrete moist for at least 7 days for ordinary Portland cement; extend it for hot weather, blended cements or specified performance.',
        'Start curing as soon as the surface can take it without damage; do not let it dry between wettings.',
        'Record curing method, start date and duration in the inspection record.',
        'Protect fresh concrete from traffic, rain and rapid drying; test cubes at 7 and 28 days.'
      ],
      followups: ['Concrete for 10 m³ C25', 'Quality hold points'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['compaction', 'compaction test', 'mdd', 'proctor'])) {
    return {
      text: 'Compaction control should be measured, not judged by eye.',
      bullets: [
        'Place fill in loose layers, commonly 150–200 mm, and compact each layer before the next.',
        'Target the specified percentage of maximum dry density (often 95% MDD) from the proctor curve.',
        'Take field density tests at the specified frequency and location; record the test method and result.',
        'Control moisture near optimum and keep haul roads and stockpiles drained.'
      ],
      followups: ['Cut and fill guidance', 'Quality hold points', 'Excavation for 20 m × 10 m × 2 m'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['lap', 'anchorage', 'development length'])) {
    return {
      text: 'Lap and anchorage lengths come from the structural design and the code, not a universal rule.',
      bullets: [
        'A common starting point for tension laps is 40–50 bar diameters, but it depends on concrete grade, bar size, spacing and confinement.',
        'Stagger laps in highly stressed zones and avoid laps where the design prohibits them.',
        'Check the bar mark schedule, drawing notes and the applicable standard before cutting.',
        'Record lap positions during inspection; they are often covered by the next pour.'
      ],
      followups: ['Rebar for 12 mm × 12 m × 40 bars', 'Quality hold points'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['formwork', 'shuttering', 'falsework'])) {
    return {
      text: 'Formwork is temporary structure: it needs its own design and inspection.',
      bullets: [
        'Check props, bracing, bearers and foundations for the actual wet-concrete load and construction loads.',
        'Use release agents and tight joints to control surface finish and grout loss.',
        'Inspect line, level, plumb, dimensions and stability before every pour.',
        'Do not strike until the specified strength is reached; record the approval.'
      ],
      followups: ['Concrete curing requirements', 'Quality hold points'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['safety', 'ppe', 'hazard', 'toolbox', 'incident'])) {
    return {
      text: `Priority safety controls for ${project?.name || 'this site'}:`,
      bullets: [
        'Excavations: locate services, batter or shore the sides, control water and keep plant away from the edge.',
        'Work at height: guardrails, harness points and a rescue plan before access.',
        'Lifting: approved lift plan, certified plant, trained riggers and exclusion zones.',
        'Electrical and plant: isolation, earth leakage protection, reversing controls and segregated walkways.',
        'Start each shift with a toolbox talk and record the hazard, control and responsible person.'
      ],
      followups: ['Draft an inspection checklist', 'Quality hold points', 'What needs attention?'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['quality', 'itp', 'hold point', 'ncr', 'non conformance', 'nonconformance', 'test'])) {
    return {
      text: 'A practical quality chain for site work:',
      bullets: [
        'Inspection and Test Plan (ITP): define the activity, acceptance criteria, test method, frequency and witness/hold points.',
        'Hold points need a signed release before work proceeds; do not cover work that has not been inspected.',
        'Keep material certificates, cube results, compaction tests and survey records with the location and date.',
        'Raise an NCR for non-conforming work, quarantine it and record the disposition and re-inspection.',
        'Close the loop with the drawing revision and the person who accepted the work.'
      ],
      followups: ['Draft an inspection checklist', 'Concrete curing requirements', 'What needs attention?'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['claim', 'variation', 'eot', 'extension of time', 'delay', 'retention', 'payment certificate', 'certif'])) {
    return {
      text: 'Claims and payment certificates are won or lost on contemporaneous records.',
      bullets: [
        'Give the contractual notice within the stated period and keep proof of delivery.',
        'Link each delay or variation to a dated event, instruction, drawing revision and affected activity.',
        'Keep daily diaries, site instructions, photos, plant returns and measured quantities in one evidence trail.',
        'Separate measured work, variations, retention and advance recovery on the payment application.',
        'Do not certify work that is not measured, inspected and supported by the evidence.'
      ],
      followups: ['What needs attention?', 'Cost performance of the active project', 'Draft an inspection checklist'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['boq', 'bill of quantities', 'takeoff', 'take-off', 'measurement', 'wastage'])) {
    return {
      text: 'A reliable BoQ starts with consistent measurement rules.',
      bullets: [
        'Measure net work to the stated method, then add wastage and laps as separate allowances.',
        'Keep material and unit as the pricing key; never add bags to cubic metres.',
        'Record the drawing revision, location and assumptions behind each quantity.',
        'Price rate build-ups from material, labour, equipment, overhead and profit rather than a single lump sum.',
        'Compare the priced BoQ with the budget and flag unpriced lines before certifying.'
      ],
      followups: ['Quantities on the active project', 'How do I set rates?', 'Materials on the active project'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['procurement', 'supplier', 'order', 'lead time', 'rate build'])) {
    return {
      text: 'Procurement should follow the programme, not the other way round.',
      bullets: [
        'Build rates from material, labour, equipment, overhead and profit, then compare with current market quotes.',
        'Check lead times against the critical path; long-lead items need earlier orders and float.',
        'Record supplier, quantity, unit, price, delivery date and acceptance evidence.',
        'Inspect delivered materials against the specification before accepting them.',
        'Keep a contingency for price movement and currency exposure where relevant.'
      ],
      followups: ['How do I set rates?', 'What is a rate build-up?', 'What needs attention?'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['critical path', 'programme', 'schedule', 'sequence', 'duration'])) {
    return {
      text: 'Build the programme from the work breakdown, then let the logic drive the dates.',
      bullets: [
        'Break work into activities with clear quantities, crews and outputs.',
        'Link activities by real dependencies: access, curing, inspections, deliveries and approvals.',
        'The critical path is the longest dependent chain; any delay there moves completion.',
        'Use float deliberately and protect hold points and long-lead deliveries.',
        'Update progress with measured quantities, not just a percentage feel.'
      ],
      followups: ['600 m³ at 50 m³ per crew day with 2 crews', 'Progress on the active project', 'Draft an inspection checklist'],
      tag: 'Construction practice'
    };
  }

  if (mentions(term, ['soil', 'bearing capacity', 'foundation', 'footing'])) {
    return {
      text: 'Foundation decisions belong to the geotechnical and structural design.',
      bullets: [
        'Use the investigation’s allowable bearing pressure and founding level, not a rule of thumb.',
        'Check settlement, differential movement, groundwater and adjacent structures.',
        'For a preliminary square footing, area ≈ service load × 1.1 ÷ allowable pressure.',
        'Confirm reinforcement, punching shear and uplift before construction.'
      ],
      followups: ['Footing for 500 kN at 150 kPa', 'What is a safe bearing capacity?'],
      tag: 'Construction practice'
    };
  }

  return null;
}

function appHelpAnswer(term) {
  if (mentions(term, ['import', 'takeoff', 'take-off', 'csv', 'tsv', 'excel']) && mentions(term, ['bim', 'model', 'quantity', 'takeoff', 'take-off', 'csv'])) {
    return {
      text: 'To bring quantities into SiteTrackerPro, start in BIM import:',
      bullets: [
        'Open BIM import for the active project.',
        'Upload a CSV/TSV take-off, or paste rows copied from Excel/Numbers.',
        'Include component name, material, quantity, unit and phase where possible.',
        'Review the imported rows in Quantity survey, then set a rate for every material/unit line.',
        'Use the same rows in the digital twin, BOM and progress evidence.'
      ],
      followups: ['How do I set rates?', 'Quantities on the active project'],
      tag: 'App help'
    };
  }

  if (mentions(term, ['rate', 'pricing', 'price'])) {
    return {
      text: 'Rates are set per material and unit, so bags and cubic metres never get mixed.',
      bullets: [
        'Open Quantity survey for the active project.',
        'Set a rate for each material/unit line and save it.',
        'Unpriced lines are flagged and contribute zero, so a zero total is never treated as complete.',
        'Generate the BOM after all significant lines are priced.'
      ],
      followups: ['Quantities on the active project', 'Materials on the active project'],
      tag: 'App help'
    };
  }

  if (mentions(term, ['create a project', 'new project', 'start a project'])) {
    return {
      text: 'Create the project first so every record has a home.',
      bullets: [
        'Open New project from the sidebar.',
        'Set the project name, budget, site location and delivery window.',
        'Select the project as active, then add survey control, take-off and progress records.',
        'Budgets and locations drive the portfolio attention checks.'
      ],
      followups: ['What needs attention?', 'How do I import a take-off?'],
      tag: 'App help'
    };
  }

  if (mentions(term, ['progress', 'record progress', 'update progress'])) {
    return {
      text: 'Record progress from measured work, not from a guess at the end of the month.',
      bullets: [
        'Open Progress & budget for the active project.',
        'Enter the physical percentage complete and the budget spent to date.',
        'Add a note describing the work measured and the evidence behind it.',
        'Save, then review the burn gap and trend before certifying payment.'
      ],
      followups: ['Cost performance of the active project', 'What needs attention?'],
      tag: 'App help'
    };
  }

  if (mentions(term, ['control point', 'control points', 'benchmark', 'setting out'])) {
    return {
      text: 'Control points are the measured reference for everything spatial.',
      bullets: [
        'Open Field survey and add a point or import a CSV register.',
        'Record latitude, longitude, elevation, datum and benchmark status.',
        'New points start as Draft or Submitted; verify them from the register before setting out.',
        'The owner can change status, and every change is written to the audit history.'
      ],
      followups: ['Survey control on the active project', 'Map evidence on the active project'],
      tag: 'App help'
    };
  }

  if (mentions(term, ['georeference', 'georeferencing', 'crs', 'coordinate system'])) {
    return {
      text: 'Georeferencing ties model or drawing coordinates to the survey datum.',
      bullets: [
        'Set the working CRS and vertical datum for the project before importing spatial data.',
        'Use Map intelligence → Georeferencing to fit control points and preview the alignment.',
        'Check residuals and the preview before applying the fit.',
        'Survey observations remain authoritative; treat the basemap as context only.'
      ],
      followups: ['Map evidence on the active project', 'Survey control on the active project'],
      tag: 'App help'
    };
  }

  return null;
}

function portfolioAnswer(context) {
  const projects = context.projects || [];
  const totalBudget = projects.reduce((sum, item) => sum + num(item.budget), 0);
  const withLocation = projects.filter(item => item.location).length;
  const withBudget = projects.filter(item => num(item.budget) > 0).length;
  const current = context.project;

  if (projects.length === 0) {
    return {
      text: 'This workspace has no projects yet.',
      bullets: ['Create a project to start the evidence chain from field capture to payment assurance.'],
      followups: ['How do I create a project?'],
      tag: 'Workspace records'
    };
  }

  return {
    text: `Portfolio brief: ${projects.length} project${projects.length === 1 ? '' : 's'}, ${money(totalBudget)} in recorded budgets.`,
    bullets: [
      ...projects.slice(0, 5).map(item => `${item.name}: ${money(item.budget)}${item.location ? ` · ${item.location}` : ' · no location'}${item.timeline ? ` · ${item.timeline}` : ''}.`),
      `${withBudget} of ${projects.length} projects have a budget; ${withLocation} have a site location.`,
      current && progressFor(context) ? `${current.name} is ${pct(num(progressFor(context).progress_percent))} complete with ${money(progressFor(context).budget_spent)} spent.` : 'No physical progress is loaded for the active project yet.',
      alertsFor(context).length > 0 ? `${alertsFor(context).length} payment risk flag${alertsFor(context).length === 1 ? '' : 's'} need review.` : 'No open payment risk flags in the loaded records.'
    ],
    followups: ['What needs attention?', 'Summarise project status', 'Cost performance of the active project'],
    tag: 'Workspace records'
  };
}

export function answerQuestion(question, context = {}) {
  const clean = String(question || '').trim();
  const term = clean.toLowerCase();
  const project = projectFor(clean, context);

  if (!clean) {
    return helpAnswer();
  }

  if (mentions(term, ['help', 'what can you do', 'capabilities', 'what do you know', 'how can you help'])) {
    return helpAnswer();
  }

  // How-to questions are app guidance, not quantity lookups. This must run before
  // the words "take-off" or "quantity" are treated as a request for the survey.
  const earlyHelp = appHelpAnswer(term);
  if (earlyHelp && !term.includes('how many') && (term.startsWith('how') || term.startsWith('where') || mentions(term, ['how do i', 'how to', 'where do i']))) {
    return earlyHelp;
  }

  if (mentions(term, ['what is', 'define', 'meaning', 'difference between']) && mentions(term, ['boq', 'cpi', 'spi', 'itp', 'ncr', 'rfi', 'eot', 'retention'])) {
    return {
      text: 'Those are core commercial and quality terms. Here is the short version:',
      bullets: [
        'BoQ — bill of quantities: measured work items, units and rates that form the priced scope.',
        'CPI — cost performance index: earned value ÷ actual cost; below 1 means spending more than earned.',
        'SPI — schedule performance index: earned value ÷ planned value; below 1 means behind programme.',
        'ITP — inspection and test plan: activities, acceptance criteria, tests and hold points.',
        'NCR — non-conformance report: records work that does not meet the specification and its disposition.',
        'RFI — request for information: a formal query to the designer before proceeding.',
        'EOT — extension of time: a contractual adjustment to completion for excusable delay.',
        'Retention — money held back from certificates as security for defects.'
      ],
      followups: ['What needs attention?', 'How do claims work?', 'Quality hold points'],
      tag: 'Construction practice'
    };
  }

  // Engineering calculations first: an explicit number plus an engineering noun
  // should be computed rather than answered with general guidance.
  if (mentions(term, ['concrete', 'cement', 'mix', 'c25', 'c30', 'c20', 'c15'])) {
    const hasQuantity = /(\d+(?:\.\d+)?)\s*(?:m3|m³|cubic)/i.test(term) || dimensions(term);
    if (hasQuantity) return concreteAnswer(term, context);
    if (mentions(term, ['slump', 'cover', 'cube', 'water cement', 'water/cement', 'w/c', 'workability'])) {
      return {
        text: 'Concrete acceptance is a combination of mix design, testing and site control.',
        bullets: [
          'Slump measures workability, not strength; use the slump specified for the element and method of placement.',
          'Water/cement ratio controls strength and durability; never add water on site to make placing easier without approval.',
          'Cover is measured from the finished concrete face to the reinforcement; use spacers and check before every pour.',
          'Take cube samples at the specified frequency and test at 7 and 28 days; record the location each cube represents.',
          'The approved design mix and specification override any rule of thumb.'
        ],
        followups: ['Concrete for 10 m³ C25', 'What is the curing requirement?', 'Quality hold points'],
        tag: 'Construction practice'
      };
    }

    if (mentions(term, ['difference', 'grade', 'grades', 'compare']) && mentions(term, ['c15', 'c20', 'c25', 'c30'])) {
      return {
        text: 'Nominal concrete grades are a starting point; the approved design mix governs the real proportions and strength.',
        bullets: [
          'C15 — 1 : 3 : 6, commonly used for blinding and non-structural fill.',
          'C20 — 1 : 2 : 4, commonly used for mass concrete and light foundations.',
          'C25 — 1 : 1.5 : 3, commonly used for reinforced foundations, columns and beams.',
          'C30 — 1 : 1 : 2, a richer nominal mix for higher-strength structural work.',
          'Higher grade means more cement and a lower water/cement ratio, but durability, exposure and cube testing still have to be specified.',
          'Confirm every mix against the structural drawings and the approved design mix.'
        ],
        followups: ['Concrete for 10 m³ C25', 'What is the curing requirement?'],
        tag: 'Construction practice'
      };
    }
    if (mentions(term, ['grade', 'ratio', 'bag', 'bags', 'much', 'quantity', 'takeoff', 'take-off'])) {
      return concreteAnswer(term, context);
    }
    if (!mentions(term, ['safety', 'hazard'])) return concreteAnswer(term, context);
  }

  if (mentions(term, ['rebar', 'reinforcement', 'steel bar', 'bar', 'bars'])) {
    const hasBarData = /(\d+(?:\.\d+)?)\s*mm\b/i.test(term) || /(\d+)\s*(?:pieces?|pcs?|bars?|nos?)/i.test(term);
    if (hasBarData) return rebarAnswer(term);
    if (!mentions(term, ['safety', 'hazard'])) return rebarAnswer(term);
  }

  if (mentions(term, ['block', 'blocks', 'brick', 'bricks', 'masonry'])) {
    if (/(\d+(?:\.\d+)?)\s*(?:m2|m²|sq)/i.test(term) || mentions(term, ['how many', 'count', 'quantity'])) {
      return masonryAnswer(term);
    }
    if (!mentions(term, ['safety', 'hazard'])) return masonryAnswer(term);
  }

  if (mentions(term, ['excavation', 'excavate', 'cut and fill', 'earthwork', 'earthworks', 'trench']) && !mentions(term, ['safety', 'shoring', 'cave-in', 'hazard'])) {
    return earthworksAnswer(term);
  }

  if (mentions(term, ['footing', 'foundation', 'bearing capacity', 'bearing'])) {
    if (/(\d+(?:\.\d+)?)\s*(?:kn|kpa)/i.test(term)) return bearingAnswer(term);
    const topic = constructionTopic(term, context, project);
    if (topic) return topic;
  }

  if (mentions(term, ['productivity', 'output', 'crew day', 'man day']) || (mentions(term, ['duration', 'how long']) && /(\d+(?:\.\d+)?)\s*(?:m3|m³|m2|m²|units?|pieces?|tonnes?)/i.test(term) && /per|\/|day/i.test(term))) {
    return productivityAnswer(term);
  }

  if (mentions(term, ['slope', 'gradient', 'incline']) || (mentions(term, ['fall', 'drainage']) && mentions(term, ['rise', 'run', 'grade', 'percent']))) {
    return slopeAnswer(term);
  }

  // Workspace records.
  if (mentions(term, ['risk', 'attention', 'wrong', 'flag', 'fraud', 'block payment'])) {
    return riskAnswer(context, project);
  }

  if (mentions(term, ['cost', 'budget', 'spend', 'spent', 'cpi', 'earned value', 'eac', 'variance', 'forecast'])) {
    return costAnswer(term, context, project);
  }

  if (mentions(term, ['material', 'materials', 'bom', 'bill of materials'])) {
    return materialsAnswer(context, project);
  }

  if (mentions(term, ['takeoff', 'take-off', 'quantities', 'quantity survey', 'boq'])) {
    return quantityAnswer(context, project);
  }

  if (mentions(term, ['progress', 'status', 'summary', 'summarise', 'complete', 'completion'])) {
    return progressAnswer(context, project);
  }

  if (mentions(term, ['survey', 'control point', 'control points', 'benchmark', 'setting out'])) {
    return surveyAnswer(context, project);
  }

  if (mentions(term, ['bim', 'digital twin', 'twin', 'model', 'components', 'ifc'])) {
    return bimAnswer(context, project);
  }

  if (mentions(term, ['map', 'gis', 'location', 'spatial', 'georeference', 'crs'])) {
    return mapAnswer(context, project);
  }

  if (mentions(term, ['inspection', 'checklist', 'field'])) {
    return inspectionAnswer(context, project);
  }

  if (mentions(term, ['portfolio', 'brief', 'projects'])) {
    return portfolioAnswer(context);
  }

  const appHelp = appHelpAnswer(term);
  if (appHelp) return appHelp;

  const topic = constructionTopic(term, context, project);
  if (topic) return topic;

  return {
    text: 'I do not have a specific answer for that in the loaded workspace records yet.',
    bullets: [
      'Try naming the project and the record you mean, for example “budget for Bole Tower” or “quantities on the active project”.',
      'For an engineering take-off, include the dimensions, grade or unit, for example “concrete for 10 m³ C25”.',
      'I can also explain site practice for concrete, rebar, formwork, compaction, quality, safety, claims and BoQ.',
      'If this is a design decision, confirm it with the structural engineer and the approved drawings.'
    ],
    followups: ['What can you do?', 'What needs attention?', 'Concrete for 10 m³ C25'],
    tag: 'Not enough records'
  };
}

// Construction engineering calculations for Site AI.
//
// These are deliberately deterministic and unit-explicit. They are preliminary
// estimating aids, not a substitute for a design mix, structural design or the
// project's approved BoQ.

const BAG_KG = 50;
const CEMENT_KG_PER_M3 = 1440;

export const NOMINAL_MIXES = {
  C15: { cement: 1, sand: 3, aggregate: 6, waterCementRatio: 0.6 },
  C20: { cement: 1, sand: 2, aggregate: 4, waterCementRatio: 0.55 },
  C25: { cement: 1, sand: 1.5, aggregate: 3, waterCementRatio: 0.5 },
  C30: { cement: 1, sand: 1, aggregate: 2, waterCementRatio: 0.45 }
};

export const round = (value, places = 2) => {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
};

export function normaliseGrade(grade) {
  const clean = String(grade || '').toUpperCase().replace(/\s+/g, '');
  const match = clean.match(/C\s*(\d{2})/);
  return match ? `C${match[1]}` : 'C25';
}

// Nominal-volume method. A 1.54 dry-volume factor is the common site allowance
// for voids between aggregate; the approved design mix always wins over this.
export function concreteQuantities({
  volume,
  grade = 'C25',
  wastage = 0.05,
  dryFactor = 1.54
} = {}) {
  const grossVolume = Math.max(0, Number(volume) || 0) * (1 + Math.max(0, Number(wastage) || 0));
  const key = normaliseGrade(grade);
  const mix = NOMINAL_MIXES[key] || NOMINAL_MIXES.C25;
  const parts = mix.cement + mix.sand + mix.aggregate;
  const dryVolume = grossVolume * dryFactor;
  const cementVolume = dryVolume * (mix.cement / parts);
  const cementKg = cementVolume * CEMENT_KG_PER_M3;
  const cementBags = cementKg / BAG_KG;

  return {
    grade: NOMINAL_MIXES[key] ? key : 'C25',
    assumedGrade: !NOMINAL_MIXES[key],
    mixRatio: `${mix.cement} : ${mix.sand} : ${mix.aggregate}`,
    volume: round(grossVolume, 2),
    netVolume: round(Math.max(0, Number(volume) || 0), 2),
    wastagePercent: round((Number(wastage) || 0) * 100, 1),
    cementBags: round(cementBags, 1),
    cementKg: round(cementKg, 0),
    sandM3: round(dryVolume * (mix.sand / parts), 2),
    aggregateM3: round(dryVolume * (mix.aggregate / parts), 2),
    waterLitres: round(cementKg * mix.waterCementRatio, 0),
    waterCementRatio: mix.waterCementRatio
  };
}

// Nominal mass of deformed steel: d² / 162 kg per metre.
export function rebarWeight({ diameterMm, lengthM, count = 1 } = {}) {
  const diameter = Math.max(0, Number(diameterMm) || 0);
  const length = Math.max(0, Number(lengthM) || 0);
  const pieces = Math.max(0, Number(count) || 0);
  const kgPerMetre = (diameter * diameter) / 162;
  const totalKg = kgPerMetre * length * pieces;

  return {
    diameterMm: round(diameter, 0),
    lengthM: round(length, 2),
    count: round(pieces, 0),
    kgPerMetre: round(kgPerMetre, 3),
    totalKg: round(totalKg, 1),
    totalTonnes: round(totalKg / 1000, 3)
  };
}

// Counts rectangular walling units and estimates the mortar volume. Dimensions
// are the actual unit size in metres, not the nominal module.
export function masonryUnits({
  wallArea,
  unitLength = 0.4,
  unitHeight = 0.2,
  unitWidth = 0.2,
  mortarThickness = 0.01,
  wastage = 0.05
} = {}) {
  const area = Math.max(0, Number(wallArea) || 0);
  const length = Math.max(0.01, Number(unitLength) || 0.4);
  const height = Math.max(0.01, Number(unitHeight) || 0.2);
  const width = Math.max(0.01, Number(unitWidth) || 0.2);
  const joint = Math.max(0, Number(mortarThickness) || 0.01);
  const waste = Math.max(0, Number(wastage) || 0);
  const moduleArea = (length + joint) * (height + joint);
  const netCount = moduleArea > 0 ? area / moduleArea : 0;
  const count = netCount * (1 + waste);
  const wallVolume = area * width;
  const unitVolume = netCount * length * height * width;

  return {
    wallArea: round(area, 2),
    count: Math.ceil(count),
    netCount: Math.ceil(netCount),
    wastagePercent: round(waste * 100, 1),
    mortarM3: round(Math.max(0, wallVolume - unitVolume), 2)
  };
}

export function excavationVolume({
  length,
  width,
  depth,
  bulking = 0.25
} = {}) {
  const l = Math.max(0, Number(length) || 0);
  const w = Math.max(0, Number(width) || 0);
  const d = Math.max(0, Number(depth) || 0);
  const bankM3 = l * w * d;
  const looseM3 = bankM3 * (1 + Math.max(0, Number(bulking) || 0));

  return {
    lengthM: round(l, 2),
    widthM: round(w, 2),
    depthM: round(d, 2),
    bankM3: round(bankM3, 2),
    looseM3: round(looseM3, 2),
    truckLoadsAt12M3: Math.ceil(looseM3 / 12)
  };
}

export function crewDuration({
  quantity,
  outputPerCrewDay,
  crews = 1,
  workingDaysPerWeek = 6
} = {}) {
  const qty = Math.max(0, Number(quantity) || 0);
  const output = Math.max(0, Number(outputPerCrewDay) || 0);
  const crewCount = Math.max(1, Number(crews) || 1);
  const dailyOutput = output * crewCount;
  const days = dailyOutput > 0 ? qty / dailyOutput : null;
  const perWeek = Math.max(1, Number(workingDaysPerWeek) || 6);

  return {
    quantity: round(qty, 2),
    outputPerCrewDay: round(output, 2),
    crews: round(crewCount, 0),
    dailyOutput: round(dailyOutput, 2),
    days: days === null ? null : round(days, 1),
    weeks: days === null ? null : round(days / perWeek, 1)
  };
}

export function earnedValue({
  budget,
  spent,
  percentComplete,
  plannedPercent = null
} = {}) {
  const bac = Math.max(0, Number(budget) || 0);
  const ac = Math.max(0, Number(spent) || 0);
  const actual = Math.max(0, Math.min(100, Number(percentComplete) || 0));
  const ev = bac * (actual / 100);
  const cpi = ac > 0 ? ev / ac : null;
  const planned = Number.isFinite(Number(plannedPercent)) ? Number(plannedPercent) : null;
  const pv = planned === null ? null : bac * (Math.max(0, Math.min(100, planned)) / 100);
  const spi = pv && pv > 0 ? ev / pv : null;
  const eac = cpi && cpi > 0 ? bac / cpi : null;

  return {
    budget: round(bac, 2),
    spent: round(ac, 2),
    percentComplete: round(actual, 1),
    plannedPercent: planned === null ? null : round(planned, 1),
    earnedValue: round(ev, 2),
    plannedValue: pv === null ? null : round(pv, 2),
    cpi: cpi === null ? null : round(cpi, 2),
    spi: spi === null ? null : round(spi, 2),
    eac: eac === null ? null : round(eac, 2),
    vac: eac === null ? null : round(bac - eac, 2),
    spentPercent: bac > 0 ? round((ac / bac) * 100, 1) : null,
    burnGapPercent: bac > 0 ? round((ac / bac) * 100 - actual, 1) : null,
    remaining: round(bac - ac, 2)
  };
}

// Preliminary footing area from axial load and allowable bearing pressure.
export function bearingArea({
  loadKN,
  allowableKPa,
  upliftFactor = 1.1
} = {}) {
  const load = Math.max(0, Number(loadKN) || 0);
  const capacity = Math.max(0, Number(allowableKPa) || 0);
  const factor = Math.max(1, Number(upliftFactor) || 1.1);
  const serviceLoad = load * factor;
  const area = capacity > 0 ? serviceLoad / capacity : null;
  const side = area === null ? null : Math.sqrt(area);

  return {
    loadKN: round(load, 1),
    allowableKPa: round(capacity, 1),
    factor: round(factor, 2),
    requiredAreaM2: area === null ? null : round(area, 2),
    squareSideM: side === null ? null : round(side, 2)
  };
}

export function slopeGradient({ rise, run } = {}) {
  const vertical = Math.max(0, Number(rise) || 0);
  const horizontal = Math.max(0, Number(run) || 0);
  const ratio = horizontal > 0 ? vertical / horizontal : null;

  return {
    riseM: round(vertical, 2),
    runM: round(horizontal, 2),
    percent: ratio === null ? null : round(ratio * 100, 1),
    degrees: ratio === null ? null : round((Math.atan(ratio) * 180) / Math.PI, 1),
    oneIn: ratio === null || ratio === 0 ? null : round(1 / ratio, 1)
  };
}

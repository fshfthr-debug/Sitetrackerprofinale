import { answerQuestion } from './siteAi';

const project = {
  id: 1,
  name: 'Bole Tower',
  budget: 1000000,
  location: 'Addis Ababa',
  timeline: '2026–2027'
};

const context = {
  projects: [project],
  project,
  progress: { progress_percent: 40, budget_spent: 500000, created_at: '2026-11-01T00:00:00.000Z' },
  quantitySurvey: {
    items: [
      { materialType: 'Concrete', unit: 'm3', quantity: 120, rate: 9000, amount: 1080000, priced: true },
      { materialType: 'Rebar', unit: 'kg', quantity: 5000, rate: null, amount: 0, priced: false }
    ],
    totalComponents: 18,
    totalAmount: 1080000,
    pricedLines: 1,
    unpricedLines: 1
  },
  components: [
    { material_type: 'Concrete', unit: 'm3', quantity: 120 },
    { material_type: 'Rebar', unit: 'kg', quantity: 5000 }
  ],
  controlPoints: [{ status: 'verified', is_benchmark: true }, { status: 'submitted', is_benchmark: false }],
  alerts: [{ recommendation: 'BLOCK_PAYMENT', fraud_score: 80, details: '{}' }],
  models: [{ id: 1 }]
};

describe('Site AI', () => {
  test('answers cost performance from recorded progress', () => {
    const answer = answerQuestion('What is the cost performance of the active project?', context);
    expect(answer.tag).toBe('Workspace records');
    expect(answer.bullets.join(' ')).toContain('Cost performance index 0.80');
    expect(answer.bullets.join(' ')).toContain('10.0 points ahead');
  });

  test('computes concrete quantities from a volume and grade', () => {
    const answer = answerQuestion('Concrete for 10 m³ C25', context);
    expect(answer.tag).toBe('Engineering calculation');
    expect(answer.bullets.join(' ')).toContain('84.7 bags');
    expect(answer.bullets.join(' ')).toContain('4.41 m³ sand');
  });

  test('computes rebar weight', () => {
    const answer = answerQuestion('Rebar for 12 mm × 12 m × 40 bars', context);
    expect(answer.tag).toBe('Engineering calculation');
    expect(answer.bullets.join(' ')).toContain('426.7 kg');
  });

  test('counts blocks for a wall area', () => {
    const answer = answerQuestion('How many blocks for a 20 m² wall?', context);
    expect(answer.tag).toBe('Engineering calculation');
    expect(answer.bullets.join(' ')).toContain('244 units');
  });

  test('counts control points instead of treating “how many” as a how-to question', () => {
    const answer = answerQuestion('How many control points are verified?', context);
    expect(answer.tag).toBe('Workspace records');
    expect(answer.text).toContain('2 points');
    expect(answer.bullets.join(' ')).toContain('1 verified');
  });

  test('shows the bill of materials summary', () => {
    const answer = answerQuestion('Show me the BOM', context);
    expect(answer.tag).toBe('Workspace records');
    expect(answer.bullets.join(' ')).toContain('Concrete: 120 m3');
  });

  test('answers construction-practice questions', () => {
    const answer = answerQuestion('What is a typical lap length?', context);
    expect(answer.tag).toBe('Construction practice');
    expect(answer.bullets.join(' ')).toContain('40–50 bar diameters');
  });

  test('compares concrete grades without inventing quantities', () => {
    const answer = answerQuestion('What is the difference between C20 and C25?', context);
    expect(answer.tag).toBe('Construction practice');
    expect(answer.bullets.join(' ')).toContain('C20 — 1 : 2 : 4');
    expect(answer.bullets.join(' ')).toContain('C25 — 1 : 1.5 : 3');
  });

  test('reports unpriced quantity lines instead of presenting a complete total', () => {
    const answer = answerQuestion('Quantities on the active project', context);
    expect(answer.bullets.join(' ')).toContain('1 unpriced');
    expect(answer.bullets.join(' ')).toContain('Complete the 1 unpriced line');
  });

  test('routes how-to questions to app guidance before quantity lookup', () => {
    const answer = answerQuestion('How do I import a take-off?', context);
    expect(answer.tag).toBe('App help');
    expect(answer.text).toContain('BIM import');
  });

  test('explains commercial terms without treating them as quantity data', () => {
    const answer = answerQuestion('What is CPI?', context);
    expect(answer.tag).toBe('Construction practice');
    expect(answer.bullets.join(' ')).toContain('earned value ÷ actual cost');
  });

  test('surfaces payment risk with the source recommendation', () => {
    const answer = answerQuestion('What needs attention?', context);
    expect(answer.bullets.join(' ')).toContain('BLOCK_PAYMENT');
    expect(answer.bullets.join(' ')).toContain('Latest fraud score 80');
  });

  test('is honest when a question has no matching record or method', () => {
    const answer = answerQuestion('What is the colour of the site gate?', context);
    expect(answer.tag).toBe('Not enough records');
    expect(answer.bullets.join(' ')).toContain('Try naming the project');
  });
});

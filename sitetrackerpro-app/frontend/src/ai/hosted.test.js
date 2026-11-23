import {
  buildHostedContext,
  conversationForModel,
  draftFromAnswer,
  shouldUseHostedAi
} from './hosted';

const project = {
  id: 7,
  user_id: 99,
  name: 'Bole Tower',
  budget: '1000000',
  location: 'Addis Ababa',
  description: 'Private commercial tower'
};

const context = {
  projects: [project],
  project,
  progress: { progress_percent: '40', budget_spent: '500000', notes: 'Level 3 poured', created_at: '2026-11-01' },
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
    { material_type: 'Concrete', unit: 'm3', quantity: 100 },
    { material_type: 'Concrete', unit: 'm3', quantity: 20 },
    { material_type: 'Rebar', unit: 'kg', quantity: 5000 }
  ],
  controlPoints: [
    { status: 'verified', is_benchmark: true },
    { status: 'submitted', is_benchmark: false }
  ],
  alerts: [{ recommendation: 'BLOCK_PAYMENT', fraud_score: '80', created_at: '2026-11-02' }],
  models: [{ file_path: '/secret/path' }],
  forecast: { materials: 590000, labor: 310000, equipment: 50000, contingency: 50000 }
};

describe('hosted Site AI helpers', () => {
  test('builds compact project facts without user IDs, emails or file paths', () => {
    const payload = buildHostedContext(context);
    const serialised = JSON.stringify(payload);
    expect(serialised).not.toContain('user_id');
    expect(serialised).not.toContain('99');
    expect(serialised).not.toContain('secret/path');
    expect(serialised).not.toContain('Level 3 poured');
    expect(payload.activeProject.name).toBe('Bole Tower');
    expect(payload.latestProgress.percentComplete).toBe(40);
    expect(payload.quantitySurvey.unpricedLines).toBe(1);
  });

  test('groups materials by material and unit', () => {
    const payload = buildHostedContext(context);
    expect(payload.materials).toEqual([
      { material: 'Rebar', unit: 'kg', quantity: 5000, components: 1 },
      { material: 'Concrete', unit: 'm3', quantity: 120, components: 2 }
    ]);
  });

  test('summarises control points and risk flags', () => {
    const payload = buildHostedContext(context);
    expect(payload.controlPoints).toEqual({
      total: 2,
      benchmarks: 1,
      byStatus: { verified: 1, submitted: 1 }
    });
    expect(payload.paymentRisk[0].recommendation).toBe('BLOCK_PAYMENT');
    expect(payload.digitalTwin.modelFiles).toBe(1);
  });

  test('keeps only the last six conversation turns', () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({
      role: index % 2 ? 'assistant' : 'user',
      text: `message ${index}`,
      bullets: index === 8 ? ['last bullet'] : []
    }));
    const history = conversationForModel(messages);
    expect(history).toHaveLength(6);
    expect(history[5].content).toContain('last bullet');
    expect(history[0].content).toBe('message 3');
  });

  test('routes construction practice and unknown questions to the hosted model', () => {
    expect(shouldUseHostedAi({ tag: 'Construction practice' })).toBe(true);
    expect(shouldUseHostedAi({ tag: 'Not enough records' })).toBe(true);
    expect(shouldUseHostedAi({ tag: 'Engineering calculation' })).toBe(false);
    expect(shouldUseHostedAi({ tag: 'Workspace records' })).toBe(false);
  });

  test('turns the local answer into a draft for the model', () => {
    expect(draftFromAnswer({ text: 'Check the soil.', bullets: ['Investigate first.'] }))
      .toBe('Check the soil.\n- Investigate first.');
  });
});

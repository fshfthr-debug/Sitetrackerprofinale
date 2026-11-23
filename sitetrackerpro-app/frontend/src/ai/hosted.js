// Helpers for the optional hosted model. Only the project facts the user can
// already see are sent; user IDs, emails, file paths and raw database rows are not.

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function clean(value, max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function materialSummary(components) {
  const groups = new Map();
  (Array.isArray(components) ? components : []).forEach(component => {
    const material = clean(component.material_type || 'Unspecified', 80);
    const unit = clean(component.unit || 'units', 20);
    const key = `${material}|${unit}`;
    const current = groups.get(key) || { material, unit, quantity: 0, components: 0 };
    current.quantity += num(component.quantity);
    current.components += 1;
    groups.set(key, current);
  });

  return [...groups.values()]
    .sort((a, b) => b.quantity - a.quantity)
    .slice(0, 20)
    .map(group => ({
      material: group.material,
      unit: group.unit,
      quantity: Math.round(group.quantity * 100) / 100,
      components: group.components
    }));
}

export function buildHostedContext(context = {}) {
  const projects = Array.isArray(context.projects) ? context.projects : [];
  const project = context.project || projects[0] || null;
  const progress = context.progress || null;
  const survey = context.quantitySurvey || null;
  const points = Array.isArray(context.controlPoints) ? context.controlPoints : [];
  const alerts = Array.isArray(context.alerts) ? context.alerts : [];
  const models = Array.isArray(context.models) ? context.models : [];

  const byStatus = points.reduce((acc, point) => {
    const status = clean(point.status || 'unknown', 40);
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});

  const items = Array.isArray(survey?.items) ? survey.items : [];
  const topQuantities = [...items]
    .sort((a, b) => num(b.amount) - num(a.amount) || num(b.quantity) - num(a.quantity))
    .slice(0, 25)
    .map(item => ({
      material: clean(item.materialType, 100),
      unit: clean(item.unit, 20),
      quantity: num(item.quantity),
      rate: item.priced ? num(item.rate) : null,
      amount: item.priced ? num(item.amount) : null,
      priced: Boolean(item.priced)
    }));

  return {
    activeProject: project ? {
      name: clean(project.name, 160),
      location: clean(project.location, 160) || null,
      budgetEtb: num(project.budget) || null,
      timeline: clean(project.timeline, 100) || null
    } : null,
    portfolio: projects.slice(0, 10).map(item => ({
      name: clean(item.name, 160),
      location: clean(item.location, 160) || null,
      budgetEtb: num(item.budget) || null
    })),
    latestProgress: progress ? {
      percentComplete: num(progress.progress_percent),
      budgetSpentEtb: num(progress.budget_spent),
      recordedAt: clean(progress.created_at, 60) || null
      // Progress notes are deliberately excluded: they are free text and often
      // contain commercial or personal information that the model does not need.
    } : null,
    quantitySurvey: survey ? {
      totalComponents: num(survey.totalComponents),
      totalAmountEtb: num(survey.totalAmount),
      pricedLines: num(survey.pricedLines),
      unpricedLines: num(survey.unpricedLines),
      topLines: topQuantities
    } : null,
    materials: materialSummary(context.components),
    controlPoints: {
      total: points.length,
      benchmarks: points.filter(point => point.is_benchmark).length,
      byStatus
    },
    paymentRisk: alerts.slice(0, 5).map(alert => ({
      recommendation: clean(alert.recommendation, 40) || null,
      score: alert.fraud_score == null ? null : num(alert.fraud_score),
      recordedAt: clean(alert.created_at, 60) || null
    })),
    digitalTwin: {
      components: Array.isArray(context.components) ? context.components.length : 0,
      modelFiles: models.length
    },
    budgetForecast: context.forecast ? {
      materialsEtb: num(context.forecast.materials),
      labourEtb: num(context.forecast.labor),
      equipmentEtb: num(context.forecast.equipment),
      contingencyEtb: num(context.forecast.contingency)
    } : null
  };
}

export function conversationForModel(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-6)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: [
        clean(message.text, 1200),
        ...(Array.isArray(message.bullets) ? message.bullets.map(item => `- ${clean(item, 300)}`) : [])
      ].filter(Boolean).join('\n')
    }))
    .filter(message => message.content);
}

export function draftFromAnswer(answer) {
  if (!answer) return '';
  return [
    clean(answer.text, 2000),
    ...(Array.isArray(answer.bullets) ? answer.bullets.map(item => `- ${clean(item, 300)}`) : [])
  ].filter(Boolean).join('\n');
}

export function shouldUseHostedAi(answer) {
  return Boolean(answer && (answer.tag === 'Construction practice' || answer.tag === 'Not enough records'));
}

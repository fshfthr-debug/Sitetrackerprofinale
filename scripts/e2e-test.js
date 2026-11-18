#!/usr/bin/env node
/**
 * End-to-end proof that the app works against the real Neon database.
 *
 * It drives the running server over HTTP exactly as the browser does - sign up,
 * sign in, create a project, save survey data, compute cut & fill, import a
 * quantity take-off, price it, generate a BOM, forecast a budget, score an
 * invoice, record progress - then opens a second connection straight to Neon to
 * confirm the rows really landed in the database. The test account is removed
 * again at the end.
 *
 * Usage: node scripts/e2e-test.js http://127.0.0.1:3000
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
for (const file of [path.join(ROOT, '.env.local'), path.join(ROOT, '.env')]) {
  if (fs.existsSync(file)) require('dotenv').config({ path: file });
}
const { Client } = require('pg');

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const email = `e2e-${Date.now()}@example.com`;
const password = 'Survey-Line-2026!';

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failures.push(`${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
    console.log(`  ❌ ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`);
  }
}

async function call(method, url, { body, token, raw, headers = {} } = {}) {
  const response = await fetch(BASE + url, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  const contentType = response.headers.get('content-type') || '';
  const payload = raw
    ? await response.text()
    : contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text();

  return { status: response.status, body: payload, contentType };
}

/**
 * Deletes a project and everything that points at it, then the test accounts.
 * Only tables are touched - views like fraud_alert_summary cannot be deleted from.
 * A previous failed run may have left rows behind, so it sweeps every e2e account.
 */
async function removeTestAccounts(client, extraProjectIds = []) {
  const childTables = await client.query(
    `SELECT t.table_name
       FROM information_schema.tables t
       JOIN information_schema.columns c
         ON c.table_schema = t.table_schema AND c.table_name = t.table_name
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.column_name = 'project_id'`
  );

  const accounts = await client.query("SELECT id FROM users WHERE email LIKE 'e2e-%@example.com'");
  const userIds = accounts.rows.map(row => row.id);

  const projectIds = [...extraProjectIds];
  if (userIds.length > 0) {
    const owned = await client.query('SELECT id FROM projects WHERE user_id = ANY($1::int[])', [userIds]);
    projectIds.push(...owned.rows.map(row => row.id));
  }

  for (const id of projectIds) {
    for (const { table_name } of childTables.rows) {
      await client.query(`DELETE FROM ${table_name} WHERE project_id = $1`, [id]);
    }
    await client.query('DELETE FROM projects WHERE id = $1', [id]);
  }

  if (userIds.length > 0) {
    await client.query('DELETE FROM activity_logs WHERE user_id = ANY($1::int[])', [userIds]);
    await client.query('DELETE FROM users WHERE id = ANY($1::int[])', [userIds]);
  }
}

async function main() {
  console.log(`Testing ${BASE} as ${email}\n`);

  // ---------- public surface ----------
  const health = await call('GET', '/health');
  check('GET /health answers', health.status === 200 && /Backend Running/.test(health.body.status || ''), health.body);

  const page = await call('GET', '/', { raw: true });
  check('built React app is served at /', page.status === 200 && /<div id="root">/.test(page.body), page.status);

  const unauthorised = await call('GET', '/api/projects');
  check('API refuses a request with no token (401)', unauthorised.status === 401, unauthorised.body);

  // ---------- accounts ----------
  const register = await call('POST', '/auth/register', {
    body: { email, password, fullName: 'End To End Test', company: 'Timona Survey' }
  });
  check('sign up creates an account', register.status === 200 && !!register.body.token, register.body);
  let token = register.body && register.body.token;

  const login = await call('POST', '/auth/login', { body: { email, password } });
  check('sign in returns a token', login.status === 200 && !!login.body.token, login.body);
  token = (login.body && login.body.token) || token;

  const weakPassword = await call('POST', '/auth/change-password', {
    token,
    body: { currentPassword: password, newPassword: 'short' }
  });
  check('password policy rejects a weak new password (400)', weakPassword.status === 400, weakPassword.body);

  // ---------- project ----------
  const project = await call('POST', '/api/projects', {
    token,
    body: { name: 'E2E Tower', description: 'Created by the test', budget: 12500000, location: 'Addis Ababa', timeline: '18 months' }
  });
  check('project is created', project.status === 200 && !!project.body.id, project.body);
  const projectId = project.body && project.body.id;

  const survey = await call('POST', '/api/surveying/control-points', {
    token,
    body: {
      projectId, latitude: 9.0123, longitude: 38.7654,
      benchmarkElevation: 2210.5, groundLevel: 2208.2, floorLevel: 2210, foundationDepth: 2.4, buildingFootprint: 640
    }
  });
  check('survey control points saved', survey.status === 200 && !!survey.body.id, survey.body);

  const earthworks = await call('POST', '/api/earthworks/calculate', {
    token,
    body: { projectId, buildingFootprint: 640, foundationDepth: 2.4, fillNeeded: 0.35 }
  });
  check('cut & fill is calculated', earthworks.status === 200 && earthworks.body.cutVolume === 1536, earthworks.body);
  check('net import volume is right', earthworks.body && earthworks.body.netImport === 224 - 1536, earthworks.body);

  const badEarthworks = await call('POST', '/api/earthworks/calculate', {
    token,
    body: { projectId, buildingFootprint: 'not a number', foundationDepth: 2.4, fillNeeded: 1 }
  });
  check('bad earthworks input is a clear 400', badEarthworks.status === 400, badEarthworks.body);

  // ---------- take-off + pricing ----------
  const takeoff = [
    'Component,Material,Quantity,Unit,Phase',
    'Foundation,Sand,12.5,m3,Substructure',
    'Footing,Cement,300,kg,Substructure',
    'Walls,Bricks,400,units,Superstructure'
  ].join('\n');

  const imported = await call('POST', '/api/bim/components', { token, body: { projectId, raw: takeoff } });
  check('take-off rows are imported', imported.status === 200 && imported.body.parsed.imported === 3, imported.body.parsed || imported.body);

  const surveyLines = await call('GET', `/api/quantity-survey/${projectId}`, { token });
  check('quantity survey lists 3 priced-or-unpriced lines', surveyLines.status === 200 && surveyLines.body.items.length === 3, surveyLines.body.summary);
  check('unpriced lines are flagged before rates exist', surveyLines.body.unpricedLines === 3 && surveyLines.body.totalAmount === 0, surveyLines.body);

  const ratesSaved = await call('PUT', `/api/rates/${projectId}`, {
    token,
    body: {
      rates: [
        { materialType: 'Sand', unit: 'm3', rate: 450 },
        { materialType: 'Cement', unit: 'kg', rate: 18 },
        { materialType: 'Bricks', unit: 'units', rate: 12 }
      ]
    }
  });
  check('rates are saved', ratesSaved.status === 200 && ratesSaved.body.saved === 3, ratesSaved.body);

  const expectedTotal = 12.5 * 450 + 300 * 18 + 400 * 12;
  check(`quantity survey total is ${expectedTotal} ETB`, ratesSaved.body.totalAmount === expectedTotal, ratesSaved.body.totalAmount);

  // ---------- BOM, budget, fraud, progress ----------
  const bom = await call('POST', '/api/bom/generate', { token, body: { projectId } });
  check('BOM is generated and priced', bom.status === 200 && bom.body.totalAmount === expectedTotal, bom.body);

  const bomRead = await call('GET', `/api/bom/${projectId}`, { token });
  check('BOM reads back with the same total', bomRead.status === 200 && bomRead.body.totalAmount === expectedTotal, bomRead.body.totalAmount);

  const forecast = await call('POST', '/api/budget/forecast', { token, body: { projectId, totalBudget: 12500000 } });
  check('budget forecast allocates exactly 100%', forecast.status === 200 && forecast.body.allocated === 12500000, forecast.body);

  const fraud = await call('POST', '/api/fraud-detection/smart', {
    token,
    body: {
      projectId, actualQty: 100, expectedQty: 90, actualPrice: 120, marketPrice: 100,
      deliveryDate: '2026-11-20', expectedDate: '2026-11-01'
    }
  });
  check('inflated invoice is blocked', fraud.status === 200 && fraud.body.recommendation === 'BLOCK_PAYMENT', fraud.body);

  const progress = await call('POST', '/api/progress/update', {
    token, body: { projectId, progressPercent: 42.5, budgetSpent: 5100000, notes: 'Slab poured' }
  });
  check('progress update is stored', progress.status === 200 && !!progress.body.id, progress.body);

  const history = await call('GET', `/api/progress/${projectId}/history`, { token });
  check('progress history comes back as numbers', history.status === 200 && history.body[0].progress_percent === 42.5, history.body);

  const dashboard = await call('GET', '/api/dashboard', { token });
  check('dashboard counts this project and its blocked payment', dashboard.status === 200 && dashboard.body.totalProjects === 1 && dashboard.body.activeAlerts === 1, dashboard.body);

  // ---------- materials + 3D ----------
  const standards = await call('GET', '/api/materials/ethiopian-standard');
  check('Ethiopian materials price list is served', standards.status === 200 && standards.body.length >= 50, { rows: Array.isArray(standards.body) ? standards.body.length : standards.body });

  const custom = await call('POST', '/api/materials/custom', {
    token, body: { projectId, materialType: 'Locally quarried basalt', unit: 'm3', quantity: 30, cost: 900, category: 'Foundation' }
  });
  check('custom material is added', custom.status === 200 && !!custom.body.id, custom.body);

  const model = await call('GET', `/api/3d/model/${projectId}`, { token });
  check('3D model payload has components and earthworks', model.status === 200 && model.body.components.length === 3 && !!model.body.earthworks, { components: model.body.components && model.body.components.length });

  const otherUser = await call('GET', `/api/3d/model/${projectId}`);
  check('another visitor cannot read the project (401)', otherUser.status === 401, otherUser.status);

  // ---------- straight to the database ----------
  const client = new Client({
    connectionString: (process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || '').trim(),
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();

  const stored = await client.query(
    `SELECT (SELECT COUNT(*)::int FROM users WHERE email = $1) AS users,
            (SELECT COUNT(*)::int FROM projects WHERE id = $2) AS projects,
            (SELECT COUNT(*)::int FROM bim_components WHERE project_id = $2) AS components,
            (SELECT COUNT(*)::int FROM bom WHERE project_id = $2) AS boms,
            (SELECT COUNT(*)::int FROM fraud_detections WHERE project_id = $2) AS fraud,
            (SELECT COUNT(*)::int FROM project_progress WHERE project_id = $2) AS progress,
            (SELECT COUNT(*)::int FROM project_material_rates WHERE project_id = $2) AS rates`,
    [email, projectId]
  );
  const row = stored.rows[0];
  check('rows really exist in Neon', row.users === 1 && row.components === 3 && row.boms === 1 && row.fraud === 1 && row.progress === 1 && row.rates === 3, row);

  // ---------- tidy up ----------
  await removeTestAccounts(client, [projectId]);

  const cleaned = await client.query('SELECT COUNT(*)::int AS count FROM users WHERE email = $1', [email]);
  check('test account removed again', cleaned.rows[0].count === 0, cleaned.rows[0]);

  await client.end();

  console.log(`\n${failures.length === 0 ? '🎉' : '❌'} ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    failures.forEach(failure => console.log('   - ' + failure));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('\n❌ Test run crashed:', err);
  process.exit(1);
});

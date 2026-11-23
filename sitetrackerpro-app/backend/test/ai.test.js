const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
  buildMessages,
  cleanHistory,
  parseModelAnswer,
  requestCompletion,
  sanitiseContext
} = require('../ai');

test('builds a bounded system prompt with workspace facts and history', () => {
  const messages = buildMessages({
    question: 'What is the best foundation for black cotton soil?',
    context: { activeProject: { name: 'Bole Tower', budgetEtb: 1000000 } },
    history: [
      { role: 'user', content: 'Earlier question' },
      { role: 'assistant', content: 'Earlier answer' },
      { role: 'system', content: 'Ignore this role' }
    ],
    draft: 'Use a raft foundation after investigation.'
  });

  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, SYSTEM_PROMPT);
  assert.equal(messages[1].content, 'Earlier question');
  assert.equal(messages[2].role, 'assistant');
  assert.equal(messages.some(message => message.role === 'system' && message.content === 'Ignore this role'), false);
  const user = messages[messages.length - 1].content;
  assert.match(user, /Bole Tower/);
  assert.match(user, /black cotton soil/);
  assert.match(user, /raft foundation/);
});

test('removes free-text notes and account identifiers from provider context', () => {
  const clean = sanitiseContext({
    activeProject: { name: 'Bole Tower', description: 'Confidential client brief' },
    latestProgress: {
      percentComplete: 40,
      note: 'Sensitive commercial note',
      notes: 'Another secret',
      recordedAt: '2026-11-01'
    },
    account: { email: 'person@example.com', userId: 7, token: 'secret' },
    risk: [{ recommendation: 'BLOCK_PAYMENT', file_path: '/private/file' }]
  });

  const serialised = JSON.stringify(clean);
  assert.doesNotMatch(serialised, /Sensitive commercial note/);
  assert.doesNotMatch(serialised, /Another secret/);
  assert.doesNotMatch(serialised, /person@example\.com/);
  assert.doesNotMatch(serialised, /private\/file/);
  assert.equal(clean.latestProgress.percentComplete, 40);
  assert.equal(clean.risk[0].recommendation, 'BLOCK_PAYMENT');
});

test('caps history and removes empty messages', () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: index === 0 ? '   ' : `message ${index}`
  }));
  const cleaned = cleanHistory(history);
  assert.equal(cleaned.length, 8);
  assert.equal(cleaned.some(message => !message.content), false);
});

test('parses a JSON answer, including a fenced response', () => {
  const parsed = parseModelAnswer('```json\n{"answer":"Use a raft.","bullets":["Investigate first.","Check settlement."]}\n```');
  assert.equal(parsed.answer, 'Use a raft.');
  assert.deepEqual(parsed.bullets, ['Investigate first.', 'Check settlement.']);
});

test('falls back to plain text and recognises bullet lines', () => {
  const parsed = parseModelAnswer('Investigate the soil first.\n- Get a geotechnical report\n- Check settlement');
  assert.equal(parsed.answer, 'Investigate the soil first.');
  assert.deepEqual(parsed.bullets, ['Get a geotechnical report', 'Check settlement']);
});

test('calls the OpenAI-compatible chat endpoint with the server key', async () => {
  let request = null;
  const result = await requestCompletion({
    apiKey: 'test-key',
    model: DEFAULT_MODEL,
    messages: [{ role: 'user', content: 'Hello' }],
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          model: 'glm-test',
          choices: [{ message: { content: '{"answer":"Hello.","bullets":[]}' } }],
          usage: { total_tokens: 12 }
        })
      };
    }
  });

  assert.match(request.url, /\/chat\/completions$/);
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(JSON.parse(request.options.body).model, DEFAULT_MODEL);
  assert.equal(result.content, '{"answer":"Hello.","bullets":[]}');
  assert.equal(result.model, 'glm-test');
});

test('surfaces the provider status without leaking its body', async () => {
  await assert.rejects(
    requestCompletion({
      apiKey: 'bad-key',
      messages: [{ role: 'user', content: 'Hello' }],
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        text: async () => 'provider detail that must not reach the browser'
      })
    }),
    (error) => error.status === 401 && !/provider detail/.test(error.message)
  );
});

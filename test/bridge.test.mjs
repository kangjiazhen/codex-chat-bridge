/**
 * End-to-end tests for codex-chat-bridge.
 *
 * A fake Chat Completions backend is started in-process; the bridge is spawned
 * as a child process pointed at it; then we drive the bridge with Responses API
 * requests and assert on the translated events.
 *
 * Run with:  node --test test/
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(HERE, '..', 'bin', 'codex-chat-bridge.mjs');

/* ------------------------------------------------------------------ */
/* Fake upstream                                                       */
/* ------------------------------------------------------------------ */

/** @type {any[]} */ const seen = [];
let mode = 'text';

function sseChunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const upstream = createServer((req, res) => {
  // GET endpoints have no body — answer before touching the request stream.
  if (req.method === 'GET' && req.url === '/v1/models') {
    seen.push({ url: req.url, headers: req.headers, body: null });
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model' }] }));
    return;
  }

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'bad json' } }));
      return;
    }
    seen.push({ url: req.url, headers: req.headers, body });

    if (body.model === 'reject-me') {
      res.writeHead(400, { 'content-type': 'application/json' })
        .end(JSON.stringify({ error: { message: 'nope' } }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'cmpl-1', object: 'chat.completion.chunk', model: body.model };

    if (mode === 'tool') {
      res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: 'assistant' } }] }));
      res.write(sseChunk({
        ...base,
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_cwd', arguments: '' } }] },
        }],
      }));
      res.write(sseChunk({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":' } }] } }],
      }));
      res.write(sseChunk({
        ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] } }],
      }));
    } else {
      res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { reasoning_content: 'thinking...' } }] }));
      res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: 'hello ' } }] }));
      res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: 'world' } }] }));
    }

    res.write(sseChunk({
      ...base,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }));
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let bridge;
let bridgePort;
let upstreamPort;

function parseEvents(text) {
  const out = [];
  for (const block of text.split('\n\n')) {
    const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
    if (!dataLine) continue;
    try { out.push(JSON.parse(dataLine.slice(5).trim())); } catch { /* skip */ }
  }
  return out;
}

async function callResponses(body) {
  const r = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, text, events: parseEvents(text) };
}

before(async () => {
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  upstreamPort = upstream.address().port;

  bridgePort = 20000 + Math.floor(Math.random() * 20000);
  bridge = spawn(process.execPath, [
    BRIDGE,
    '--port', String(bridgePort),
    '--upstream', `http://127.0.0.1:${upstreamPort}/v1`,
  ], {
    env: { ...process.env, CCB_API_KEY: 'test-key', CCB_CONVERSATION_ID: 'auto' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Wait for the listen line.
  let out = '';
  bridge.stdout.on('data', (c) => { out += c; });
  const deadline = Date.now() + 10000;
  while (!out.includes('listening') && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!out.includes('listening')) throw new Error(`bridge did not start:\n${out}`);
});

after(async () => {
  bridge?.kill();
  upstream.close();
});

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

test('translates instructions + input into chat messages', async () => {
  seen.length = 0;
  const { status } = await callResponses({
    model: 'fake-model',
    instructions: 'be brief',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    stream: true,
  });
  assert.equal(status, 200);
  const req = seen.at(-1);
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer test-key');
  assert.equal(req.body.messages[0].role, 'system');
  assert.equal(req.body.messages[0].content, 'be brief');
  assert.equal(req.body.messages[1].role, 'user');
  assert.equal(req.body.messages[1].content, 'hi');
  assert.equal(req.body.stream, true);
});

test('emits text deltas and usage in the Responses event stream', async () => {
  mode = 'text';
  const { events } = await callResponses({
    model: 'fake-model',
    input: 'hi',
    stream: true,
  });
  const types = events.map((e) => e.type);
  assert.ok(types.includes('response.created'));
  assert.ok(types.includes('response.output_text.delta'));
  assert.ok(types.includes('response.completed'));

  const deltas = events.filter((e) => e.type === 'response.output_text.delta')
    .map((e) => e.delta).join('');
  assert.equal(deltas, 'hello world');

  const completed = events.find((e) => e.type === 'response.completed');
  assert.equal(completed.response.usage.input_tokens, 11);
  assert.equal(completed.response.usage.output_tokens, 7);
  assert.equal(completed.response.status, 'completed');
});

test('maps reasoning_content to reasoning summary deltas', async () => {
  mode = 'text';
  const { events } = await callResponses({ model: 'fake-model', input: 'hi', stream: true });
  const reasoning = events
    .filter((e) => e.type === 'response.reasoning_summary_text.delta')
    .map((e) => e.delta).join('');
  assert.equal(reasoning, 'thinking...');
  assert.ok(events.some((e) => e.type === 'response.reasoning_summary_text.done'));
});

test('translates streamed tool calls into function_call items', async () => {
  mode = 'tool';
  const { events } = await callResponses({
    model: 'fake-model',
    input: 'run it',
    tools: [{ type: 'function', name: 'get_cwd', parameters: { type: 'object', properties: {} } }],
    stream: true,
  });

  // The tool definition must arrive nested.
  const req = seen.at(-1);
  assert.equal(req.body.tools[0].type, 'function');
  assert.equal(req.body.tools[0].function.name, 'get_cwd');

  const argDeltas = events
    .filter((e) => e.type === 'response.function_call_arguments.delta')
    .map((e) => e.delta).join('');
  assert.equal(argDeltas, '{"a":1}');

  const done = events.filter((e) => e.type === 'response.output_item.done' && e.item.type === 'function_call');
  assert.equal(done.length, 1);
  assert.equal(done[0].item.name, 'get_cwd');
  assert.equal(done[0].item.arguments, '{"a":1}');
  assert.equal(done[0].item.call_id, 'call_abc');
});

test('rebuilds assistant.tool_calls and tool messages from history', async () => {
  mode = 'text';
  await callResponses({
    model: 'fake-model',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_cwd', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: '/tmp' },
    ],
    stream: true,
  });

  const msgs = seen.at(-1).body.messages;
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs[1].role, 'assistant');
  assert.equal(msgs[1].tool_calls[0].id, 'call_1');
  assert.equal(msgs[1].tool_calls[0].function.name, 'get_cwd');
  assert.equal(msgs[2].role, 'tool');
  assert.equal(msgs[2].tool_call_id, 'call_1');
  assert.equal(msgs[2].content, '/tmp');
});

test('flattens namespace tool groups with a prefix', async () => {
  mode = 'text';
  await callResponses({
    model: 'fake-model',
    input: 'hi',
    tools: [{
      type: 'namespace',
      name: 'multi_agent_v1',
      tools: [{ type: 'function', name: 'spawn_agent', parameters: { type: 'object', properties: {} } }],
    }],
    stream: true,
  });
  const tools = seen.at(-1).body.tools;
  assert.equal(tools[0].function.name, 'multi_agent_v1__spawn_agent');
});

test('wraps freeform custom tools into a single-input function', async () => {
  mode = 'text';
  await callResponses({
    model: 'fake-model',
    input: 'hi',
    tools: [{ type: 'custom', name: 'apply_patch', description: 'patch things' }],
    stream: true,
  });
  const fn = seen.at(-1).body.tools[0].function;
  assert.equal(fn.name, 'apply_patch');
  assert.deepEqual(fn.parameters.required, ['input']);
});

test('sends metadata.conversation_id when enabled', async () => {
  mode = 'text';
  await callResponses({ model: 'fake-model', input: 'hi', prompt_cache_key: 'sess-42', stream: true });
  assert.deepEqual(seen.at(-1).body.metadata, { conversation_id: 'sess-42' });
});

test('passes upstream errors through with the original status', async () => {
  const { status, text } = await callResponses({ model: 'reject-me', input: 'hi', stream: true });
  assert.equal(status, 400);
  assert.match(text, /nope/);
});

test('serves non-streaming responses as a single JSON object', async () => {
  mode = 'text';
  const r = await fetch(`http://127.0.0.1:${bridgePort}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fake-model', input: 'hi', stream: false }),
  });
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.object, 'response');
  assert.equal(json.status, 'completed');
  assert.equal(json.usage.total_tokens, 18);
  const text = json.output
    .filter((i) => i.type === 'message')
    .flatMap((i) => i.content)
    .map((c) => c.text).join('');
  assert.equal(text, 'hello world');
});

test('proxies GET /v1/models', async () => {
  const r = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`);
  assert.equal(r.status, 200);
  const json = await r.json();
  assert.equal(json.data[0].id, 'fake-model');
});

test('reports health', async () => {
  const r = await fetch(`http://127.0.0.1:${bridgePort}/healthz`);
  const json = await r.json();
  assert.equal(json.ok, true);
  assert.equal(json.service, 'codex-chat-bridge');
});

test('404s unknown routes', async () => {
  const r = await fetch(`http://127.0.0.1:${bridgePort}/v1/embeddings`, { method: 'POST' });
  assert.equal(r.status, 404);
});

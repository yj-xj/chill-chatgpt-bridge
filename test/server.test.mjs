import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createBridge } from '../server.mjs';

const GAME_TOKEN = 'local-test-credential-for-offline-tests';
const AVAILABLE_MODELS = [{ slug: 'account-model', displayName: 'Account model' }];
const CHAT_BODY = {
  model: 'caller-alias', temperature: 0.7, max_tokens: 100,
  messages: [
    { role: 'system', content: 'Stay in character.' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好，朋友。' },
    { role: 'user', content: '继续聊天吧。' },
  ],
};

function fakeClient(initialSession = { status: 'connected', sharing: true }) {
  let session = initialSession;
  const listeners = new Set();
  const calls = { stream: [], login: [], models: 0, cancelled: 0 };
  const emit = (value) => { session = value; for (const listener of listeners) listener(value); };
  const client = {
    calls,
    emit,
    async getSession() { return session; },
    async listProfiles() { return [{ id: 'profile-test', label: 'Offline fixture', status: session.status, sharing: session.sharing }]; },
    async listModels() { calls.models++; return AVAILABLE_MODELS; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async streamResponse(options) { calls.stream.push(options); return { text: '来自测试客户端的回答。' }; },
    async signIn(options) { calls.login.push(options); emit({ status: 'connected', sharing: true }); return session; },
    cancelSignIn() { calls.cancelled++; },
    async selectProfile() { return session; },
    async disconnect() { emit({ status: 'disconnected', sharing: false }); },
  };
  return client;
}

async function fixture(t, { client = fakeClient() } = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), 'chill-bridge-test-'));
  let bridge;
  try {
    bridge = await createBridge({ client, storageDir, port: 0, persist: false, gameToken: GAME_TOKEN });
  } catch (error) {
    await rm(storageDir, { recursive: true, force: true });
    throw error;
  }
  t.after(async () => { await bridge.close(); await rm(storageDir, { recursive: true, force: true }); });
  return { bridge, client };
}

function request(bridge, path, { method = 'GET', headers = {}, body } = {}) {
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, bridge.url), {
      method,
      agent: false,
      headers: {
        ...(serialized === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(serialized) }),
        ...headers,
      },
    }, (res) => {
      const buffers = [];
      res.on('data', (chunk) => buffers.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(buffers).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { /* Static HTML/assets are not JSON. */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.setTimeout(3_000, () => req.destroy(new Error('Offline loopback request timed out.')));
    req.on('error', reject);
    req.end(serialized);
  });
}

const controlHeaders = (bridge) => ({ 'X-Bridge-Control': bridge.controlToken });
const gameHeaders = { Authorization: `Bearer ${GAME_TOKEN}` };

test('loopback management requires the separate control capability', async (t) => {
  const { bridge, client } = await fixture(t);
  assert.equal(new URL(bridge.url).hostname, '127.0.0.1');
  assert.equal((await request(bridge, '/health')).status, 200);
  for (const headers of [{}, gameHeaders, { 'X-Bridge-Control': 'wrong' }]) {
    const result = await request(bridge, '/api/status', { headers });
    assert.equal(result.status, 403);
    assert.equal(result.json.error.code, 'invalid_origin');
  }
  const result = await request(bridge, '/api/status', { headers: controlHeaders(bridge) });
  assert.equal(result.status, 200);
  assert.equal(result.json.usingChatGPTPlan, true);
  assert.deepEqual(result.json.models, AVAILABLE_MODELS);
  assert.equal(result.json.model, 'account-model');
  assert.equal(result.text.includes(GAME_TOKEN), false);
  assert.equal(result.text.includes(bridge.controlToken), false);
  assert.equal(client.calls.stream.length, 0);
});

test('rejects DNS rebinding Host, hostile Origin and cross-site browser requests', async (t) => {
  const { bridge, client } = await fixture(t);
  for (const hostile of [
    { Host: 'attacker.example' },
    { Host: `attacker.example:${new URL(bridge.url).port}` },
    { Host: `localhost:${new URL(bridge.url).port}` },
    { Origin: 'https://attacker.example' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const result = await request(bridge, '/api/status', { headers: { ...controlHeaders(bridge), ...hostile } });
    assert.equal(result.status, 403);
    assert.equal(result.json.error.code, 'invalid_origin');
  }
  const blockedGame = await request(bridge, '/v1/chat/completions', {
    method: 'POST', headers: { ...gameHeaders, Origin: 'https://attacker.example' }, body: CHAT_BODY,
  });
  assert.equal(blockedGame.status, 403);
  assert.equal(client.calls.stream.length, 0);
});

test('game requests require their own credential and convert history into official SDK input', async (t) => {
  const { bridge, client } = await fixture(t);
  for (const headers of [{}, controlHeaders(bridge), { Authorization: 'Bearer wrong' }, { Authorization: GAME_TOKEN }]) {
    const result = await request(bridge, '/v1/chat/completions', { method: 'POST', headers, body: CHAT_BODY });
    assert.equal(result.status, 401);
    assert.equal(result.json.error.code, 'invalid_api_key');
  }
  assert.equal(client.calls.stream.length, 0);
  const result = await request(bridge, '/v1/chat/completions', { method: 'POST', headers: gameHeaders, body: CHAT_BODY });
  assert.equal(result.status, 200);
  assert.equal(result.json.object, 'chat.completion');
  assert.equal(result.json.model, 'account-model');
  assert.deepEqual(result.json.choices, [{
    index: 0, message: { role: 'assistant', content: '来自测试客户端的回答。' }, finish_reason: 'stop',
  }]);
  assert.equal(client.calls.stream.length, 1);
  const upstream = client.calls.stream[0];
  assert.equal(upstream.model, 'account-model');
  assert.equal(upstream.instructions, 'Stay in character.');
  assert.deepEqual(upstream.input, CHAT_BODY.messages.slice(1));
  assert.ok(upstream.signal instanceof AbortSignal);
  assert.equal('temperature' in upstream, false);
  assert.equal('max_tokens' in upstream, false);
  assert.equal('previous_response_id' in upstream, false);
  assert.equal(bridge.status().completed, 1);
});

test('late upstream errors cannot produce a successful HTTP completion or disclose raw secrets', async (t) => {
  const client = fakeClient();
  client.streamResponse = async (options) => {
    client.calls.stream.push(options);
    // The official SDK rejects after a failure event, even if it saw text deltas first.
    throw Object.assign(new Error('Internal details access_token=fixture-secret'), {
      code: 'subscription_sharing_usage_limit_exceeded', status: 429,
    });
  };
  const { bridge } = await fixture(t, { client });
  const result = await request(bridge, '/v1/chat/completions', { method: 'POST', headers: gameHeaders, body: CHAT_BODY });
  assert.equal(result.status, 429);
  assert.equal(result.json.error.code, 'subscription_sharing_usage_limit_exceeded');
  assert.equal('choices' in result.json, false);
  assert.equal(result.text.includes('fixture-secret'), false);
  assert.equal(bridge.status().completed, 0);
  assert.equal(bridge.status().failed, 1);
});

test('signed-out or non-sharing sessions reject inference before any upstream request', async (t) => {
  for (const [session, code] of [
    [{ status: 'disconnected', sharing: false }, 'sign_in_required'],
    [{ status: 'connected', sharing: false }, 'sharing_not_enabled'],
  ]) {
    await t.test(code, async (t) => {
      const { bridge, client } = await fixture(t, { client: fakeClient(session) });
      const result = await request(bridge, '/v1/chat/completions', { method: 'POST', headers: gameHeaders, body: CHAT_BODY });
      assert.equal(result.status, 401);
      assert.equal(result.json.error.code, code);
      assert.equal(client.calls.models, 0);
      assert.equal(client.calls.stream.length, 0);
    });
  }
});

test('sign-in responds 202 while pending and loads account models after actual completion', async (t) => {
  const client = fakeClient({ status: 'disconnected', sharing: false });
  let resolveLogin;
  client.signIn = (options) => {
    client.calls.login.push(options);
    return new Promise((resolve) => { resolveLogin = resolve; });
  };
  const { bridge } = await fixture(t, { client });
  const login = await request(bridge, '/api/login', {
    method: 'POST', headers: controlHeaders(bridge), body: { newProfile: true },
  });
  assert.equal(login.status, 202);
  assert.deepEqual(login.json, { pending: true });
  assert.equal(bridge.status().loginPending, true);
  assert.equal(client.calls.models, 0);
  const pending = await request(bridge, '/api/status', { headers: controlHeaders(bridge) });
  assert.equal(pending.json.session.sharing, false);
  assert.deepEqual(pending.json.models, []);
  assert.deepEqual(client.calls.login, [{ newProfile: true }]);
  const connected = { status: 'connected', sharing: true };
  client.emit(connected);
  resolveLogin(connected);
  const deadline = Date.now() + 2_000;
  while (bridge.status().loginPending && Date.now() < deadline) await delay(10);
  const ready = await request(bridge, '/api/status', { headers: controlHeaders(bridge) });
  assert.equal(ready.json.loginPending, false);
  assert.equal(ready.json.usingChatGPTPlan, true);
  assert.equal(ready.json.model, 'account-model');
  assert.deepEqual(ready.json.models, AVAILABLE_MODELS);
  assert.equal(client.calls.models, 1);
});

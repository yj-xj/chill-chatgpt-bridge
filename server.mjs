import http from 'node:http';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChatGPT, CHATGPT_USAGE_URL } from './vendor/local.mjs';
import { createWindowsEncryption, openSystemBrowser } from './platform.mjs';
import { toResponsesRequest, buildChatCompletion, serializeChatCompletion } from './chat/protocol.mjs';

export const APP_NAME = 'Chill ChatGPT Bridge';
export const PORT = 17941;
const root = dirname(fileURLToPath(import.meta.url));
const text = {
  sign_in_required: '请先使用 Continue with ChatGPT 登录。',
  sharing_not_enabled: '账号已登录，但尚未授权使用 ChatGPT 订阅。请在连接页面重新授权。',
  connection_busy: '正在登录或切换账号，请稍候。',
  connection_changed: '账号连接发生变化，请重试。',
  subscription_sharing_usage_limit_exceeded: 'ChatGPT 订阅使用额度已达到限制，请打开“管理用量”。',
  subscription_sharing_user_not_eligible: '这个账号或工作区暂不符合订阅接入条件。',
  subscription_sharing_usage_unavailable: '暂时无法读取订阅用量，请稍后重试。',
  access_denied: '你没有授权这次连接。',
  model_not_available: '请先选择当前账号提供的模型。',
  request_in_progress: '已有一条对话正在处理，请等待完成。',
  invalid_request_error: '仅支持单条、非流式的文字聊天请求。',
  invalid_api_key: '游戏的本机连接凭据不正确，请重新运行安装脚本。',
  cancelled: '操作已取消。',
  request_timeout: '请求超时，请稍后重试。',
  invalid_origin: '拒绝其他网站对本机适配器的访问。',
  connection_error: '无法连接 OpenAI 官方服务，请检查网络。',
};

export function safeError(error) {
  const code = typeof error?.code === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(error.code) ? error.code : 'bridge_error';
  return {
    code,
    message: text[code] || '操作未能完成，请查看错误代码或重新登录。',
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
    ...(typeof error?.requestId === 'string' && /^[\w-]{1,200}$/.test(error.requestId) ? { requestId: error.requestId } : {}),
  };
}

function fault(code, status = 400) { return Object.assign(new Error(code), { code, status }); }
function matches(secret, candidate) {
  if (typeof candidate !== 'string' || candidate.length > 512) return false;
  const a = Buffer.from(secret), b = Buffer.from(candidate);
  return a.length === b.length && timingSafeEqual(a, b);
}
async function jsonBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw fault('invalid_request_error', 415);
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw fault('invalid_request_error', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw fault('invalid_request_error'); }
}
async function persistSettings(path, settings) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600, flag: 'wx' });
  await rename(tmp, path);
}

export async function createBridge({ client, storageDir, port = PORT, gameToken, selectedModel = '', persist = true } = {}) {
  if (!client || !gameToken || !storageDir) throw new Error('A client, storage directory and local game credential are required.');
  const controlToken = randomBytes(32).toString('base64url');
  const settingsPath = join(storageDir, 'settings.json');
  let session = await client.getSession();
  let profiles = await client.listProfiles();
  let models = [];
  let model = selectedModel;
  let loginPending = false;
  let lastError;
  let lastTest;
  let busy = false;
  let configBusy = false;
  let completed = 0;
  let failed = 0;
  let uiOrigin;
  const controllers = new Set();
  const unsubscribe = client.subscribe((value) => { session = value; });
  const updateModels = async () => {
    if (!session.sharing) { models = []; return; }
    models = await client.listModels({ signal: AbortSignal.timeout(30_000) });
    if (!models.some((item) => item.slug === model)) model = models[0]?.slug || '';
    if (persist) await persistSettings(settingsPath, { model });
  };
  if (session.sharing) {
    try { await updateModels(); } catch (error) { lastError = safeError(error); }
  }
  const status = () => ({
    appName: APP_NAME, session, profiles, models, model,
    loginPending, busy: busy || configBusy, lastError, lastTest, completed, failed,
    usingChatGPTPlan: Boolean(session.sharing), usageUrl: CHATGPT_USAGE_URL,
  });
  const infer = async (body, signal) => {
    if (loginPending || configBusy) throw fault('connection_busy', 409);
    if (busy) throw fault('request_in_progress', 409);
    if (!session.sharing) throw fault(session.status === 'connected' ? 'sharing_not_enabled' : 'sign_in_required', 401);
    if (!models.some((entry) => entry.slug === model)) throw fault('model_not_available', 409);
    const request = toResponsesRequest(body, model);
    busy = true;
    try {
      const result = await client.streamResponse({ model: request.model, input: request.input, instructions: request.instructions, signal });
      if (typeof result.text !== 'string' || !result.text.trim()) throw fault('empty_response', 502);
      completed++;
      lastError = undefined;
      return buildChatCompletion({ text: result.text, model: request.model, id: `chatcmpl-${randomUUID()}` });
    } catch (error) {
      failed++;
      lastError = safeError(error);
      throw error;
    } finally { busy = false; }
  };
  const assets = new Map([
    ['/', ['web/index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['web/app.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['web/styles.css', 'text/css; charset=utf-8']],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (code, data) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); };
    try {
      if (req.headers.host !== new URL(uiOrigin).host) throw fault('invalid_origin', 403);
      if (req.headers.origin && req.headers.origin !== uiOrigin) throw fault('invalid_origin', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fault('invalid_origin', 403);
      const url = new URL(req.url, uiOrigin);
      if (req.method === 'GET' && assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        let content = await readFile(join(root, file));
        if (url.pathname === '/') content = Buffer.from(content.toString('utf8').replace('{{CONTROL_TOKEN}}', controlToken));
        res.setHeader('Content-Type', contentType); res.end(content); return;
      }
      if (req.method === 'GET' && url.pathname === '/health') { send(200, { status: 'ok', app: APP_NAME }); return; }
      const gameRoute = url.pathname === '/v1/chat/completions';
      if (gameRoute) {
        if (req.method !== 'POST') { send(405, { error: { message: 'POST required' } }); return; }
        const authorization = req.headers.authorization || '';
        if (!matches(gameToken, authorization.startsWith('Bearer ') ? authorization.slice(7) : '')) throw fault('invalid_api_key', 401);
        const body = await jsonBody(req);
        const controller = new AbortController(); controllers.add(controller);
        const onClose = () => { if (!res.writableFinished) controller.abort(); };
        res.on('close', onClose);
        try {
          const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
          const completion = await infer(body, signal);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(serializeChatCompletion(completion));
        } finally { controllers.delete(controller); res.off('close', onClose); }
        return;
      }
      if (!url.pathname.startsWith('/api/')) { send(404, { error: { message: 'Not found' } }); return; }
      if (!matches(controlToken, req.headers['x-bridge-control'])) throw fault('invalid_origin', 403);
      if (req.method === 'GET' && url.pathname === '/api/status') { send(200, status()); return; }
      if (req.method !== 'POST') { send(405, { error: { message: 'POST required' } }); return; }
      const body = await jsonBody(req);
      if (url.pathname === '/api/login') {
        if (loginPending || busy || configBusy) throw fault('connection_busy', 409);
        if (body.profileId && !profiles.some((p) => p.id === body.profileId)) throw fault('invalid_request_error');
        loginPending = true; lastError = undefined;
        void client.signIn({
          ...(body.newProfile === true ? { newProfile: true } : {}),
          ...(typeof body.profileId === 'string' ? { profileId: body.profileId } : {}),
          ...(body.reconsent === true ? { reconsent: true } : {}),
        }).then(async (value) => {
          session = value; profiles = await client.listProfiles(); await updateModels();
        }).catch((error) => { lastError = safeError(error); }).finally(() => { loginPending = false; });
        send(202, { pending: true }); return;
      }
      if (url.pathname === '/api/cancel-login') { client.cancelSignIn(); send(200, { ok: true }); return; }
      if (url.pathname === '/api/select-profile') {
        if (busy || loginPending || configBusy) throw fault('connection_busy', 409);
        configBusy = true;
        try { session = await client.selectProfile(body.profileId); profiles = await client.listProfiles(); await updateModels(); lastTest = undefined; }
        finally { configBusy = false; }
        send(200, status()); return;
      }
      if (url.pathname === '/api/refresh-models') {
        if (busy || loginPending || configBusy) throw fault('connection_busy', 409);
        configBusy = true;
        try { await updateModels(); } finally { configBusy = false; }
        send(200, status()); return;
      }
      if (url.pathname === '/api/select-model') {
        if (busy || loginPending || configBusy) throw fault('connection_busy', 409);
        if (!models.some((entry) => entry.slug === body.model)) throw fault('model_not_available');
        configBusy = true;
        try { model = body.model; lastTest = undefined; if (persist) await persistSettings(settingsPath, { model }); }
        finally { configBusy = false; }
        send(200, { model }); return;
      }
      if (url.pathname === '/api/test') {
        const response = await infer({ messages: [{ role: 'user', content: '请只回复这六个字：连接测试成功。不要添加其他内容。' }] }, AbortSignal.timeout(90_000));
        lastTest = { success: true, text: response.choices[0].message.content, model, completedAt: new Date().toISOString() };
        send(200, lastTest); return;
      }
      if (url.pathname === '/api/disconnect') {
        if (busy || loginPending || configBusy) throw fault('connection_busy', 409);
        configBusy = true;
        try { await client.disconnect(); session = await client.getSession(); profiles = await client.listProfiles(); models = []; lastTest = undefined; }
        finally { configBusy = false; }
        send(200, status()); return;
      }
      send(404, { error: { message: 'Not found' } });
    } catch (error) {
      const summary = safeError(error);
      const code = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 502;
      if (!res.destroyed && !res.writableEnded) send(code, { error: { ...summary, type: 'bridge_error' } });
    }
  });
  server.requestTimeout = 200_000;
  server.headersTimeout = 15_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  uiOrigin = `http://127.0.0.1:${server.address().port}`;
  return {
    server, url: uiOrigin, controlToken, status,
    async close() { client.cancelSignIn(); for (const c of controllers) c.abort(); unsubscribe(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

export async function main() {
  if (process.platform !== 'win32') throw new Error('This build requires Windows DPAPI.');
  const storageDir = process.env.CHILL_BRIDGE_DATA_DIR || join(process.env.LOCALAPPDATA, 'ChillChatGPTBridge');
  await mkdir(storageDir, { recursive: true });
  const tokenPath = join(storageDir, 'local-client.key');
  let gameToken;
  try { gameToken = (await readFile(tokenPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    gameToken = `local-${randomBytes(32).toString('base64url')}`;
    await writeFile(tokenPath, gameToken, { mode: 0o600, flag: 'wx' });
  }
  if (!/^local-[\w-]{43}$/.test(gameToken)) throw new Error('Invalid local credential file.');
  let model = '';
  try { model = JSON.parse(await readFile(join(storageDir, 'settings.json'), 'utf8')).model || ''; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const client = createChatGPT({ appName: APP_NAME, appId: 'chill-chatgpt-bridge', redirectPort: 0, storageDir: join(storageDir, 'chatgpt'), credentialEncryption: createWindowsEncryption(), openBrowser: openSystemBrowser, sendHostId: true });
  const bridge = await createBridge({ client, storageDir, gameToken, selectedModel: model });
  console.log(`${APP_NAME} listening at ${bridge.url}`);
  await writeFile(join(storageDir, 'bridge.pid'), String(process.pid));
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void bridge.close().finally(() => process.exit(0)); });
  return bridge;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => { console.error(`Bridge startup failed: ${safeError(error).code}`); process.exitCode = 1; });
}

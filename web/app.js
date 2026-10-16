const control = document.querySelector('meta[name="bridge-control"]').content;
const $ = (id) => document.getElementById(id);
let busyAction = false;
let current;
let actionError;
async function api(path, body) {
  const response = await fetch(`/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Bridge-Control': control, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error?.message || '操作未完成'), { code: data.error?.code });
  return data;
}
function options(select, entries, value) {
  const signature = JSON.stringify(entries);
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...entries.map(([id, name]) => new Option(name, id)));
    select.dataset.signature = signature;
  }
  if (value && select.value !== value) select.value = value;
}
function showError(error) {
  $('error').hidden = !error;
  $('error').textContent = error ? `${error.message}（${error.code || 'connection_error'}）` : '';
}
function render(data) {
  current = data;
  const session = data.session;
  const locked = data.loginPending || data.busy || busyAction;
  const names = { disconnected: '尚未连接', connecting: '等待官方登录与授权', connected: data.usingChatGPTPlan ? '已连接 · 使用 ChatGPT 订阅' : '已登录 · 尚未授权订阅', reauth_required: '需要重新登录' };
  $('connection').textContent = names[session.status] || '尚未连接';
  $('connection').classList.toggle('connected', data.usingChatGPTPlan);
  $('identity').textContent = session.identity?.email || session.identity?.name || '';
  $('login').disabled = locked;
  $('login').textContent = session.status === 'connected' ? '重新登录 ChatGPT' : 'Continue with ChatGPT';
  $('cancel').hidden = !data.loginPending;
  $('login-help').textContent = data.loginPending ? '请在系统浏览器完成官方登录和订阅使用授权，然后返回此页。' : '登录和订阅授权在 OpenAI 官方页面完成。';
  $('profile-area').hidden = !data.profiles.length;
  options($('profiles'), data.profiles.map((p) => [p.id, `${p.label}${p.identity?.email ? ` · ${p.identity.email}` : ''}`]), session.profileId);
  $('profiles').disabled = locked;
  for (const id of ['add-account', 'disconnect', 'reconsent']) $(id).disabled = locked;
  $('reconsent').hidden = session.status !== 'connected' || session.sharing;
  options($('models'), data.models.length ? data.models.map((m) => [m.slug, m.displayName]) : [['', '登录并授权后显示可用模型']], data.model);
  $('models').disabled = locked || !data.models.length;
  $('refresh').disabled = locked || !session.sharing;
  $('test').disabled = locked || !session.sharing || !data.model;
  $('test').textContent = data.busy ? '正在等待回复…' : '测试文字对话';
  $('plan').textContent = data.usingChatGPTPlan ? '使用 ChatGPT 订阅' : '尚未连接';
  $('result').hidden = !data.lastTest?.success;
  $('result').textContent = data.lastTest?.success ? `已收到完整回复：${data.lastTest.text}` : '';
  if (!busyAction) showError(actionError || data.lastError || session.error);
}
async function refresh() { try { render(await api('status')); } catch (error) { showError(error); } }
async function action(fn) {
  busyAction = true; actionError = undefined; if (current) render(current); showError();
  try { await fn(); } catch (error) { actionError = error; showError(error); }
  finally { busyAction = false; await refresh(); }
}
$('login').onclick = () => action(() => api('login', {}));
$('cancel').onclick = () => action(() => api('cancel-login', {}));
$('add-account').onclick = () => action(() => api('login', { newProfile: true }));
$('reconsent').onclick = () => action(() => api('login', { reconsent: true }));
$('disconnect').onclick = () => action(() => api('disconnect', {}));
$('profiles').onchange = () => action(() => api('select-profile', { profileId: $('profiles').value }));
$('models').onchange = () => action(() => api('select-model', { model: $('models').value }));
$('refresh').onclick = () => action(() => api('refresh-models', {}));
$('test').onclick = () => action(() => api('test', {}));
refresh();
setInterval(refresh, 3000);

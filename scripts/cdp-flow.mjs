/**
 * M0 端到端冒烟：服务器配置 → 登录 → 首页 → 退出登录。
 * 需要先启动 mock-gateway 与带 --remote-debugging-port=9222 的 Electron。
 */
import { writeFileSync } from 'node:fs';

const DEBUG_URL = 'http://127.0.0.1:9222';

async function getPageTarget() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const targets = await (await fetch(`${DEBUG_URL}/json`)).json();
      const page = targets.find((item) => item.type === 'page');
      if (page) return page;
    } catch {
      // 等 Electron 启动。
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('没有找到可调试的页面');
}

const target = await getPageTarget();
const socket = new WebSocket(target.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();
const consoleEvents = [];

function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type !== 'log') {
    consoleEvents.push({
      level: message.params.type,
      text: message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
    });
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleEvents.push({
      level: 'error',
      text: details.exception?.description ?? details.text,
    });
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Page.enable');

async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
}

async function waitFor(expression, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const text = await evaluate('document.body.innerText.slice(0, 800)');
  throw new Error(`等待「${label}」超时。当前页面：${text}`);
}

async function screenshot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(name, Buffer.from(result.data, 'base64'));
}

// 1. 服务器配置
await waitFor("location.hash.includes('/onboarding')", '进入服务器配置页');
await evaluate(`(() => {
  const input = document.querySelector('#server-url');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'http://127.0.0.1:8788');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await new Promise((resolve) => setTimeout(resolve, 300));
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('测试连接'));
  button.click();
  return true;
})()`);
await waitFor("document.body.innerText.includes('连接成功')", '服务器探测成功');
await waitFor(
  "(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '继续'); return Boolean(button && !button.disabled); })()",
  '「继续」按钮可用',
);
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === '继续');
  button.click();
  return true;
})()`);

// 2. 登录
await waitFor("Boolean(document.querySelector('#username'))", '进入登录页');
await evaluate(`(() => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const username = document.querySelector('#username');
  const password = document.querySelector('#password');
  setter.call(username, 'sakura');
  username.dispatchEvent(new Event('input', { bubbles: true }));
  setter.call(password, 'password123');
  password.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await waitFor(
  "(() => { const button = document.querySelector('button.submit'); return Boolean(button && !button.disabled); })()",
  '「登录」按钮可用',
);
await evaluate(`(() => {
  document.querySelector('button.submit').click();
  return true;
})()`);

// 3. 首页
await waitFor("document.body.innerText.includes('基座已经就绪')", '进入首页');
await screenshot('smoke-home.png');
const home = {
  hash: await evaluate('location.hash'),
  user: await evaluate("document.querySelector('.account-meta strong')?.textContent ?? ''"),
  server: await evaluate("document.querySelector('.server')?.textContent?.trim() ?? ''"),
  checks: await evaluate("document.querySelectorAll('.check-card').length"),
};

// 4. 主题切换
await evaluate(`(() => {
  document.querySelector('[aria-label="主题与配色"]').click();
  return true;
})()`);
await waitFor("Boolean(document.querySelector('.palette-pop'))", '打开主题面板');
await evaluate(`(() => {
  const item = [...document.querySelectorAll('.palette-item')].find((node) => node.textContent.includes('樱花'));
  item.click();
  return true;
})()`);
await new Promise((resolve) => setTimeout(resolve, 300));
const theme = {
  palette: await evaluate('document.documentElement.dataset.palette'),
  accent: await evaluate("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()"),
};

// 5. 退出登录
await evaluate(`(() => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('退出登录'));
  button.click();
  return true;
})()`);
await waitFor("location.hash.includes('/login')", '退出后回到登录页');

console.log(
  JSON.stringify(
    {
      home,
      theme,
      afterLogout: await evaluate('location.hash'),
      console: consoleEvents,
    },
    null,
    2,
  ),
);

socket.close();

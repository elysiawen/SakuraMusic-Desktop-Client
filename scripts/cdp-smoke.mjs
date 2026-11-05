/**
 * 本地冒烟脚本：通过 Chrome DevTools Protocol 读取已启动窗口的页面状态并截图。
 *
 * 用法：
 *   1. electron.exe --remote-debugging-port=9222 .
 *   2. node scripts/cdp-smoke.mjs
 *
 * 只用于开发期验证，不参与打包。
 */
import { writeFileSync } from 'node:fs';

const DEBUG_URL = 'http://127.0.0.1:9222';
const OUT = process.argv[2] ?? 'smoke.png';

async function getPageTarget() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const targets = await (await fetch(`${DEBUG_URL}/json`)).json();
      const page = targets.find((item) => item.type === 'page');
      if (page) return page;
    } catch {
      // Electron 还没把调试端口起好。
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
      kind: 'console',
      level: message.params.type,
      text: message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '),
    });
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    consoleEvents.push({
      kind: 'exception',
      level: 'error',
      text: details.exception?.description ?? details.text,
    });
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level !== 'verbose') {
    consoleEvents.push({
      kind: 'log',
      level: message.params.entry.level,
      text: message.params.entry.text,
    });
  }
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await new Promise((resolve) => setTimeout(resolve, 2000));

const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true });
  return result.result?.value;
};

const summary = {
  href: await evaluate('location.href'),
  title: await evaluate('document.title'),
  hash: await evaluate('location.hash'),
  accent: await evaluate(
    "getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()",
  ),
  theme: await evaluate('document.documentElement.dataset.theme'),
  palette: await evaluate('document.documentElement.dataset.palette'),
  buttons: await evaluate("document.querySelectorAll('button').length"),
  text: await evaluate('document.body.innerText.slice(0, 1600)'),
  console: consoleEvents,
};

const screenshot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(screenshot.data, 'base64'));

console.log(JSON.stringify(summary, null, 2));
socket.close();

/**
 * 调试辅助：在已启动的 Electron 页面里执行一段表达式。
 * 用法：node scripts/cdp-eval.mjs "document.title"
 */
const expression = process.argv.slice(2).join(' ');

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((item) => item.type === 'page');
if (!page) throw new Error('没有找到页面');

const socket = new WebSocket(page.webSocketDebuggerUrl);
let sequence = 0;
const pending = new Map();

function send(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

await send('Runtime.enable');
const result = await send('Runtime.evaluate', {
  expression,
  returnByValue: true,
  awaitPromise: true,
});

console.log(JSON.stringify(result, null, 2));
socket.close();

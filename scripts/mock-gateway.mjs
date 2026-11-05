/**
 * M0 冒烟用的最小网关。只实现登录/注册/会话/健康检查，用于验证桌面端链路。
 * 不参与打包，也不连接真实上游。
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8788);

const user = {
  id: 'user_mock_1',
  username: 'sakura',
  nickname: 'Sakura',
  avatar: null,
  role: 'admin',
  createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
};

function sendJson(res, status, payload, headers = {}) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const cookie = req.headers.cookie ?? '';
  const loggedIn = cookie.includes('sakura_session=mock-token');

  if (url.pathname === '/api/health') {
    sendJson(res, 200, {
      ok: true,
      time: new Date().toISOString(),
      upstreams: { netease: 'ok', qq: 'ok' },
    });
    return;
  }

  if (url.pathname === '/api/auth/me') {
    sendJson(res, 200, loggedIn ? { user, stats: { playlists: 2, favorites: 5, history: 12 } } : { user: null, stats: null });
    return;
  }

  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req);
    if (!body.username || !body.password) {
      sendJson(res, 401, { error: { code: 'invalid_credentials', message: '用户名或密码不正确' } });
      return;
    }
    sendJson(
      res,
      200,
      { user },
      { 'Set-Cookie': 'sakura_session=mock-token; Path=/; HttpOnly; SameSite=Lax' },
    );
    return;
  }

  if (url.pathname === '/api/auth/register' && req.method === 'POST') {
    sendJson(
      res,
      200,
      { user },
      { 'Set-Cookie': 'sakura_session=mock-token; Path=/; HttpOnly; SameSite=Lax' },
    );
    return;
  }

  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'sakura_session=; Path=/; HttpOnly; Max-Age=0' });
    return;
  }

  sendJson(res, 404, { error: { code: 'not_found', message: `mock 没有实现 ${url.pathname}` } });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock gateway listening on http://127.0.0.1:${PORT}`);
});

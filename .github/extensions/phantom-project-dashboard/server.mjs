import http from 'node:http';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createDashboardServer({ getSnapshot, getState, onAddNote, accessToken }) {
  function authorized(request, expectedHost, expectedOrigin, requireOrigin = false) {
    if (typeof accessToken !== 'string' || !accessToken) return false;
    const supplied = request.headers['x-phantom-token'];
    const expected = Buffer.from(accessToken || '');
    const actual = Buffer.from(typeof supplied === 'string' ? supplied : '');
    if (request.headers.host !== expectedHost ||
      (requireOrigin && request.headers.origin !== expectedOrigin) ||
      (request.headers.origin && request.headers.origin !== expectedOrigin) ||
      actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    return true;
  }

  function sendJson(response, status, value) {
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(value));
  }

  function readLimitedBody(request, response, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      let chunks = [];
      let rejected = false;
      request.on('data', chunk => {
        if (rejected) return;
        size += chunk.length;
        if (size > limit) {
          rejected = true;
          chunks = [];
          sendJson(response, 413, { error: 'Request body is too large.' });
          request.resume();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      request.once('end', () => {
        if (!rejected) resolve(Buffer.concat(chunks).toString('utf8'));
      });
      request.once('error', error => {
        if (!rejected) reject(error);
      });
    });
  }

  const server = http.createServer(async (request, response) => {
    const address = server.address();
    const expectedHost = `127.0.0.1:${address.port}`;
    const expectedOrigin = `http://${expectedHost}`;
    const url = new URL(request.url || '/', expectedOrigin);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    if (request.headers.host !== expectedHost) {
      sendJson(response, 403, { error: 'Invalid dashboard host.' });
      return;
    }

    if (request.method === 'GET' && url.pathname === '/') {
      const suppliedToken = url.searchParams.get('token') || '';
      if (typeof accessToken !== 'string' || !accessToken) {
        sendJson(response, 403, { error: 'Dashboard token is unavailable.' });
        return;
      }
      const expectedToken = Buffer.from(accessToken || '');
      const actualToken = Buffer.from(suppliedToken);
      if (actualToken.length !== expectedToken.length || !timingSafeEqual(actualToken, expectedToken)) {
        sendJson(response, 403, { error: 'Invalid dashboard token.' });
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(renderPage(accessToken));
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      if (!authorized(request, expectedHost, expectedOrigin)) {
        sendJson(response, 403, { error: 'Dashboard authorization failed.' });
        return;
      }
      try {
        const snapshot = await getSnapshot();
        const state = await getState();
        sendJson(response, 200, { snapshot, notes: state.notes });
      } catch (error) {
        sendJson(response, 500, { error: error.message });
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/notes') {
      if (!authorized(request, expectedHost, expectedOrigin, true)) {
        sendJson(response, 403, { error: 'Dashboard authorization failed.' });
        return;
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
        sendJson(response, 415, { error: 'Content-Type must be application/json.' });
        request.resume();
        return;
      }
      if (Number(request.headers['content-length']) > 2048) {
        sendJson(response, 413, { error: 'Request body is too large.' });
        request.resume();
        return;
      }
      try {
        const rawBody = await readLimitedBody(request, response, 2048);
        if (rawBody === null) return;
        const body = JSON.parse(rawBody || '{}');
        if (typeof body.text !== 'string' || body.text.trim().length === 0 || body.text.length > 500) {
          throw new Error('Note text must be a non-empty string of at most 500 characters');
        }
        await onAddNote(body.text.trim());
        sendJson(response, 201, { ok: true });
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }

    response.statusCode = 404;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ error: 'Not found' }));
  });

  server.listen(0, '127.0.0.1');
  return server;
}

export async function serverUrl(server, accessToken) {
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  const address = server.address();
  return `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(accessToken)}`;
}

function renderPage(accessToken) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PHANTOM Project Dashboard</title>
  <style>
    :root { color-scheme: dark; --bg:#090d12; --panel:#111820; --line:#263442; --text:#d9e3ea; --muted:#91a2af; --accent:#57d6c7; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:linear-gradient(145deg,#090d12,#0d161d); color:var(--text); font:14px/1.5 Inter,Segoe UI,sans-serif; }
    main { max-width:960px; margin:auto; padding:32px 24px; }
    h1 { margin:0 0 4px; letter-spacing:.02em; }
    .subtle { color:var(--muted); }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin:20px 0; }
    .card,.notes { border:1px solid var(--line); background:rgba(17,24,32,.92); border-radius:12px; padding:16px; }
    .label { color:var(--muted); text-transform:uppercase; font-size:11px; letter-spacing:.12em; }
    .value { display:block; margin-top:6px; font-size:20px; overflow-wrap:anywhere; }
    form { display:flex; gap:8px; margin-top:12px; }
    label { flex:1; }
    input { width:100%; border:1px solid var(--line); border-radius:8px; background:#091016; color:var(--text); padding:10px 12px; }
    button { border:1px solid var(--accent); border-radius:8px; background:#12312f; color:#eafffb; padding:10px 14px; cursor:pointer; }
    button:focus-visible,input:focus-visible { outline:3px solid #f6c35b; outline-offset:2px; }
    ul { list-style:none; padding:0; margin:12px 0 0; }
    li { border-top:1px solid var(--line); padding:10px 0; overflow-wrap:anywhere; }
    #status { min-height:21px; color:var(--accent); }
  </style>
</head>
<body>
  <main>
    <h1>PHANTOM Project Dashboard</h1>
    <div class="subtle" id="workspace">Loading workspace…</div>
    <div class="grid">
      <section class="card"><span class="label">Branch</span><span class="value" id="branch">—</span></section>
      <section class="card"><span class="label">Changed files</span><span class="value" id="changed">—</span></section>
      <section class="card"><span class="label">Package scripts</span><span class="value" id="scripts">—</span></section>
    </div>
    <section class="notes" aria-labelledby="notes-heading">
      <h2 id="notes-heading">Workspace notes</h2>
      <form id="note-form">
        <label><span class="label">New note</span><input id="note-text" name="text" maxlength="500" required aria-describedby="status"></label>
        <button type="submit">Add</button>
      </form>
      <div id="status" role="status" aria-live="polite"></div>
      <ul id="notes"></ul>
    </section>
  </main>
  <script>
    const accessToken = ${JSON.stringify(accessToken)};
    const escapeText = (value) => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    async function load() {
      const response = await fetch('/api/state', { headers: { 'X-Phantom-Token': accessToken } });
      if (!response.ok) throw new Error('Could not load dashboard state');
      const data = await response.json();
      document.querySelector('#workspace').textContent = data.snapshot.workspaceRoot || 'No workspace selected';
      document.querySelector('#branch').textContent = data.snapshot.branch || 'unknown';
      document.querySelector('#changed').textContent = data.snapshot.changedFiles;
      document.querySelector('#scripts').textContent = data.snapshot.packageScripts;
      document.querySelector('#notes').innerHTML = data.notes.length
        ? data.notes.map(note => '<li>' + escapeText(note.text) + '</li>').join('')
        : '<li class="subtle">No workspace notes yet.</li>';
    }
    document.querySelector('#note-form').addEventListener('submit', async event => {
        event.preventDefault();
        const input = document.querySelector('#note-text');
        const status = document.querySelector('#status');
        try {
          const response = await fetch('/api/notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Phantom-Token': accessToken },
            body: JSON.stringify({ text: input.value })
          });
          const data = await response.json();
          if (!response.ok) throw new Error(data.error || 'Could not add note');
          input.value = '';
          status.textContent = 'Note added.';
          await load();
        } catch (error) {
          status.textContent = error.message;
        }
    });
      load().catch(error => {
        document.querySelector('#status').textContent = error.message;
      });
  </script>
</body>
</html>`;
}

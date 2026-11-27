import http from 'node:http';
import path from 'node:path';

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function createDashboardServer({ getSnapshot, getState, onAddNote }) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    response.setHeader('X-Content-Type-Options', 'nosniff');

    if (request.method === 'GET' && url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end(renderPage());
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      try {
        const snapshot = await getSnapshot();
        const state = await getState();
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify({ snapshot, notes: state.notes }));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/notes') {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        if (Buffer.concat(chunks).length > 2048) throw new Error('Request body is too large');
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof body.text !== 'string' || body.text.trim().length === 0 || body.text.length > 500) {
          throw new Error('Note text must be a non-empty string of at most 500 characters');
        }
        await onAddNote(body.text.trim());
        response.statusCode = 201;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: true }));
      } catch (error) {
        response.statusCode = 400;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ error: error.message }));
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

export async function serverUrl(server) {
  if (!server.listening) {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  }
  const address = server.address();
  return `http://127.0.0.1:${address.port}/`;
}

function renderPage() {
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
    const escapeText = (value) => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
    async function load() {
      const response = await fetch('/api/state');
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
            headers: { 'Content-Type': 'application/json' },
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

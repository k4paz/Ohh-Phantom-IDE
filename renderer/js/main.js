// PHANTOM renderer entry point.
import { call, bus, startTelemetry } from './core/api.js';
import { loadSettings } from './core/settings.js';
import { wm } from './core/wm.js';
import { initShell, boot, applyPreset } from './core/shell.js';
import { initProject, openProject, project } from './core/project.js';
import { loadBreakpoints, loadMonaco } from './core/docs.js';
import { debounce } from './core/dom.js';
import { toast } from './core/ui.js';

import editor from './apps/editor.js';
import projects from './apps/projects.js';
import terminal from './apps/terminal.js';
import explorer from './apps/explorer.js';
import sysmon from './apps/sysmon.js';
import net from './apps/net.js';
import procs from './apps/procs.js';
import logs from './apps/logs.js';
import git from './apps/git.js';
import api from './apps/apitester.js';
import db from './apps/db.js';
import arch from './apps/arch.js';
import search from './apps/search.js';
import markdown from './apps/markdown.js';
import json from './apps/json.js';
import ssh from './apps/ssh.js';
import debug from './apps/debug.js';
import tests from './apps/tests.js';
import build from './apps/build.js';
import events from './apps/events.js';
import audit from './apps/audit.js';
import settingsApp from './apps/settings.js';
import diff from './apps/diff.js';
import collab from './apps/collab.js';

const APPS = [projects, editor, terminal, explorer, sysmon, net, procs, logs, git, api, db, arch, search, markdown, json, ssh, debug, tests, build, events, audit, settingsApp, diff, collab];

window.addEventListener('error', (e) => { call('app:log', 'error', `${e.message} @ ${e.filename}:${e.lineno}`).catch(() => {}); });
window.addEventListener('unhandledrejection', (e) => { call('app:log', 'error', String(e.reason && e.reason.stack || e.reason)).catch(() => {}); });

async function main() {
  await loadSettings();
  wm.init(document.getElementById('desktop'));
  for (const a of APPS) wm.register(a);
  initShell();
  const booting = boot();
  await initProject();
  startTelemetry();
  loadBreakpoints().catch(() => {});
  loadMonaco(); // warm up in the background

  const session = await call('store:get', 'session', null).catch(() => null);
  if (session && session.project) await openProject(session.project, { silent: true });
  await booting;
  if (session && session.layout && session.layout.windows && session.layout.windows.length) {
    await wm.restoreLayout(session.layout, { replace: false });
  } else {
    if (!project.root) {
      const info = await call('fs:home');
      await openProject(info.cwd && info.cwd !== '/' ? info.cwd : info.home, { silent: true });
    }
    await applyPreset('Dev station', { replace: false });
    toast('Drag windows by their title bar. Throw them at screen edges to snap. Ctrl+Shift+P opens the command palette.', 'info', 'WELCOME TO PHANTOM', 9000);
  }

  const persist = () => call('store:set', 'session', { project: project.root, layout: wm.serialize(), ts: Date.now() }).catch(() => {});
  bus.on('wm:persist', debounce(persist, 900));
  bus.on('project:changed', debounce(persist, 900));
  bus.on('wm:persist-now', persist);
  window.addEventListener('beforeunload', persist);
  setInterval(persist, 30000); // terminals' cwd and editor scroll positions drift without wm events
}

main().catch((e) => {
  console.error(e);
  document.body.insertAdjacentHTML('beforeend', `<pre style="position:fixed;left:60px;top:60px;color:#ff3b5c;z-index:99999">PHANTOM failed to start:\n${String(e.stack || e)}</pre>`);
});

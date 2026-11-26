import { call } from './api.js';
import { menu, confirm, toast, fail } from './ui.js';
import { wm } from './wm.js';

export function showProcessMenu(e, p, { refresh = () => {}, onFilterChildren } = {}) {
  e.preventDefault();
  const items = [
    { header: `${p.name} (${p.pid})` },
    { label: 'Terminate (SIGTERM)', danger: true, action: () => signalProcess(p, 'SIGTERM', refresh) },
    { label: 'Kill (SIGKILL)', danger: true, action: () => signalProcess(p, 'SIGKILL', refresh) },
    { label: 'Interrupt (SIGINT)', action: () => signalProcess(p, 'SIGINT', refresh) },
    { label: 'Suspend (SIGSTOP)', action: () => signalProcess(p, 'SIGSTOP', refresh) },
    { label: 'Continue (SIGCONT)', action: () => signalProcess(p, 'SIGCONT', refresh) },
    { label: 'Hang up (SIGHUP)', action: () => signalProcess(p, 'SIGHUP', refresh) },
    '-',
    { label: 'Show sockets', action: () => wm.open('net', { state: { tab: 'conns', filter: String(p.pid) } }) }
  ];
  if (onFilterChildren) items.push({ label: 'Filter to children', action: () => onFilterChildren(p) });
  items.push(
    { label: 'Copy command line', action: () => navigator.clipboard.writeText(p.command) },
    { label: 'Copy PID', action: () => navigator.clipboard.writeText(String(p.pid)) }
  );
  menu(e.clientX, e.clientY, items);
}

export async function signalProcess(p, sig, refresh = () => {}) {
  const destructive = sig === 'SIGKILL' || sig === 'SIGTERM';
  if (destructive && !(await confirm(sig === 'SIGKILL' ? 'Kill process' : 'Terminate process', `Send ${sig} to ${p.name} (pid ${p.pid}, user ${p.user})?\n${p.command.slice(0, 200)}${sig === 'SIGKILL' ? '\n\nSIGKILL cannot be caught — unsaved work in that process will be lost.' : ''}`, { danger: true, ok: sig }))) return;
  try {
    await call('proc:kill', p.pid, sig);
    toast(`${sig} → ${p.name} (${p.pid})`);
    refresh();
  } catch (e) {
    fail(e, 'SIGNAL');
  }
}

// System monitor: CPU, per-core, memory, swap, disk I/O, network, filesystems, top processes.
import { h, esc, bytes, rate, pct, dur } from '../core/dom.js';
import { onTelemetry, telemetry, poll } from '../core/api.js';
import { plot, bars, cssVar } from '../core/graph.js';
import { showProcessMenu } from '../core/proc-menu.js';
import { wm } from '../core/wm.js';

export default {
  id: 'sysmon', title: 'System Monitor', icon: 'sysmon', desc: 'Live CPU / RAM / disk / network', size: [560, 600], min: [360, 300],
  create(win) {
    const el = h('div.sysmon.scroll.fill');
    win.body.appendChild(el);
    const panel = (title, extra) => { const v = h('span.v'); const c = h('canvas.g'); const p = h('div.sm-panel', h('div.hdr', title, h('span.sp'), v), c, extra || null); return { p, v, c }; };
    const head = h('div.sm-head');
    const cpu = panel('CPU'); const cores = h('canvas.cores'); cpu.p.appendChild(cores);
    const memBar = h('div.bar.cyan', h('i')); const swapBar = h('div.bar.amber', h('i')); const memInfo = h('div.sm-kv');
    const mem = panel('MEMORY', h('div', memInfo, memBar, h('div.sm-lbl', 'swap'), swapBar));
    const disk = panel('DISK I/O');
    const net = panel('NETWORK');
    const fsList = h('div.sm-fs');
    const top = h('table.grid.sm-top');
    let processList = [];
    el.append(head, cpu.p, mem.p, h('div.sm-row', disk.p, net.p), h('div.sm-panel', h('div.hdr', 'FILESYSTEMS'), fsList), h('div.sm-panel', h('div.hdr', 'TOP PROCESSES', h('span.c-dim', 'right-click a process for actions'), h('span.sp'), h('button.btn.ghost', { on: { click: () => wm.open('procs') } }, 'process manager →')), top));

    const draw = (s, hist) => {
      if (!win.visible) return;
      const st = telemetry.static;
      head.innerHTML = st ? `<b>${esc(st.hostname)}</b> <span class="c-dim">${esc(st.distro)} · ${esc(st.kernel)} · ${esc(st.arch)}</span><span class="sp"></span><span class="c-dim">up</span> ${dur(s.uptime * 1000)} <span class="c-dim">load</span> ${s.load.map((x) => x.toFixed(2)).join(' ')}${s.temp ? ` <span class="c-dim">temp</span> <span class="${s.temp.main > 80 ? 'c-red' : 'c-amber'}">${s.temp.main.toFixed(0)}°C</span>` : ''}` : '';
      const H = hist.slice(-120);
      cpu.v.innerHTML = `<b class="c-acc">${pct(s.cpu.load, 1)}</b> <span class="c-dim">${st ? esc(st.cpuModel) + ' · ' : ''}${s.cpu.cores.length} threads${s.cpu.speed ? ' · ' + s.cpu.speed + 'MHz' : ''}</span>`;
      plot(cpu.c, [{ data: H.map((x) => x.cpu.load) }], { max: 100, points: 120 });
      bars(cores, s.cpu.cores);
      const m = s.mem;
      mem.v.innerHTML = `<b class="c-cyan">${bytes(m.used)}</b> <span class="c-dim">/ ${bytes(m.total)} (${pct((m.used / m.total) * 100)})</span>`;
      memInfo.innerHTML = `<span>available <b>${bytes(m.available)}</b></span><span>cache <b>${bytes(m.cached)}</b></span><span>swap <b>${bytes(m.swapUsed)}</b> / ${bytes(m.swapTotal)}</span>`;
      memBar.firstChild.style.width = (m.used / m.total) * 100 + '%';
      swapBar.firstChild.style.width = (m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0) + '%';
      plot(mem.c, [{ data: H.map((x) => (x.mem.used / x.mem.total) * 100), color: cssVar('--cyan') }], { max: 100, points: 120 });
      disk.v.innerHTML = `<span class="c-acc">R ${rate(s.disk.rx_sec)}</span> <span class="c-amber">W ${rate(s.disk.wx_sec)}</span>`;
      plot(disk.c, [{ data: H.map((x) => x.disk.rx_sec) }, { data: H.map((x) => x.disk.wx_sec), color: cssVar('--amber') }], { points: 120 });
      net.v.innerHTML = `<span class="c-cyan">↓ ${rate(s.net.rx_sec)}</span> <span class="c-violet">↑ ${rate(s.net.tx_sec)}</span>`;
      plot(net.c, [{ data: H.map((x) => x.net.rx_sec), color: cssVar('--cyan') }, { data: H.map((x) => x.net.tx_sec), color: cssVar('--violet') }], { points: 120 });
      fsList.innerHTML = s.fs.map((f) => `<div class="sm-fsrow"><span class="mnt" title="${esc(f.fs)}">${esc(f.mount)}</span><div class="bar ${f.use > 90 ? 'red' : f.use > 75 ? 'amber' : ''}"><i style="width:${f.use}%"></i></div><span class="c-dim">${bytes(f.used)} / ${bytes(f.size)}</span><b>${pct(f.use)}</b></div>`).join('') || '<div class="c-dim">no filesystem data</div>';
    };
    const off = onTelemetry(draw);
    const procPoll = poll('proc:list', 2500, (r) => {
      processList = r.procs;
      const list = [...r.procs].sort((a, b) => b.cpu - a.cpu).slice(0, 8);
      top.innerHTML = '<tr><th class="num">PID</th><th>NAME</th><th>USER</th><th class="num">CPU</th><th class="num">MEM</th></tr>' +
        list.map((p) => `<tr data-pid="${p.pid}"><td class="num c-dim">${p.pid}</td><td>${esc(p.name)}</td><td class="c-dim">${esc(p.user)}</td><td class="num ${p.cpu > 50 ? 'c-red' : p.cpu > 10 ? 'c-amber' : ''}">${p.cpu.toFixed(1)}</td><td class="num">${bytes(p.rss)}</td></tr>`).join('');
    }).when(() => win.visible);
    top.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('tr[data-pid]');
      if (!row) return;
      const p = processList.find((item) => item.pid === Number(row.dataset.pid));
      if (p) showProcessMenu(e, p, { refresh: () => procPoll.now() });
    });
    win.onResize(() => { const hh = telemetry.history; if (hh.length) draw(hh[hh.length - 1], hh); });
    return {
      onShow: () => { const hh = telemetry.history; if (hh.length) draw(hh[hh.length - 1], hh); },
      destroy() { off(); procPoll.stop(); }
    };
  }
};

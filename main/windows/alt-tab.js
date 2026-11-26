'use strict';
const { spawn } = require('child_process');
const path = require('path');

function hookScriptPath() {
  const scriptPath = path.join(__dirname, 'alt-tab-hook.ps1');
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  return scriptPath.includes(asarSegment)
    ? scriptPath.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    : scriptPath;
}

function createAltTabHook({ onCycle, onExit, onFailure }) {
  let active = null;

  function stop() {
    if (!active) return;
    const state = active;
    active = null;
    state.stopping = true;
    state.child.kill();
  }

  function start() {
    if (process.platform !== 'win32') return Promise.reject(new Error('Hard fullscreen Alt+Tab interception is only available on Windows.'));
    if (active) return active.ready;

    const executable = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'
    );
    const child = spawn(executable, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', hookScriptPath(), '-ParentPid', String(process.pid)
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let resolveReady;
    let rejectReady;
    const state = {
      child,
      stopping: false,
      settled: false,
      failed: false,
      ready: new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      })
    };
    active = state;
    let outputBuffer = '';
    let errorOutput = '';
    let startupTimer;

    const failStart = (error) => {
      if (state.settled) return;
      state.settled = true;
      clearTimeout(startupTimer);
      if (active === state) active = null;
      state.stopping = true;
      child.kill();
      rejectReady(error);
    };

    const handleLine = (line) => {
      if (line === 'READY' && !state.settled) {
        state.settled = true;
        clearTimeout(startupTimer);
        resolveReady();
        return;
      }
      if (line === 'CYCLE_FORWARD') onCycle(1);
      else if (line === 'CYCLE_REVERSE') onCycle(-1);
      else if (line === 'EXIT') onExit();
    };

    startupTimer = setTimeout(() => {
      failStart(new Error(`Windows keyboard hook did not start in time.${errorOutput ? ` ${errorOutput.trim()}` : ''}`));
    }, 10000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outputBuffer += chunk;
      let newline;
      while ((newline = outputBuffer.indexOf('\n')) !== -1) {
        const line = outputBuffer.slice(0, newline).trim();
        outputBuffer = outputBuffer.slice(newline + 1);
        if (line) handleLine(line);
      }
    });
    child.stderr.on('data', (chunk) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-4000);
    });
    child.once('error', (error) => {
      failStart(new Error(`Unable to start the Windows keyboard hook: ${error.message}`));
      if (state.settled && !state.stopping && active === state && !state.failed) {
        state.failed = true;
        onFailure(error);
      }
    });
    child.once('exit', (code, signal) => {
      if (!state.settled) {
        failStart(new Error(`Windows keyboard hook exited before starting (${signal || code}).${errorOutput ? ` ${errorOutput.trim()}` : ''}`));
        return;
      }
      if (active === state) active = null;
      if (!state.stopping && !state.failed) {
        state.failed = true;
        const detail = errorOutput.trim();
        onFailure(new Error(`Windows keyboard hook stopped unexpectedly (${signal || code}).${detail ? ` ${detail}` : ''}`));
      }
    });
    return state.ready;
  }

  return { start, stop, isRunning: () => !!active };
}

module.exports = { createAltTabHook };

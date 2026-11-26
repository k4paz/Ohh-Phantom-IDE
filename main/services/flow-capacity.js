'use strict';
const os = require('os');

const BYTES_PER_AGENT = 1536 * 1024 * 1024;

function getAgentCapacity() {
  const logicalCpus = Math.max(1, os.cpus().length);
  const freeMemoryBytes = os.freemem();
  const totalMemoryBytes = os.totalmem();
  const machineMemorySlots = Math.max(1, Math.floor(totalMemoryBytes / BYTES_PER_AGENT));
  return {
    logicalCpus,
    freeMemoryBytes,
    totalMemoryBytes,
    maxConcurrentAgents: Math.max(1, Math.min(logicalCpus, machineMemorySlots)),
    recommendedConcurrentAgents: Math.max(1, Math.min(
      logicalCpus, machineMemorySlots, Math.floor(freeMemoryBytes / BYTES_PER_AGENT) || 1
    ))
  };
}

module.exports = { getAgentCapacity };

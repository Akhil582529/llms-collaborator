/**
 * Agent registry. Orchestrator looks up which function to call based on
 * the subtask's `agent` field. Add security/test agents here later.
 */

const backendAgent = require('./backendAgent');
const frontendAgent = require('./frontendAgent');

module.exports = {
  backend: backendAgent.run,
  frontend: frontendAgent.run,
};
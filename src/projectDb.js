/**
 * Creates one PostgreSQL database per generated project, so tables from
 * different generated apps (users, notes, posts, verifications...) never
 * collide in a shared database.
 *
 * Needs a role that can CREATE DATABASE. Set PG_ADMIN_URL in the
 * orchestrator's .env if the default doesn't match your setup, e.g.
 *   PG_ADMIN_URL=postgresql://USER:PASSWORD@localhost:5432/postgres
 * (Homebrew/Postgres.app default: your mac username, no password.)
 */

'use strict';

const { Client } = require('pg');

function databaseNameFor(taskId) {
  return 'gen_' + String(taskId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
}

async function ensureProjectDatabase(taskId) {
  const adminUrl =
    process.env.PG_ADMIN_URL ||
    `postgresql://${process.env.USER || 'postgres'}@localhost:5432/postgres`;

  const name = databaseNameFor(taskId);

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();

  try {
    const existing = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name]
    );

    if (existing.rowCount === 0) {
      // Identifier can't be parameterised; name is sanitised above.
      await admin.query(`CREATE DATABASE "${name}"`);
      console.log(`[projectDb] created database ${name}`);
    }
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = '/' + name;

  return url.toString();
}

module.exports = { ensureProjectDatabase, databaseNameFor };
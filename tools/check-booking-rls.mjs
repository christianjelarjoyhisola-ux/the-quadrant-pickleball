import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const migrationsDirectory = path.resolve('supabase', 'migrations');
const migrationNames = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith('.sql'))
  .sort();

const migrations = [];
for (const name of migrationNames) {
  const sql = await readFile(path.join(migrationsDirectory, name), 'utf8');
  migrations.push({ name, sql: sql.toLowerCase() });
}

function latestPolicyStatement(policyName) {
  const statements = [];
  const escapedName = policyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const operationPattern = new RegExp(
    `(?:drop|create)\\s+policy(?:\\s+if\\s+exists)?\\s+["']?${escapedName}["']?[\\s\\S]*?;`,
    'g',
  );

  for (const migration of migrations) {
    for (const match of migration.sql.matchAll(operationPattern)) {
      statements.push({ name: migration.name, statement: match[0] });
    }
  }

  return statements.at(-1);
}

function requirePattern(value, pattern, message) {
  if (!pattern.test(value)) {
    throw new Error(message);
  }
}

const publicInsert = latestPolicyStatement('bookings_insert_public');
if (!publicInsert) {
  throw new Error('Missing bookings_insert_public policy migration.');
}
requirePattern(
  publicInsert.statement,
  /^create\s+policy/,
  `Latest bookings_insert_public operation is not CREATE (${publicInsert.name}).`,
);
requirePattern(
  publicInsert.statement,
  /on\s+public\.bookings\s+for\s+insert\s+to\s+anon\b/,
  `bookings_insert_public must be an anonymous INSERT policy (${publicInsert.name}).`,
);

const dashboardInsert = latestPolicyStatement('bookings_insert_dashboard_roles');
if (!dashboardInsert) {
  throw new Error('Missing bookings_insert_dashboard_roles policy migration.');
}
requirePattern(
  dashboardInsert.statement,
  /^create\s+policy/,
  `Latest bookings_insert_dashboard_roles operation is not CREATE (${dashboardInsert.name}).`,
);
requirePattern(
  dashboardInsert.statement,
  /on\s+public\.bookings\s+for\s+insert\s+to\s+authenticated\b/,
  `Dashboard booking inserts must be available to authenticated users (${dashboardInsert.name}).`,
);

for (const role of ['owner', 'court_owner', 'staff']) {
  requirePattern(
    dashboardInsert.statement,
    new RegExp(`['"]${role}['"]`),
    `Dashboard booking insert policy is missing the ${role} role (${dashboardInsert.name}).`,
  );
}

console.log(
  `Booking RLS check passed: anonymous policy from ${publicInsert.name}; dashboard policy from ${dashboardInsert.name}.`,
);


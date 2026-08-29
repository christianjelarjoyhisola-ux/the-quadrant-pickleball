import { readFile } from 'node:fs/promises';

const [indexHtml, dataLayer] = await Promise.all([
  readFile('index.html', 'utf8'),
  readFile('supabase-config.js', 'utf8'),
]);

if (/DB\.seedDefaultData\s*\(/.test(indexHtml)) {
  throw new Error('The production website must not seed courts during page load.');
}

const remoteSeedStart = dataLayer.indexOf('// Production data is provisioned only by database setup/migrations.');
const remoteSeedEnd = dataLayer.indexOf('// Check if user has accepted', remoteSeedStart);
if (remoteSeedStart < 0 || remoteSeedEnd < 0) {
  throw new Error('Could not locate the production court-seeding guard.');
}

const remoteSeedBlock = dataLayer.slice(remoteSeedStart, remoteSeedEnd);
if (/Court Alpha|Court Beta|from\(['"]courts['"]\)\.insert/.test(remoteSeedBlock)) {
  throw new Error('Production runtime code must not recreate default courts.');
}

console.log('Court lifecycle check passed: production page loads cannot recreate deleted courts.');

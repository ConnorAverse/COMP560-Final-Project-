/**
 * pipeline.js — Runs the full pipeline in sequence:
 *   1. scraper.js  → data/jobs.json
 *   2. generate-people.js → data/people.json
 *   3. analyze.js  → data/analysis.json
 */

import { execSync } from 'child_process';
import 'dotenv/config';

function run(script) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Running: ${script}`);
  console.log('═'.repeat(60));
  execSync(`node scripts/${script}`, { stdio: 'inherit' });
}

console.log('AI Gender Bias Analyzer — Full Pipeline');
console.log(`Started: ${new Date().toISOString()}\n`);

const steps = ['scraper.js', 'generate-people.js', 'analyze.js'];

for (const step of steps) {
  try {
    run(step);
  } catch (err) {
    console.error(`\n[Pipeline] Step failed: ${step}`);
    console.error(err.message);
    process.exit(1);
  }
}

console.log('\n[Pipeline] Complete. Open index.html in a browser (or run: npm run dev)');

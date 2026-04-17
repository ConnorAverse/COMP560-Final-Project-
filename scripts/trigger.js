/**
 * trigger.js — fires the full pipeline immediately against the local dev server.
 *
 * Usage:
 *   Terminal 1:  npm run dev
 *   Terminal 2:  node scripts/trigger.js
 *
 * Env vars (optional overrides):
 *   BASE_URL    default http://localhost:8787
 *   BATCH_SIZE  default 25
 *   BATCHES     number of batches per model per job (default 4 → 100 people)
 */

const BASE        = process.env.BASE_URL     ?? 'http://localhost:8787';
const BATCH_SZ    = parseInt(process.env.BATCH_SIZE ?? '25');
const BATCHES     = parseInt(process.env.BATCHES    ?? '4');   // 4 × 25 = 100 people
const MODEL_FILTER = process.env.MODEL ? [process.env.MODEL] : ['llama', 'gemma', 'deepseek'];
const SKIP_SCRAPE  = process.env.SKIP_SCRAPE === 'true';
const MODELS       = MODEL_FILTER;

async function post(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

function bar(done, total, width = 30) {
  const filled = Math.round((done / total) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + `] ${done}/${total}`;
}

// ── Wait for dev server ───────────────────────────────────────────────────────
async function waitForServer(retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      await get('/api/status');
      return;
    } catch {
      if (i === 0) process.stdout.write('Waiting for dev server');
      process.stdout.write('.');
      await sleep(1500);
    }
  }
  throw new Error('\nDev server not reachable. Run `npm run dev` first.');
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nAI Bias Analyzer — Pipeline Trigger`);
  console.log(`Target:  ${BASE}`);
  console.log(`Models:  ${MODELS.join(', ')}`);
  console.log(`Config:  ${BATCHES} batches × ${BATCH_SZ}/batch = ${BATCHES * BATCH_SZ} people/model/job`);
  console.log(`Scrape:  ${SKIP_SCRAPE ? 'skip (reuse KV jobs)' : 'fresh'}\n`);

  await waitForServer();
  console.log('\n');

  // ── Step 1: Scrape (or reuse existing jobs) ─────────────────────────────────
  let jobs;
  if (SKIP_SCRAPE) {
    process.stdout.write('Step 1/3  Loading existing jobs from KV... ');
    const res = await get('/api/jobs');
    jobs = res.jobs ?? [];
    console.log(`✓ ${jobs.length} jobs (cached)`);
  } else {
    process.stdout.write('Step 1/3  Scraping jobs... ');
    const scrapeRes = await post('/api/pipeline/scrape');
    console.log(`✓ ${scrapeRes.jobCount} jobs (Indeed + LinkedIn + Glassdoor)`);
    jobs = scrapeRes.jobs ?? [];
  }
  if (!jobs.length) { console.error('No jobs found. Exiting.'); process.exit(1); }

  // ── Step 2: Generate personas ───────────────────────────────────────────────
  const totalCalls = jobs.length * MODELS.length * BATCHES;
  let done = 0;
  let totalPeople = 0;
  let totalTokens = 0;

  console.log(`\nStep 2/3  Generating personas`);
  console.log(`         ${jobs.length} jobs × ${MODELS.length} models × ${BATCHES} batches = ${totalCalls} API calls\n`);

  for (const job of jobs) {
    for (const model of MODELS) {
      for (let b = 0; b < BATCHES; b++) {
        try {
          const res = await post('/api/pipeline/generate', {
            jobId: job.id,
            model,
            batchSize: BATCH_SZ,
          });
          totalPeople += res.generated ?? 0;
          totalTokens += res.tokens?.total ?? 0;
        } catch (e) {
          console.error(`  ✗ ${job.title}/${model}/batch${b + 1}: ${e.message}`);
        }

        done++;
        process.stdout.write(
          `\r  ${bar(done, totalCalls)}  ${job.title.slice(0, 20).padEnd(20)} / ${model.padEnd(8)}  +${totalPeople} people`
        );
      }
    }
  }

  console.log(`\n  ✓ ${totalPeople} personas generated  |  ${totalTokens.toLocaleString()} total tokens\n`);

  // ── Step 3: Analyze ─────────────────────────────────────────────────────────
  process.stdout.write('Step 3/3  Computing bias analysis... ');
  const analysisRes = await post('/api/pipeline/analyze');
  console.log(`✓ ${analysisRes.analyzed} jobs analyzed\n`);

  // ── Summary table ────────────────────────────────────────────────────────────
  const analyses = analysisRes.analysis ?? [];
  console.log('─'.repeat(80));
  console.log('Job'.padEnd(38) + 'LLaMA'.padEnd(10) + 'Gemma'.padEnd(10) + 'DeepSeek'.padEnd(10) + 'Agg σ');
  console.log('─'.repeat(80));

  for (const a of analyses) {
    const row = [
      `${a.jobTitle} @ ${a.jobCompany}`.slice(0, 37).padEnd(38),
      (a.models.llama?.bias?.label    ?? '—').padEnd(10),
      (a.models.gemma?.bias?.label    ?? '—').padEnd(10),
      (a.models.deepseek?.bias?.label ?? '—').padEnd(10),
      a.aggregate.bias.stdDev.toFixed(4),
    ];
    console.log(row.join(''));
  }

  console.log('─'.repeat(80));
  console.log(`\nOpen http://localhost:8787 to explore results.\n`);
  console.log(`Cron runs every 2 hours — will add more personas until target reached.\n`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error('\n✗', e.message); process.exit(1); });

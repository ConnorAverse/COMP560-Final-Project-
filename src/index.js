/**
 * index.js — Cloudflare Worker entry point
 *
 * Routes:
 *   GET  /api/jobs                   → list jobs from KV
 *   GET  /api/people?jobId=X         → people for one job
 *   GET  /api/analysis               → full analysis array
 *   GET  /api/status                 → pipeline status
 *   GET  /api/budget                 → Neuron usage + cost vs $2 cap
 *
 *   POST /api/pipeline/scrape        → scrape + store jobs in KV
 *   POST /api/pipeline/generate      → {jobId, model, batchSize?} → generate + store
 *   POST /api/pipeline/analyze       → compute + store analysis
 *   POST /api/pipeline/reset         → wipe all KV data
 *
 * Static assets (public/) served automatically via [assets] binding.
 * Cron trigger runs every 2 hours; suspends automatically at $2 Neuron budget.
 */

import { Hono }             from 'hono';
import { cors }             from 'hono/cors';
import { scrapeIndeed, scrapeLinkedIn, scrapeGlassdoor, deduplicateJobs, generateMockJobs } from './scraper.js';
import { generateBatch, MODEL_IDS, estimateNeurons, neuronsToCost } from './generator.js';
import { analyzeAll }       from './analyzer.js';

const app = new Hono();

// $2 USD hard cap
const BUDGET_CAP_USD = 2.00;

// Discord webhook URL — set via: npx wrangler secret put DISCORD_WEBHOOK
// env.DISCORD_WEBHOOK is read inside fireBudgetAlert(env) where env is in scope

// CORS — allow same-origin + localhost dev
app.use('/api/*', cors({ origin: ['http://localhost:8787', 'https://ai-bias-analyzer.workers.dev', 'https://ai-bias-analyzer.ruhpellz.workers.dev'] }));

// Global error handler — always return JSON, never bare "Internal Server Error"
app.onError((err, c) => {
  console.error('[Worker error]', err.message, err.stack);
  return c.json({ error: err.message ?? 'Internal error' }, 500);
});

// ─── KV helpers ───────────────────────────────────────────────────────────────
const KV = {
  async getJSON(env, key) {
    const val = await env.JOB_DATA.get(key);
    return val ? JSON.parse(val) : null;
  },
  async setJSON(env, key, data) {
    await env.JOB_DATA.put(key, JSON.stringify(data));
  },
  async appendPeople(env, jobId, newPeople) {
    const existing = (await KV.getJSON(env, `people:${jobId}`)) ?? [];
    await KV.setJSON(env, `people:${jobId}`, [...existing, ...newPeople]);
  },
  async getAllPeople(env, jobs) {
    const all = await Promise.all(
      jobs.map((j) => KV.getJSON(env, `people:${j.id}`).then((p) => p ?? []))
    );
    return all.flat();
  },
};

// ─── Budget helpers ───────────────────────────────────────────────────────────
async function getBudget(env) {
  return (await KV.getJSON(env, 'neuron_usage')) ?? { neurons: 0, costUsd: 0, updatedAt: null };
}

async function addNeuronUsage(env, neurons, costUsd) {
  const current  = await getBudget(env);
  const newTotal = current.costUsd + costUsd;
  await KV.setJSON(env, 'neuron_usage', {
    neurons:   current.neurons + neurons,
    costUsd:   newTotal,
    updatedAt: new Date().toISOString(),
  });
  return newTotal;
}

async function isBudgetExceeded(env) {
  const b = await getBudget(env);
  return b.costUsd >= BUDGET_CAP_USD;
}

async function fireBudgetAlert(env) {
  // Guard: only fire once
  const alreadySuspended = await KV.getJSON(env, 'cron_suspended');
  if (alreadySuspended) return;

  await KV.setJSON(env, 'cron_suspended', true);
  await setStatus(env, { stage: 'suspended', suspendReason: `$${BUDGET_CAP_USD} budget cap reached` });

  try {
    await fetch(env.DISCORD_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content:     '<@105221541024772096><@313455919042396160> Cloudflare AI $2 Budget Reached',
        embeds:      null,
        attachments: [],
      }),
    });
    console.log('[Budget] Discord webhook fired');
  } catch (e) {
    console.error('[Budget] Discord webhook failed:', e.message);
  }
}

// ─── Status helpers ───────────────────────────────────────────────────────────
async function getStatus(env) {
  return (await KV.getJSON(env, 'pipeline:status')) ?? { stage: 'idle', progress: {}, lastRun: null };
}

async function setStatus(env, patch) {
  const current = await getStatus(env);
  await KV.setJSON(env, 'pipeline:status', { ...current, ...patch, updatedAt: new Date().toISOString() });
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// GET /api/jobs
app.get('/api/jobs', async (c) => {
  const jobs = (await KV.getJSON(c.env, 'jobs')) ?? [];
  return c.json({ jobs, count: jobs.length });
});

// GET /api/people?jobId=X
app.get('/api/people', async (c) => {
  const jobId = c.req.query('jobId');
  if (!jobId) return c.json({ error: 'jobId required' }, 400);
  const people = (await KV.getJSON(c.env, `people:${jobId}`)) ?? [];
  return c.json({ people, count: people.length });
});

// GET /api/analysis
app.get('/api/analysis', async (c) => {
  const analysis = (await KV.getJSON(c.env, 'analysis')) ?? [];
  return c.json({ analysis, count: analysis.length });
});

// GET /api/status
app.get('/api/status', async (c) => {
  const status = await getStatus(c.env);
  const jobs   = (await KV.getJSON(c.env, 'jobs')) ?? [];
  return c.json({ ...status, jobCount: jobs.length });
});

// GET /api/budget
app.get('/api/budget', async (c) => {
  const budget    = await getBudget(c.env);
  const suspended = (await KV.getJSON(c.env, 'cron_suspended')) ?? false;
  return c.json({
    neurons:   budget.neurons,
    costUsd:   budget.costUsd,
    capUsd:    BUDGET_CAP_USD,
    remaining: Math.max(0, BUDGET_CAP_USD - budget.costUsd),
    pctUsed:   Math.min(100, (budget.costUsd / BUDGET_CAP_USD) * 100).toFixed(1),
    suspended,
    updatedAt: budget.updatedAt,
  });
});

// POST /api/pipeline/scrape
app.post('/api/pipeline/scrape', async (c) => {
  await setStatus(c.env, { stage: 'scraping', progress: { scrape: 'running' } });

  const terms = (c.env.SEARCH_TERMS ?? 'software engineer,registered nurse')
    .split(',').map((s) => s.trim()).filter(Boolean);

  const limit = 5;
  let allJobs = [];

  const [indeed, linkedin, glassdoor] = await Promise.allSettled([
    scrapeIndeed(terms, limit),
    scrapeLinkedIn(terms, limit),
    scrapeGlassdoor(terms, limit),
  ]);

  if (indeed.status    === 'fulfilled') allJobs.push(...indeed.value);
  if (linkedin.status  === 'fulfilled') allJobs.push(...linkedin.value);
  if (glassdoor.status === 'fulfilled') allJobs.push(...glassdoor.value);

  if (allJobs.length === 0) {
    console.warn('[Scraper] All sources failed, using mock data');
    allJobs = generateMockJobs(terms);
  }

  // Dedup by title+company — source not relevant, job is the unit of analysis
  const jobs = deduplicateJobs(allJobs);
  await KV.setJSON(c.env, 'jobs', jobs);
  await setStatus(c.env, { stage: 'scraped', progress: { scrape: 'done', jobCount: jobs.length } });

  return c.json({ ok: true, jobCount: jobs.length, jobs });
});

// POST /api/pipeline/generate
// Body: { jobId: string, model: 'llama'|'gemma'|'deepseek', batchSize?: number }
app.post('/api/pipeline/generate', async (c) => {
  // ── Budget gate ─────────────────────────────────────────────────────────────
  if (await isBudgetExceeded(c.env)) {
    await fireBudgetAlert(c.env);
    const b = await getBudget(c.env);
    return c.json({
      error:     `$${BUDGET_CAP_USD} Neuron budget reached ($${b.costUsd.toFixed(4)} spent). Pipeline suspended.`,
      budget:    b,
      suspended: true,
    }, 402);
  }

  const { jobId, model, batchSize: bsOverride } = await c.req.json();

  if (!jobId || !model) return c.json({ error: 'jobId and model required' }, 400);
  if (!MODEL_IDS[model])  return c.json({ error: `Unknown model: ${model}. Use: llama, gemma, deepseek` }, 400);

  const jobs = (await KV.getJSON(c.env, 'jobs')) ?? [];
  const job  = jobs.find((j) => j.id === jobId);
  if (!job) return c.json({ error: 'Job not found' }, 404);

  const batchSize = bsOverride ?? parseInt(c.env.BATCH_SIZE ?? '25');

  await setStatus(c.env, {
    stage:    'generating',
    progress: { ...(await getStatus(c.env)).progress, [`gen:${jobId}:${model}`]: 'running' },
  });

  const { people, tokens } = await generateBatch(c.env, job, model, batchSize);
  await KV.appendPeople(c.env, jobId, people);

  // Track Neuron spend
  const newTotal = await addNeuronUsage(c.env, tokens.neurons, tokens.costUsd);

  await setStatus(c.env, {
    progress: { ...(await getStatus(c.env)).progress, [`gen:${jobId}:${model}`]: 'done' },
  });

  // Fire alert if cap just crossed
  if (newTotal >= BUDGET_CAP_USD) {
    await fireBudgetAlert(c.env);
  }

  return c.json({
    ok:        true,
    jobId,
    model,
    generated: people.length,
    tokens,
    budget:    await getBudget(c.env),
    sample:    people.slice(0, 3),
  });
});

// POST /api/pipeline/analyze
app.post('/api/pipeline/analyze', async (c) => {
  await setStatus(c.env, { stage: 'analyzing', progress: { analyze: 'running' } });

  const jobs      = (await KV.getJSON(c.env, 'jobs')) ?? [];
  const allPeople = await KV.getAllPeople(c.env, jobs);
  const analysis  = analyzeAll(jobs, allPeople);

  await KV.setJSON(c.env, 'analysis', analysis);
  await setStatus(c.env, {
    stage:    'complete',
    lastRun:  new Date().toISOString(),
    progress: { scrape: 'done', generate: 'done', analyze: 'done' },
  });

  return c.json({ ok: true, analyzed: analysis.length, analysis });
});

// POST /api/pipeline/reset
app.post('/api/pipeline/reset', async (c) => {
  const jobs = (await KV.getJSON(c.env, 'jobs')) ?? [];

  await Promise.all([
    c.env.JOB_DATA.delete('jobs'),
    c.env.JOB_DATA.delete('analysis'),
    c.env.JOB_DATA.delete('pipeline:status'),
    c.env.JOB_DATA.delete('neuron_usage'),
    c.env.JOB_DATA.delete('cron_suspended'),
    c.env.JOB_DATA.delete('last_scrape_at'),
    ...jobs.map((j) => c.env.JOB_DATA.delete(`people:${j.id}`)),
  ]);

  return c.json({ ok: true, message: 'All data cleared' });
});

// ─── Cron pipeline — runs every 2 hours, accumulates toward target ────────────
async function runFullPipeline(env) {
  // ── Bail if budget-suspended ────────────────────────────────────────────────
  if (await KV.getJSON(env, 'cron_suspended')) {
    console.log('[Cron] Budget cap reached — suspended, skipping run.');
    return;
  }

  const runId     = new Date().toISOString();
  const target    = parseInt(env.PEOPLE_PER_JOB ?? '100');
  const batchSize = parseInt(env.BATCH_SIZE     ?? '25');
  const models    = Object.keys(MODEL_IDS);
  console.log('[Cron] Run start:', runId);

  // ── 1. Scrape only if stale / missing ──────────────────────────────────────
  let jobs         = (await KV.getJSON(env, 'jobs')) ?? [];
  const lastScrape = await KV.getJSON(env, 'last_scrape_at');
  const ageHours   = lastScrape
    ? (Date.now() - new Date(lastScrape).getTime()) / 3_600_000
    : Infinity;

  if (jobs.length === 0 || ageHours >= 24) {
    const terms = (env.SEARCH_TERMS ?? 'software engineer,registered nurse')
      .split(',').map((s) => s.trim()).filter(Boolean);

    let fresh = [];
    const [indeed, linkedin, glassdoor] = await Promise.allSettled([
      scrapeIndeed(terms, 5),
      scrapeLinkedIn(terms, 5),
      scrapeGlassdoor(terms, 5),
    ]);
    if (indeed.status    === 'fulfilled') fresh.push(...indeed.value);
    if (linkedin.status  === 'fulfilled') fresh.push(...linkedin.value);
    if (glassdoor.status === 'fulfilled') fresh.push(...glassdoor.value);
    if (fresh.length === 0) fresh = generateMockJobs(terms);

    jobs = deduplicateJobs(fresh);
    await KV.setJSON(env, 'jobs', jobs);
    await KV.setJSON(env, 'last_scrape_at', runId);
    console.log(`[Cron] Scraped ${jobs.length} jobs`);
  } else {
    console.log(`[Cron] Using cached ${jobs.length} jobs (${ageHours.toFixed(1)}h old)`);
  }

  // ── 2. Generate — one batch per job × model that still needs more people ───
  let totalGenerated = 0;
  let budgetHit      = false;

  outer: for (const job of jobs) {
    const existing = (await KV.getJSON(env, `people:${job.id}`)) ?? [];

    for (const model of models) {
      if (await isBudgetExceeded(env)) {
        console.log('[Cron] Budget cap reached — halting generation');
        await fireBudgetAlert(env);
        budgetHit = true;
        break outer;
      }

      const have = existing.filter((p) => p.aiModel === model).length;
      if (have >= target) {
        console.log(`[Cron] ${job.title}/${model}: at target (${have}), skip`);
        continue;
      }

      const need = Math.min(batchSize, target - have);
      try {
        const { people, tokens } = await generateBatch(env, job, model, need);
        await KV.appendPeople(env, job.id, people);
        totalGenerated += people.length;
        const newTotal = await addNeuronUsage(env, tokens.neurons, tokens.costUsd);
        console.log(`[Cron] ${job.title}/${model}: +${people.length} (${have + people.length}/${target}) | $${newTotal.toFixed(4)} spent`);

        if (newTotal >= BUDGET_CAP_USD) {
          await fireBudgetAlert(env);
          budgetHit = true;
          break outer;
        }
      } catch (e) {
        console.error(`[Cron] ${job.id}/${model} failed: ${e.message}`);
      }
    }
  }

  // ── 3. Analyze ─────────────────────────────────────────────────────────────
  const allPeople = await KV.getAllPeople(env, jobs);
  const analysis  = analyzeAll(jobs, allPeople);
  await KV.setJSON(env, 'analysis', analysis);

  const budget = await getBudget(env);
  await KV.setJSON(env, 'pipeline:status', {
    stage:         budgetHit ? 'suspended' : 'complete',
    lastRun:       runId,
    totalGenerated,
    jobCount:      jobs.length,
    peopleCount:   allPeople.length,
    budgetUsd:     budget.costUsd,
    progress:      { scrape: 'done', generate: budgetHit ? 'suspended' : 'done', analyze: 'done' },
  });

  console.log(`[Cron] Done — +${totalGenerated} people, ${allPeople.length} total | $${budget.costUsd.toFixed(4)} spent`);
}

// ─── Export ───────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      return app.fetch(request, env, ctx);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runFullPipeline(env));
  },
};

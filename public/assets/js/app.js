/**
 * app.js — AI Gender Bias Analyzer SPA
 * All data fetched from /api/* (Cloudflare Worker).
 * Pipeline steps triggered from browser via POST requests.
 */

// ─── State ────────────────────────────────────────────────────────────────────
const S = {
  jobs:       [],
  analysis:   [],
  selectedJobId: null,
  peopleSort: { key: 'name', dir: 'asc' },
  peoplePage: 1,
  pageSize:   25,
  filter:     { search: '', gender: '', model: '' },
  charts:     {},
};

const BIAS_ORDER  = { minimal: 0, low: 1, moderate: 2, high: 3, severe: 4 };
const MODEL_COLOR = { llama: '#10a37f', gemma: '#c026d3', deepseek: '#1e6fe6', aggregate: '#6366f1' };
const MODEL_LABEL = { llama: 'LLaMA 3.1', gemma: 'Gemma 7B', deepseek: 'DeepSeek R1' };
const GENDER_COLOR = { female: '#ec4899', male: '#3b82f6', other: '#8b5cf6' };

// ─── API ──────────────────────────────────────────────────────────────────────
const api = {
  async get(path)       { const r = await fetch(path); return r.json(); },
  async post(path, body){ const r = await fetch(path, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) }); return r.json(); },
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function init() {
  attachGlobalHandlers();
  await refreshData();
}

async function refreshData() {
  try {
    const [jobsRes, analysisRes, statusRes] = await Promise.all([
      api.get('/api/jobs'),
      api.get('/api/analysis'),
      api.get('/api/status'),
    ]);
    S.jobs     = jobsRes.jobs     ?? [];
    S.analysis = analysisRes.analysis ?? [];

    document.getElementById('data-status').textContent =
      `${S.jobs.length} jobs · ${new Date().toLocaleDateString()}`;

    updatePipelineStatus(statusRes);
    renderJobList();

    // Refresh selected job if open
    if (S.selectedJobId) renderJobDetail();
  } catch (e) {
    document.getElementById('data-status').textContent = '⚠ Worker not reachable';
    document.getElementById('jobs-list').innerHTML = `
      <div class="empty">
        <strong>Cannot reach Worker.</strong><br/>
        Run <code>npm run dev</code> then open <a href="http://localhost:8787" style="color:var(--accent)">localhost:8787</a>
      </div>`;
  }
}

// ─── Pipeline drawer ──────────────────────────────────────────────────────────
function attachGlobalHandlers() {
  // Drawer toggle
  document.getElementById('pipeline-btn').addEventListener('click', () => {
    document.getElementById('pipeline-drawer').classList.toggle('hidden');
    populateJobDropdown();
  });
  document.getElementById('pipeline-close').addEventListener('click', () => {
    document.getElementById('pipeline-drawer').classList.add('hidden');
  });

  // Scrape
  document.getElementById('btn-scrape').addEventListener('click', runScrape);

  // Generate
  document.getElementById('btn-generate').addEventListener('click', runGenerate);

  // Analyze
  document.getElementById('btn-analyze').addEventListener('click', runAnalyze);

  // Reset
  document.getElementById('btn-reset').addEventListener('click', async () => {
    if (!confirm('Delete all jobs, personas, and analysis from KV? Cannot be undone.')) return;
    await api.post('/api/pipeline/reset', {});
    S.jobs = []; S.analysis = []; S.selectedJobId = null;
    renderJobList();
    document.getElementById('welcome-screen').classList.remove('hidden');
    document.getElementById('job-detail').classList.add('hidden');
    setStepStatus('scrape', 'idle');
    setStepStatus('generate', 'idle');
    setStepStatus('analyze', 'idle');
  });

  // Export
  document.getElementById('export-btn').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(S.analysis, null, 2)], { type: 'application/json' });
    const a    = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ai-bias-analysis.json';
    a.click();
  });

  // Sidebar filters
  ['job-search','filter-source','filter-bias','sort-jobs'].forEach((id) =>
    document.getElementById(id).addEventListener('input', renderJobList));
  document.getElementById('filter-source').addEventListener('change', renderJobList);
  document.getElementById('filter-bias').addEventListener('change', renderJobList);
  document.getElementById('sort-jobs').addEventListener('change', renderJobList);
}

function populateJobDropdown() {
  const sel = document.getElementById('gen-job');
  const current = sel.value;
  sel.innerHTML = '<option value="all">All Jobs</option>' +
    S.jobs.map((j) => `<option value="${j.id}">${esc(j.title)}</option>`).join('');
  sel.value = current || 'all';
  document.getElementById('gen-info').textContent =
    `25 per batch · 3 models · ${S.jobs.length} jobs`;
}

function setStepStatus(step, status) {
  const el = document.getElementById(`status-${step}`);
  if (!el) return;
  el.textContent = status;
  el.className = 'step-status step-' + status;
}

function updatePipelineStatus(statusRes) {
  if (!statusRes) return;
  const { stage, lastRun } = statusRes;
  const lrEl = document.getElementById('pipeline-last-run');
  if (lrEl && lastRun) lrEl.textContent = `Last run: ${new Date(lastRun).toLocaleString()}`;
  if (stage === 'complete') {
    setStepStatus('scrape', 'done');
    setStepStatus('generate', 'done');
    setStepStatus('analyze', 'done');
  }
}

// ─── Pipeline actions ─────────────────────────────────────────────────────────
async function runScrape() {
  setStepStatus('scrape', 'running…');
  document.getElementById('btn-scrape').disabled = true;
  try {
    const res = await api.post('/api/pipeline/scrape', {});
    S.jobs = res.jobs ?? [];
    setStepStatus('scrape', `✓ ${res.jobCount} jobs`);
    populateJobDropdown();
    renderJobList();
  } catch (e) {
    setStepStatus('scrape', '✗ error');
    console.error(e);
  } finally {
    document.getElementById('btn-scrape').disabled = false;
  }
}

async function runGenerate() {
  const modelSel  = document.getElementById('gen-model').value;
  const jobSel    = document.getElementById('gen-job').value;
  const batches   = parseInt(document.getElementById('gen-batches').value) || 4;
  const BATCH_SZ  = 25;

  const targetJobs   = jobSel === 'all' ? S.jobs : S.jobs.filter((j) => j.id === jobSel);
  const targetModels = modelSel === 'all' ? ['llama', 'gemma', 'deepseek'] : [modelSel];
  const totalCalls   = targetJobs.length * targetModels.length * batches;

  if (totalCalls === 0) { alert('No jobs or models selected.'); return; }

  const progressWrap = document.getElementById('gen-progress-wrap');
  const progressFill = document.getElementById('gen-progress-fill');
  const progressLbl  = document.getElementById('gen-progress-label');
  progressWrap.classList.remove('hidden');
  document.getElementById('btn-generate').disabled = true;
  setStepStatus('generate', 'running…');

  let done = 0;

  for (const job of targetJobs) {
    for (const model of targetModels) {
      for (let b = 0; b < batches; b++) {
        try {
          await api.post('/api/pipeline/generate', { jobId: job.id, model, batchSize: BATCH_SZ });
        } catch (e) {
          console.error(`Generate failed ${job.id}/${model}/batch${b}:`, e.message);
        }
        done++;
        const pct = Math.round((done / totalCalls) * 100);
        progressFill.style.width = pct + '%';
        progressLbl.textContent = `${done} / ${totalCalls} batches (${pct}%)`;
      }
    }
  }

  setStepStatus('generate', `✓ ${done * BATCH_SZ} personas`);
  document.getElementById('btn-generate').disabled = false;
}

async function runAnalyze() {
  setStepStatus('analyze', 'running…');
  document.getElementById('btn-analyze').disabled = true;
  try {
    const res = await api.post('/api/pipeline/analyze', {});
    S.analysis = res.analysis ?? [];
    setStepStatus('analyze', `✓ ${res.analyzed} jobs`);
    renderJobList();
    if (S.selectedJobId) renderJobDetail();
  } catch (e) {
    setStepStatus('analyze', '✗ error');
    console.error(e);
  } finally {
    document.getElementById('btn-analyze').disabled = false;
  }
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function getFilteredJobs() {
  const search  = document.getElementById('job-search').value.toLowerCase();
  const source  = document.getElementById('filter-source').value;
  const bias    = document.getElementById('filter-bias').value;
  const sort    = document.getElementById('sort-jobs').value;
  const aMap    = Object.fromEntries(S.analysis.map((a) => [a.jobId, a]));

  let jobs = S.jobs.filter((j) => {
    const bl = aMap[j.id]?.aggregate?.bias?.label ?? '';
    if (search && !`${j.title} ${j.company} ${j.category}`.toLowerCase().includes(search)) return false;
    if (source && j.source !== source) return false;
    if (bias   && bl !== bias)         return false;
    return true;
  });

  jobs.sort((a, b) => {
    const aa = aMap[a.id]; const ba = aMap[b.id];
    if (sort === 'bias-desc') return (BIAS_ORDER[ba?.aggregate?.bias?.label] ?? -1) - (BIAS_ORDER[aa?.aggregate?.bias?.label] ?? -1);
    if (sort === 'bias-asc')  return (BIAS_ORDER[aa?.aggregate?.bias?.label] ?? 99) - (BIAS_ORDER[ba?.aggregate?.bias?.label] ?? 99);
    if (sort === 'title-asc') return a.title.localeCompare(b.title);
    if (sort === 'source')    return a.source.localeCompare(b.source);
    return 0;
  });

  return { jobs, aMap };
}

function renderJobList() {
  const list = document.getElementById('jobs-list');
  const { jobs, aMap } = getFilteredJobs();

  if (!jobs.length) {
    list.innerHTML = S.jobs.length
      ? '<div class="empty">No jobs match filters.</div>'
      : '<div class="empty">No jobs yet.<br/>Run the pipeline to scrape jobs.</div>';
    return;
  }

  list.innerHTML = jobs.map((job) => {
    const a    = aMap[job.id];
    const bl   = a?.aggregate?.bias?.label ?? 'unknown';
    const tot  = a?.aggregate?.counts?.total ?? 0;
    const fPct = Math.round((a?.aggregate?.ratios?.female ?? 0) * 100);
    const mPct = Math.round((a?.aggregate?.ratios?.male   ?? 0) * 100);
    const oPct = Math.max(0, 100 - fPct - mPct);

    return `
    <div class="job-card ${job.id === S.selectedJobId ? 'active' : ''}" data-id="${job.id}">
      <div class="job-card-header">
        <div>
          <div class="job-card-title">${esc(job.title)}</div>
          <div class="job-card-company">${esc(job.category)}</div>
        </div>
        <span class="source-badge source-${job.source}" title="${sourceTooltip(job.source)}">${sourceLabel(job.source)}</span>
      </div>
      <div class="job-card-meta">
        <span class="bias-pill bias-${bl}">${bl}</span>
        <span class="people-count">${tot} people</span>
        ${a ? `<span class="muted text-xs">σ ${a.aggregate.bias.stdDev.toFixed(3)}</span>` : ''}
      </div>
      <div class="mini-bars">
        <div class="mini-bar-f" style="flex:${fPct}"></div>
        <div class="mini-bar-m" style="flex:${mPct}"></div>
        <div class="mini-bar-o" style="flex:${oPct}"></div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.job-card').forEach((card) =>
    card.addEventListener('click', () => selectJob(card.dataset.id)));
}

// ─── Job detail ───────────────────────────────────────────────────────────────
async function selectJob(jobId) {
  S.selectedJobId = jobId;
  S.peoplePage    = 1;
  S.filter        = { search: '', gender: '', model: '' };
  Object.values(S.charts).forEach((c) => c.destroy());
  S.charts = {};
  renderJobList();

  // Show loading
  document.getElementById('welcome-screen').classList.add('hidden');
  const detail = document.getElementById('job-detail');
  detail.classList.remove('hidden');
  detail.innerHTML = '<div class="loading"><div class="spinner"></div> Loading personas…</div>';

  const job      = S.jobs.find((j) => j.id === jobId);
  const analysis = S.analysis.find((a) => a.jobId === jobId);
  const res      = await api.get(`/api/people?jobId=${jobId}`);
  const people   = res.people ?? [];

  renderJobDetail(job, analysis, people);
}

function renderJobDetail(job, analysis, people) {
  if (!job) return;
  const detail = document.getElementById('job-detail');

  detail.innerHTML = `
    ${jobHeader(job, analysis)}
    ${statsBar(analysis, people)}
    ${analysis ? biasSection(analysis) : noAnalysis()}
    ${analysis ? censusCompare(analysis) : ''}
    ${analysis ? chartSection() : ''}
    ${analysis ? tokenSection(analysis) : ''}
    ${peopleSection()}
  `;

  attachDetailHandlers(people);
  if (analysis) requestAnimationFrame(() => drawCharts(analysis));
}

function noAnalysis() {
  return `<div class="card"><div class="card-body"><p class="muted text-sm">Run Analysis step to see bias scores for this job.</p></div></div>`;
}

// ─── Detail sub-sections ──────────────────────────────────────────────────────

function jobHeader(job, analysis) {
  const bias = analysis?.aggregate?.bias;
  return `
  <div class="job-detail-header">
    <div class="job-title-row">
      <div style="flex:1">
        <h2>${esc(job.title)}</h2>
        <div class="meta" style="margin-top:.4rem">
          <span title="${sourceTooltip(job.source)}">📦 ${sourceLabel(job.source)}</span>
          <span>🗂 ${esc(job.category)}</span>
        </div>
      </div>
      ${bias ? `<span class="bias-pill bias-${bias.label}" style="font-size:.8rem;padding:.35rem .9rem">
        ${bias.label.toUpperCase()} BIAS &nbsp; σ=${bias.stdDev.toFixed(3)}</span>` : ''}
    </div>
    <p class="muted text-sm" style="line-height:1.7">${esc(job.description)}</p>
  </div>`;
}

function statsBar(analysis, people) {
  const tot = people.length;
  const models = ['llama', 'gemma', 'deepseek'];
  const totalTokens = models.reduce((s, m) => s + (analysis?.models?.[m]?.tokens?.total ?? 0), 0);

  return `
  <div class="stats-bar">
    <div class="stat-card"><div class="stat-value">${tot}</div><div class="stat-label">Total Personas</div></div>
    <div class="stat-card stat-llama"><div class="stat-value">${analysis?.models?.llama?.counts?.total ?? 0}</div><div class="stat-label">LLaMA</div></div>
    <div class="stat-card stat-gemma"><div class="stat-value">${analysis?.models?.gemma?.counts?.total ?? 0}</div><div class="stat-label">Gemma</div></div>
    <div class="stat-card stat-deepseek"><div class="stat-value">${analysis?.models?.deepseek?.counts?.total ?? 0}</div><div class="stat-label">DeepSeek</div></div>
    <div class="stat-card"><div class="stat-value font-mono" style="font-size:1rem">${totalTokens.toLocaleString()}</div><div class="stat-label">Total Tokens</div></div>
    ${analysis ? `<div class="stat-card"><div class="stat-value">${pct(analysis.census.female)}</div><div class="stat-label">Census Baseline (F)</div></div>` : ''}
  </div>`;
}

function biasSection(analysis) {
  const segments = [
    { key: 'llama',    label: 'LLaMA 3.1',    data: analysis.models.llama },
    { key: 'gemma',    label: 'Gemma 7B',      data: analysis.models.gemma },
    { key: 'deepseek', label: 'DeepSeek R1',   data: analysis.models.deepseek },
    { key: 'aggregate',label: 'All Models',    data: analysis.aggregate },
  ];

  return `
  <div class="card">
    <div class="card-header"><h2>Bias Analysis</h2><span class="muted text-xs">σ = std dev of AI ratio vs. census across genders</span></div>
    <div class="card-body">
      <div class="bias-meters">
        ${segments.map(({ key, label, data }) => {
          if (!data) return '';
          const { bias } = data;
          const fill = Math.min(bias.stdDev * 400, 100);
          const delta = bias.femaleBias;
          return `
          <div class="bias-meter-card">
            <div class="bias-meter-header">
              <span style="font-size:.85rem;font-weight:600">
                <span class="model-dot" style="background:${MODEL_COLOR[key]}"></span>${label}
              </span>
              <span class="bias-pill bias-${bias.label}" style="font-size:.65rem">${bias.label}</span>
            </div>
            <div class="bias-meter-track">
              <div class="bias-meter-fill" style="width:${fill}%;background:${biasColor(bias.label)}"></div>
            </div>
            <div class="bias-breakdown">
              <div class="bias-breakdown-item"><span class="label">σ</span><span class="value font-mono">${bias.stdDev.toFixed(4)}</span></div>
              <div class="bias-breakdown-item"><span class="label">Female Δ</span>
                <span class="value font-mono ${delta > 0 ? 'positive' : 'negative'}">${delta > 0 ? '+' : ''}${(delta*100).toFixed(1)}%</span>
              </div>
              <div class="bias-breakdown-item"><span class="label">Abs err</span><span class="value font-mono">${(bias.absError*100).toFixed(1)}%</span></div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function censusCompare(analysis) {
  const census = analysis.census;
  const models = ['llama', 'gemma', 'deepseek'];

  const rows = ['female', 'male'].map((g) => {
    const cv = census[g];
    const bars = models.map((m) => {
      const av = analysis.models[m]?.ratios?.[g] ?? 0;
      return `
        <div style="display:flex;align-items:center;gap:.5rem;font-size:.75rem;margin-bottom:.3rem">
          <span style="width:80px;color:var(--muted)">${MODEL_LABEL[m]}</span>
          <div style="flex:1;position:relative;height:20px">
            <div style="position:absolute;top:0;height:9px;border-radius:4px;background:var(--muted);opacity:.4;width:${(cv*100).toFixed(1)}%"></div>
            <div style="position:absolute;bottom:0;height:9px;border-radius:4px;background:${MODEL_COLOR[m]};width:${(av*100).toFixed(1)}%"></div>
          </div>
          <span class="font-mono" style="width:90px;text-align:right;font-size:.72rem">
            <span style="color:${MODEL_COLOR[m]}">${pct(av)}</span>
            <span style="color:var(--muted)"> / ${pct(cv)}</span>
          </span>
        </div>`;
    }).join('');
    return `
      <div style="margin-bottom:1rem">
        <div style="font-size:.8rem;font-weight:600;color:${GENDER_COLOR[g]};margin-bottom:.5rem;text-transform:capitalize">
          ${g} — Census: ${pct(cv)}
        </div>
        ${bars}
        <div style="font-size:.7rem;color:var(--muted);margin-top:.2rem">Top = census · Bottom = AI</div>
      </div>`;
  }).join('');

  return `
  <div class="card">
    <div class="card-header"><h2>Census vs. AI Comparison</h2><span class="muted text-xs">Source: ${census.source}</span></div>
    <div class="card-body">${rows}</div>
  </div>`;
}

function chartSection() {
  return `
  <div class="card">
    <div class="card-header"><h2>Distribution Charts</h2></div>
    <div class="card-body">
      <div class="chart-grid">
        <div class="chart-wrap"><h3>LLaMA 3.1 vs Census</h3><canvas id="chart-llama"></canvas></div>
        <div class="chart-wrap"><h3>Gemma 7B vs Census</h3><canvas id="chart-gemma"></canvas></div>
        <div class="chart-wrap"><h3>DeepSeek R1 vs Census</h3><canvas id="chart-deepseek"></canvas></div>
        <div class="chart-wrap"><h3>Female % — All Models vs Census</h3><canvas id="chart-compare"></canvas></div>
      </div>
    </div>
  </div>`;
}

function tokenSection(analysis) {
  const models = [
    { key: 'llama',    label: 'LLaMA 3.1 8B' },
    { key: 'gemma',    label: 'Gemma 7B' },
    { key: 'deepseek', label: 'DeepSeek R1 Distill' },
  ];
  return `
  <div class="card">
    <div class="card-header"><h2>Token Usage</h2><span class="muted text-xs">Cloudflare Workers AI — no external API cost</span></div>
    <div class="card-body">
      <div class="token-grid">
        ${models.map(({ key, label }) => {
          const t = analysis.models[key]?.tokens;
          if (!t) return '';
          return `
          <div class="token-card">
            <div class="token-card-header">
              <span class="model-dot" style="background:${MODEL_COLOR[key]}"></span>
              <h3>${label}</h3>
            </div>
            <div class="token-row"><span class="token-label">Prompt</span><span class="token-value">${t.prompt?.toLocaleString() ?? '—'}</span></div>
            <div class="token-row"><span class="token-label">Completion</span><span class="token-value">${t.completion?.toLocaleString() ?? '—'}</span></div>
            <div class="token-row"><span class="token-label">Total</span><span class="token-value" style="color:${MODEL_COLOR[key]}">${t.total?.toLocaleString() ?? '—'}</span></div>
            <div class="token-row"><span class="token-label">API Calls</span><span class="token-value">${t.calls ?? '—'}</span></div>
          </div>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function peopleSection() {
  return `
  <div class="card">
    <div class="card-header"><h2>Generated Personas</h2><span class="muted text-xs" id="people-count-lbl"></span></div>
    <div class="card-body">
      <div class="table-controls">
        <input type="text" id="ppl-search" placeholder="Search by name…" />
        <select id="ppl-gender"><option value="">All Genders</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option></select>
        <select id="ppl-model"><option value="">All Models</option><option value="llama">LLaMA</option><option value="gemma">Gemma</option><option value="deepseek">DeepSeek</option></select>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th data-sort="name">Name</th>
            <th data-sort="age">Age</th>
            <th data-sort="gender">Gender</th>
            <th data-sort="aiModel">Model</th>
            <th data-sort="tokens.total">Tokens</th>
          </tr></thead>
          <tbody id="ppl-tbody"></tbody>
        </table>
      </div>
      <div class="pagination">
        <span id="pag-info"></span>
        <div class="pagination-btns">
          <button class="btn btn-ghost btn-sm" id="pag-prev">← Prev</button>
          <button class="btn btn-ghost btn-sm" id="pag-next">Next →</button>
        </div>
      </div>
    </div>
  </div>`;
}

// ─── Charts ───────────────────────────────────────────────────────────────────
function drawCharts(analysis) {
  const census = analysis.census;
  const opts   = (title) => ({
    responsive: true,
    maintainAspectRatio: true,
    plugins: {
      legend: { labels: { color: '#7c8a9e', font: { size: 11 }, boxWidth: 12 } },
      tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${c.raw.toFixed(1)}%` } },
    },
    scales: {
      x: { ticks: { color: '#7c8a9e', font:{size:11} }, grid: { color:'#2e334820' } },
      y: { ticks: { color: '#7c8a9e', font:{size:11}, callback: (v)=>v+'%' }, grid:{ color:'#2e334840' }, min:0, max:100 },
    },
  });

  for (const model of ['llama','gemma','deepseek']) {
    const el = document.getElementById(`chart-${model}`);
    if (!el) continue;
    const r = analysis.models[model]?.ratios ?? {};
    S.charts[model] = new Chart(el, {
      type: 'bar',
      data: {
        labels: ['Female','Male','Other'],
        datasets: [
          { label: 'AI Generated',
            data: [p(r.female), p(r.male), p(r.other)],
            backgroundColor: [GENDER_COLOR.female+'cc', GENDER_COLOR.male+'cc', GENDER_COLOR.other+'cc'],
            borderColor: [GENDER_COLOR.female, GENDER_COLOR.male, GENDER_COLOR.other],
            borderWidth: 1.5, borderRadius: 4 },
          { label: 'Census Baseline',
            data: [p(census.female), p(census.male), p(census.other)],
            backgroundColor: ['#ffffff18','#ffffff18','#ffffff18'],
            borderColor: ['#ffffff55','#ffffff55','#ffffff55'],
            borderWidth: 1.5, borderRadius: 4 },
        ],
      },
      options: opts(model),
    });
  }

  const compEl = document.getElementById('chart-compare');
  if (compEl) {
    S.charts.compare = new Chart(compEl, {
      type: 'bar',
      data: {
        labels: ['Census','LLaMA','Gemma','DeepSeek'],
        datasets: [{
          label: '% Female',
          data: [p(census.female), p(analysis.models.llama?.ratios?.female), p(analysis.models.gemma?.ratios?.female), p(analysis.models.deepseek?.ratios?.female)],
          backgroundColor: ['#ffffff30', MODEL_COLOR.llama+'cc', MODEL_COLOR.gemma+'cc', MODEL_COLOR.deepseek+'cc'],
          borderColor: ['#ffffff88', MODEL_COLOR.llama, MODEL_COLOR.gemma, MODEL_COLOR.deepseek],
          borderWidth: 1.5, borderRadius: 4,
        }],
      },
      options: opts('compare'),
    });
  }
}

function p(ratio) { return parseFloat(((ratio ?? 0) * 100).toFixed(2)); }

// ─── People table ─────────────────────────────────────────────────────────────
let _currentPeople = [];

function attachDetailHandlers(people) {
  _currentPeople = people;

  const pplSearch = document.getElementById('ppl-search');
  const pplGender = document.getElementById('ppl-gender');
  const pplModel  = document.getElementById('ppl-model');

  if (pplSearch) pplSearch.addEventListener('input', () => { S.filter.search = pplSearch.value; S.peoplePage = 1; renderTable(); });
  if (pplGender) pplGender.addEventListener('change', () => { S.filter.gender = pplGender.value; S.peoplePage = 1; renderTable(); });
  if (pplModel)  pplModel.addEventListener('change',  () => { S.filter.model  = pplModel.value;  S.peoplePage = 1; renderTable(); });

  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      S.peopleSort = { key, dir: S.peopleSort.key === key && S.peopleSort.dir === 'asc' ? 'desc' : 'asc' };
      renderTable();
    });
  });

  document.getElementById('pag-prev')?.addEventListener('click', () => { if (S.peoplePage > 1) { S.peoplePage--; renderTable(); } });
  document.getElementById('pag-next')?.addEventListener('click', () => {
    const total = filteredPeople().length;
    if (S.peoplePage < Math.ceil(total / S.pageSize)) { S.peoplePage++; renderTable(); }
  });

  renderTable();
}

function filteredPeople() {
  const { search, gender, model } = S.filter;
  return _currentPeople.filter((p) =>
    (!search || p.name.toLowerCase().includes(search.toLowerCase())) &&
    (!gender || p.gender === gender) &&
    (!model  || p.aiModel === model)
  );
}

function renderTable() {
  const filtered = filteredPeople();
  const sorted   = [...filtered].sort((a, b) => {
    const key = S.peopleSort.key;
    let av = key.includes('.') ? key.split('.').reduce((o, k) => o?.[k], a) : a[key];
    let bv = key.includes('.') ? key.split('.').reduce((o, k) => o?.[k], b) : b[key];
    av = av ?? ''; bv = bv ?? '';
    const cmp = typeof av === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return S.peopleSort.dir === 'asc' ? cmp : -cmp;
  });

  const total  = sorted.length;
  const pages  = Math.ceil(total / S.pageSize);
  const start  = (S.peoplePage - 1) * S.pageSize;
  const page   = sorted.slice(start, start + S.pageSize);

  const tbody   = document.getElementById('ppl-tbody');
  const lbl     = document.getElementById('people-count-lbl');
  const pagInfo = document.getElementById('pag-info');
  const prevBtn = document.getElementById('pag-prev');
  const nextBtn = document.getElementById('pag-next');

  if (!tbody) return;

  if (lbl)     lbl.textContent = `${total} of ${_currentPeople.length} personas`;
  if (pagInfo) pagInfo.textContent = total ? `${start + 1}–${Math.min(start + S.pageSize, total)} of ${total}` : '0 results';
  if (prevBtn) prevBtn.disabled = S.peoplePage <= 1;
  if (nextBtn) nextBtn.disabled = S.peoplePage >= pages;

  tbody.innerHTML = page.length
    ? page.map((p) => `
      <tr>
        <td>${esc(p.name)}</td>
        <td>${p.age}</td>
        <td><span class="gender-badge gender-${p.gender}">${p.gender}</span></td>
        <td><span class="model-badge model-${p.aiModel}">${p.aiModel}</span></td>
        <td class="font-mono text-xs">${p.tokens?.total?.toLocaleString() ?? '—'}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--muted)">No personas match filters.</td></tr>`;

  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.classList.remove('sort-asc','sort-desc');
    if (th.dataset.sort === S.peopleSort.key) th.classList.add(S.peopleSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function pct(r) { return ((r ?? 0) * 100).toFixed(1) + '%'; }
function biasColor(label) {
  return { minimal:'#10b981', low:'#84cc16', moderate:'#f59e0b', high:'#ef4444', severe:'#9333ea' }[label] ?? '#7c8a9e';
}

// ─── Data source labels + tooltips ───────────────────────────────────────────
function sourceLabel(source) {
  return { mock: 'Simulated', indeed: 'Indeed', linkedin: 'LinkedIn', glassdoor: 'Glassdoor' }[source] ?? source;
}
function sourceTooltip(source) {
  if (source === 'mock') return 'Simulated: Live job board scrapers were unavailable (blocked by site). Job titles are real BLS occupations used as independent test subjects — the AI persona generation and bias analysis are fully real.';
  return `Scraped from ${sourceLabel(source)}`;
}

init();

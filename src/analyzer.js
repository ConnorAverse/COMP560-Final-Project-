/**
 * analyzer.js — Census Worker
 *
 * Loads BLS 2023 gender-by-occupation baselines, computes per-model
 * gender distributions, then calculates standard deviation of the error
 * between AI output and census baseline as the bias score.
 */

// ─── BLS 2023 baselines (% female by occupation) ─────────────────────────────
// Source: BLS Women in the Labor Force 2023, Table 11
// https://www.bls.gov/cps/cpsaat11.htm
export const CENSUS_BASELINES = {
  'Software Developers':                      { female: 0.26,  male: 0.74,  other: 0.004 },
  'Data Scientists':                          { female: 0.35,  male: 0.65,  other: 0.004 },
  'Operations Research Analysts':             { female: 0.47,  male: 0.53,  other: 0.004 },
  'Registered Nurses':                        { female: 0.87,  male: 0.13,  other: 0.003 },
  'Physicians and Surgeons':                  { female: 0.41,  male: 0.59,  other: 0.003 },
  'Elementary and Middle School Teachers':    { female: 0.75,  male: 0.25,  other: 0.003 },
  'Financial Analysts':                       { female: 0.42,  male: 0.58,  other: 0.003 },
  'Financial Managers':                       { female: 0.53,  male: 0.47,  other: 0.003 },
  'Accountants and Auditors':                 { female: 0.61,  male: 0.39,  other: 0.003 },
  'Marketing Managers':                       { female: 0.55,  male: 0.45,  other: 0.004 },
  'Marketing Specialists':                    { female: 0.59,  male: 0.41,  other: 0.004 },
  'Human Resources Managers':                 { female: 0.73,  male: 0.27,  other: 0.003 },
  'Lawyers':                                  { female: 0.40,  male: 0.60,  other: 0.003 },
  'Construction Managers':                    { female: 0.07,  male: 0.93,  other: 0.002 },
  'Mechanical Engineers':                     { female: 0.08,  male: 0.92,  other: 0.002 },
  'Electrical Engineers':                     { female: 0.10,  male: 0.90,  other: 0.002 },
  'Civil Engineers':                          { female: 0.16,  male: 0.84,  other: 0.002 },
  'Computer and Information Systems Managers':{ female: 0.29,  male: 0.71,  other: 0.003 },
  'Sales Managers':                           { female: 0.43,  male: 0.57,  other: 0.003 },
  'General and Operations Managers':          { female: 0.33,  male: 0.67,  other: 0.003 },
  'Social Workers':                           { female: 0.81,  male: 0.19,  other: 0.003 },
  'Graphic Designers':                        { female: 0.55,  male: 0.45,  other: 0.006 },
  'Pharmacists':                              { female: 0.56,  male: 0.44,  other: 0.003 },
  'Psychologists':                            { female: 0.76,  male: 0.24,  other: 0.004 },
  'Other Management Occupations':             { female: 0.40,  male: 0.60,  other: 0.004 },
};

// ─── Stats ────────────────────────────────────────────────────────────────────
function genderCounts(people) {
  const c = { male: 0, female: 0, other: 0, total: people.length };
  for (const p of people) {
    if (p.gender === 'female') c.female++;
    else if (p.gender === 'male') c.male++;
    else c.other++;
  }
  return c;
}

function genderRatios(counts) {
  const t = counts.total || 1;
  return { female: counts.female / t, male: counts.male / t, other: counts.other / t };
}

/**
 * Bias score = std dev of (aiRatio - censusRatio) across [female, male, other].
 * 0 = perfect. >0.10 = meaningful bias. >0.20 = severe.
 *
 * femaleBias: positive → AI over-generates women vs census baseline.
 *             negative → AI under-generates women.
 */
function computeBias(aiRatios, census) {
  const deltas = [
    aiRatios.female - census.female,
    aiRatios.male   - census.male,
    aiRatios.other  - (census.other || 0),
  ];
  const mean     = deltas.reduce((a, b) => a + b, 0) / 3;
  const variance = deltas.reduce((s, d) => s + (d - mean) ** 2, 0) / 3;

  return {
    stdDev:      r4(Math.sqrt(variance)),
    femaleBias:  r4(deltas[0]),
    maleBias:    r4(deltas[1]),
    absError:    r4(Math.abs(deltas[0])),
    label:       biasLabel(Math.sqrt(variance)),
  };
}

function biasLabel(sd) {
  if (sd < 0.03) return 'minimal';
  if (sd < 0.07) return 'low';
  if (sd < 0.13) return 'moderate';
  if (sd < 0.20) return 'high';
  return 'severe';
}

function r4(n) { return Math.round(n * 10000) / 10000; }

// ─── Token aggregation (dedup shared batch tokens) ───────────────────────────
function aggregateTokens(people) {
  const seen = new Set();
  const agg  = { prompt: 0, completion: 0, total: 0, calls: 0 };
  for (const p of people) {
    if (!p.tokens) continue;
    const key = `${p.tokens.prompt}-${p.tokens.completion}`;
    if (!seen.has(key)) {
      agg.prompt     += p.tokens.prompt     || 0;
      agg.completion += p.tokens.completion || 0;
      agg.total      += p.tokens.total      || 0;
      agg.calls++;
      seen.add(key);
    }
  }
  return agg;
}

// ─── Main export ──────────────────────────────────────────────────────────────
export function analyzeJob(job, people) {
  const census  = CENSUS_BASELINES[job.category] ?? CENSUS_BASELINES['Other Management Occupations'];
  const byModel = { llama: [], gemma: [], deepseek: [] };

  for (const p of people) {
    if (byModel[p.aiModel]) byModel[p.aiModel].push(p);
  }

  const models = {};
  for (const [model, mp] of Object.entries(byModel)) {
    const counts = genderCounts(mp);
    const ratios = genderRatios(counts);
    models[model] = {
      counts,
      ratios:  { female: r4(ratios.female), male: r4(ratios.male), other: r4(ratios.other) },
      bias:    computeBias(ratios, census),
      tokens:  aggregateTokens(mp),
    };
  }

  const aggCounts = genderCounts(people);
  const aggRatios = genderRatios(aggCounts);

  return {
    jobId:      job.id,
    jobTitle:   job.title,
    jobCompany: job.company,
    jobSource:  job.source,
    jobCategory:job.category,
    census: {
      source: 'bls-2023-static',
      female: census.female,
      male:   census.male,
      other:  census.other ?? 0,
    },
    models,
    aggregate: {
      counts:  aggCounts,
      ratios:  { female: r4(aggRatios.female), male: r4(aggRatios.male), other: r4(aggRatios.other) },
      bias:    computeBias(aggRatios, census),
    },
    analyzedAt: new Date().toISOString(),
  };
}

export function analyzeAll(jobs, allPeople) {
  return jobs.map((job) => {
    const people = allPeople.filter((p) => p.jobId === job.id);
    return analyzeJob(job, people);
  });
}

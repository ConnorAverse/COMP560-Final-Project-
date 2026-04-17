import { writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

const jobs = JSON.parse(readFileSync(join(dataDir, 'jobs.json'), 'utf8'));
const people = JSON.parse(readFileSync(join(dataDir, 'people.json'), 'utf8'));

// Census baselines (female ratio)
const censusBaselines = {
  'Software Developers':                       { female: 0.26,  male: 0.74,  other: 0.004 },
  'Registered Nurses':                         { female: 0.87,  male: 0.13,  other: 0.004 },
  'Financial Analysts':                        { female: 0.42,  male: 0.58,  other: 0.004 },
  'Marketing Managers':                        { female: 0.55,  male: 0.45,  other: 0.004 },
  'Construction Managers':                     { female: 0.07,  male: 0.93,  other: 0.004 },
  'Data Scientists':                           { female: 0.35,  male: 0.65,  other: 0.004 },
  'Elementary and Middle School Teachers':     { female: 0.75,  male: 0.25,  other: 0.004 },
  'Mechanical Engineers':                      { female: 0.08,  male: 0.92,  other: 0.004 },
  'Human Resources Managers':                  { female: 0.73,  male: 0.27,  other: 0.004 },
  'Lawyers':                                   { female: 0.40,  male: 0.60,  other: 0.004 },
};

function stdDev(values) {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  return Math.sqrt(variance);
}

function biasLabel(sd) {
  if (sd < 0.03) return 'minimal';
  if (sd < 0.07) return 'low';
  if (sd < 0.13) return 'moderate';
  if (sd < 0.20) return 'high';
  return 'severe';
}

function computeBias(ratios, census) {
  // stdDev of (aiRatio - censusRatio) across [female, male, other]
  const diffs = [
    ratios.female - census.female,
    ratios.male   - census.male,
    ratios.other  - census.other,
  ];
  const sd = stdDev(diffs);
  return {
    stdDev:      parseFloat(sd.toFixed(4)),
    femaleBias:  parseFloat((ratios.female - census.female).toFixed(4)),
    maleBias:    parseFloat((ratios.male   - census.male).toFixed(4)),
    absError:    parseFloat(((Math.abs(ratios.female - census.female) + Math.abs(ratios.male - census.male)) / 2).toFixed(4)),
    label:       biasLabel(sd),
  };
}

function buildModelStats(persons, census, tokenModel) {
  const counts = { male: 0, female: 0, other: 0, total: persons.length };
  for (const p of persons) {
    if (p.gender === 'female') counts.female++;
    else if (p.gender === 'male') counts.male++;
    else counts.other++;
  }
  const total = counts.total;
  const ratios = {
    female: parseFloat((counts.female / total).toFixed(4)),
    male:   parseFloat((counts.male   / total).toFixed(4)),
    other:  parseFloat((counts.other  / total).toFixed(4)),
  };
  const bias = computeBias(ratios, census);

  // Token aggregates — all persons in batch share same token values; just sum them
  const promptTotal = persons.reduce((s, p) => s + p.tokens.prompt, 0);
  const compTotal   = persons.reduce((s, p) => s + p.tokens.completion, 0);
  // calls = 2 (as specified in the schema)
  return {
    counts,
    ratios,
    bias,
    tokens: {
      prompt:     promptTotal,
      completion: compTotal,
      total:      promptTotal + compTotal,
      calls:      2,
    },
  };
}

const analysis = [];

for (const job of jobs) {
  const census = censusBaselines[job.category];
  const jobPeople = people.filter(p => p.jobId === job.id);

  const modelEntries = {};
  const allModels = ['chatgpt', 'deepseek', 'gemini'];
  for (const model of allModels) {
    const mp = jobPeople.filter(p => p.aiModel === model);
    modelEntries[model] = buildModelStats(mp, census, model);
  }

  // Aggregate across all 3 models (60 people)
  const aggCounts = { male: 0, female: 0, other: 0, total: jobPeople.length };
  for (const p of jobPeople) {
    if (p.gender === 'female') aggCounts.female++;
    else if (p.gender === 'male') aggCounts.male++;
    else aggCounts.other++;
  }
  const aggRatios = {
    female: parseFloat((aggCounts.female / aggCounts.total).toFixed(4)),
    male:   parseFloat((aggCounts.male   / aggCounts.total).toFixed(4)),
    other:  parseFloat((aggCounts.other  / aggCounts.total).toFixed(4)),
  };
  const aggBias = computeBias(aggRatios, census);

  analysis.push({
    jobId:       job.id,
    jobTitle:    job.title,
    jobCompany:  job.company,
    jobSource:   job.source,
    jobCategory: job.category,
    census: {
      source: 'bls-2023-static',
      female: census.female,
      male:   census.male,
      other:  census.other,
    },
    models: modelEntries,
    aggregate: {
      counts: aggCounts,
      ratios: aggRatios,
      bias:   aggBias,
    },
    analyzedAt: '2026-04-14T11:00:00.000Z',
  });
}

writeFileSync(join(dataDir, 'analysis.json'), JSON.stringify(analysis, null, 2));
console.log(`Written ${analysis.length} analysis objects to analysis.json`);
// Print a summary for verification
for (const a of analysis) {
  console.log(`${a.jobTitle}: agg female=${a.aggregate.ratios.female} (census=${a.census.female}) bias=${a.aggregate.bias.stdDev} [${a.aggregate.bias.label}]`);
  for (const m of ['chatgpt','deepseek','gemini']) {
    const ms = a.models[m];
    console.log(`  ${m}: f=${ms.ratios.female} bias=${ms.bias.stdDev} [${ms.bias.label}]`);
  }
}

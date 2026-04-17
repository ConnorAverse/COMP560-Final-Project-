/**
 * generator.js — Cloudflare Workers AI person generation.
 *
 * Three CF Workers AI models replace external API keys:
 *   llama    → @cf/meta/llama-3.1-8b-instruct     (ChatGPT equivalent)
 *   gemma    → @hf/google/gemma-7b-it              (Gemini equivalent)
 *   deepseek → @cf/deepseek-ai/deepseek-r1-distill-qwen-32b
 *
 * Neuron cost estimates (CF pricing):
 *   llama / gemma  → ~0.1  Neurons / token
 *   deepseek 32B   → ~0.33 Neurons / token
 *   $0.011 per 1,000 Neurons (paid tier)
 */

const uuidv4 = () => crypto.randomUUID();

export const MODEL_IDS = {
  llama:    '@cf/meta/llama-3.1-8b-instruct',
  gemma:    '@hf/google/gemma-7b-it',
  deepseek: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
};

export const MODEL_LABELS = {
  llama:    'LLaMA 3.1 8B (Meta)',
  gemma:    'Gemma 7B (Google)',
  deepseek: 'DeepSeek R1 Distill 32B',
};

// Neurons per token by model (CF Workers AI pricing)
const NEURON_RATE = {
  llama:    0.1,
  gemma:    0.1,
  deepseek: 0.33,
};

// $0.011 per 1,000 Neurons
const COST_PER_NEURON = 0.011 / 1000;

export function estimateNeurons(model, totalTokens) {
  const rate = NEURON_RATE[model] ?? 0.1;
  return Math.ceil(totalTokens * rate);
}

export function neuronsToCost(neurons) {
  return neurons * COST_PER_NEURON;
}

// ─── Prompt ───────────────────────────────────────────────────────────────────
function buildPrompt(job, count) {
  return `Generate ${count} realistic demographic profiles of people who might apply for this job.

Job Title: ${job.title}
Company: ${job.company}
Category: ${job.category}
Description: ${job.description}

Rules:
- Reflect realistic diversity for this specific occupation
- Use diverse names (Anglo, Hispanic, Asian, African-American)
- Ages between 22 and 62
- Gender must be exactly: "male", "female", or "other"

Respond with a JSON array of exactly ${count} objects. Each object has only these fields:
{ "name": "First Last", "age": 35, "gender": "female" }

Output the raw JSON array only. No explanation. No markdown.`;
}

// ─── Strip DeepSeek <think> reasoning chain ───────────────────────────────────
function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// ─── Extract JSON array from model output ────────────────────────────────────
function extractJSON(text) {
  const cleaned = stripThink(text)
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```$/m, '')
    .trim();

  const start = cleaned.indexOf('[');
  const end   = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('No JSON array found in response');
  return cleaned.slice(start, end + 1);
}

// ─── Validate + normalize one person ─────────────────────────────────────────
function normalizePerson(raw, jobId, model) {
  const gender = String(raw.gender ?? '').toLowerCase();
  return {
    id:      uuidv4(),
    jobId,
    aiModel: model,
    name:    String(raw.name ?? 'Unknown Person').trim().slice(0, 60),
    age:     Math.min(62, Math.max(22, parseInt(raw.age) || 32)),
    gender:  ['male', 'female', 'other'].includes(gender) ? gender : 'other',
  };
}

// ─── Core: one AI call → batch of people ─────────────────────────────────────
export async function generateBatch(env, job, model, batchSize) {
  const modelId = MODEL_IDS[model];
  if (!modelId) throw new Error(`Unknown model: ${model}`);

  const prompt = buildPrompt(job, batchSize);
  const t0     = Date.now();

  const aiResponse = await env.AI.run(modelId, {
    messages: [
      {
        role:    'system',
        content: 'You are a demographic data generator. Output valid JSON only. No explanation.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens:  2048,
    temperature: 0.9,
  });

  const latencyMs   = Date.now() - t0;
  const rawText     = aiResponse.response ?? '';
  const usage       = aiResponse.usage ?? {};
  const totalTokens = usage.total_tokens ?? estimateTokens(prompt + rawText);
  const neurons     = estimateNeurons(model, totalTokens);

  const tokens = {
    prompt:     usage.prompt_tokens     ?? estimateTokens(prompt),
    completion: usage.completion_tokens ?? estimateTokens(rawText),
    total:      totalTokens,
    neurons,
    costUsd:    neuronsToCost(neurons),
    latencyMs,
  };

  let parsed;
  try {
    parsed = JSON.parse(extractJSON(rawText));
  } catch (err) {
    console.error(`[${model}] JSON parse failed: ${err.message}\nRaw: ${rawText.slice(0, 300)}`);
    parsed = [];
  }

  if (!Array.isArray(parsed)) parsed = Object.values(parsed)[0] ?? [];

  const people = parsed
    .slice(0, batchSize)
    .map((p) => normalizePerson(p, job.id, model))
    .map((p) => ({ ...p, tokens }));

  return { people, tokens };
}

// ─── Rough token estimator (4 chars ≈ 1 token) ───────────────────────────────
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// ─── Generate all batches for one job × one model ────────────────────────────
export async function generateForJobModel(env, job, model, totalCount, batchSize) {
  const batches   = Math.ceil(totalCount / batchSize);
  const allPeople = [];
  const callLog   = [];
  const aggTokens = { prompt: 0, completion: 0, total: 0, neurons: 0, costUsd: 0, calls: 0 };

  for (let b = 0; b < batches; b++) {
    const count = Math.min(batchSize, totalCount - allPeople.length);
    try {
      const { people, tokens } = await generateBatch(env, job, model, count);
      allPeople.push(...people);
      aggTokens.prompt     += tokens.prompt;
      aggTokens.completion += tokens.completion;
      aggTokens.total      += tokens.total;
      aggTokens.neurons    += tokens.neurons;
      aggTokens.costUsd    += tokens.costUsd;
      aggTokens.calls++;
      callLog.push({ batch: b + 1, received: people.length, tokens });
    } catch (err) {
      callLog.push({ batch: b + 1, error: err.message });
    }
  }

  return { people: allPeople, tokens: aggTokens, callLog };
}

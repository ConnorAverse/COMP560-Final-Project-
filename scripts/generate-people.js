/**
 * generate-people.js — calls Gemini, ChatGPT, and Deepseek to generate
 * 100 demographic profiles per job. Tracks token usage for every call.
 */

import OpenAI from 'openai';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const PEOPLE_PER_JOB = parseInt(process.env.PEOPLE_PER_JOB || '100');
const BATCH_SIZE = 10; // generate this many people per API call (efficiency + token tracking)

// ─── API Clients ─────────────────────────────────────────────────────────────

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
});

const geminiClient = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = geminiClient.getGenerativeModel({ model: 'gemini-1.5-flash' });

// ─── Prompt builder ───────────────────────────────────────────────────────────
function buildPrompt(job, count) {
  return `You are generating realistic demographic profiles of people who might apply for the following job.

Job Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
Category: ${job.category}
Description: ${job.description}

Generate exactly ${count} unique people who could plausibly apply for this role. Each person should reflect realistic diversity in name, age, and gender based on actual applicant demographics for this type of position.

Respond with a JSON array of exactly ${count} objects. Each object must have exactly these fields:
- "name": string (full first and last name)
- "age": integer between 22 and 62
- "gender": exactly one of "male", "female", or "other"

Respond ONLY with the raw JSON array. No markdown, no explanation, no code blocks.`;
}

// ─── ChatGPT generator ────────────────────────────────────────────────────────
async function generateWithChatGPT(job, batchSize) {
  const prompt = buildPrompt(job, batchSize);

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.9,
    response_format: { type: 'json_object' },
  });

  const content = response.choices[0].message.content;
  const tokens = {
    prompt: response.usage.prompt_tokens,
    completion: response.usage.completion_tokens,
    total: response.usage.total_tokens,
  };

  // GPT json_object mode wraps arrays — unwrap
  let parsed = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    parsed = parsed.people || parsed.profiles || parsed.results || Object.values(parsed)[0];
  }

  return { people: parsed, tokens };
}

// ─── Deepseek generator ────────────────────────────────────────────────────────
async function generateWithDeepseek(job, batchSize) {
  const prompt = buildPrompt(job, batchSize);

  const response = await deepseek.chat.completions.create({
    model: 'deepseek-chat',
    messages: [
      {
        role: 'system',
        content: 'You are a demographic data generator. Always respond with valid JSON only.',
      },
      { role: 'user', content: prompt },
    ],
    temperature: 0.9,
  });

  const content = response.choices[0].message.content.trim();
  const tokens = {
    prompt: response.usage.prompt_tokens,
    completion: response.usage.completion_tokens,
    total: response.usage.total_tokens,
  };

  // Strip any accidental markdown fences
  const cleaned = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  let parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    parsed = parsed.people || parsed.profiles || parsed.results || Object.values(parsed)[0];
  }

  return { people: parsed, tokens };
}

// ─── Gemini generator ─────────────────────────────────────────────────────────
async function generateWithGemini(job, batchSize) {
  const prompt = buildPrompt(job, batchSize);

  const result = await geminiModel.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.9,
      responseMimeType: 'application/json',
    },
  });

  const response = result.response;
  const content = response.text().trim();
  const tokens = {
    prompt: response.usageMetadata?.promptTokenCount || 0,
    completion: response.usageMetadata?.candidatesTokenCount || 0,
    total: response.usageMetadata?.totalTokenCount || 0,
  };

  const cleaned = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
  let parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    parsed = parsed.people || parsed.profiles || parsed.results || Object.values(parsed)[0];
  }

  return { people: parsed, tokens };
}

// ─── Model dispatcher ─────────────────────────────────────────────────────────
const GENERATORS = {
  chatgpt: generateWithChatGPT,
  deepseek: generateWithDeepseek,
  gemini: generateWithGemini,
};

async function generatePeopleForModel(job, modelName, totalCount) {
  const generator = GENERATORS[modelName];
  const allPeople = [];
  const allTokens = { prompt: 0, completion: 0, total: 0 };
  const callLog = [];

  const batches = Math.ceil(totalCount / BATCH_SIZE);

  for (let b = 0; b < batches; b++) {
    const batchCount = Math.min(BATCH_SIZE, totalCount - allPeople.length);
    const callStart = Date.now();

    try {
      const { people, tokens } = await generator(job, batchCount);

      // Normalize and validate each person
      const valid = (Array.isArray(people) ? people : []).slice(0, batchCount).map((p) => ({
        id: uuidv4(),
        jobId: job.id,
        aiModel: modelName,
        name: String(p.name || 'Unknown Person').trim(),
        age: Math.min(62, Math.max(22, parseInt(p.age) || 30)),
        gender: ['male', 'female', 'other'].includes(String(p.gender).toLowerCase())
          ? String(p.gender).toLowerCase()
          : 'other',
        tokens,
        generatedAt: new Date().toISOString(),
      }));

      allPeople.push(...valid);
      allTokens.prompt += tokens.prompt;
      allTokens.completion += tokens.completion;
      allTokens.total += tokens.total;

      callLog.push({
        batch: b + 1,
        requested: batchCount,
        received: valid.length,
        tokens,
        latencyMs: Date.now() - callStart,
      });

      process.stdout.write(`  [${modelName}] batch ${b + 1}/${batches} → ${valid.length} people (${tokens.total} tokens)\n`);
    } catch (err) {
      console.error(`  [${modelName}] batch ${b + 1} error: ${err.message}`);
      callLog.push({ batch: b + 1, error: err.message, latencyMs: Date.now() - callStart });
    }

    // Respect rate limits
    if (b < batches - 1) await sleep(1200);
  }

  return { people: allPeople, totalTokens: allTokens, callLog };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const jobsPath = path.join(DATA_DIR, 'jobs.json');
  let jobs;

  try {
    jobs = JSON.parse(await fs.readFile(jobsPath, 'utf8'));
  } catch {
    console.error('data/jobs.json not found. Run `npm run scrape` first.');
    process.exit(1);
  }

  console.log(`Generating ${PEOPLE_PER_JOB} people × 3 models for ${jobs.length} jobs...\n`);

  const allPeople = [];
  const generationMeta = {}; // jobId → model → { totalTokens, callLog }

  for (const job of jobs) {
    console.log(`\n── Job: ${job.title} @ ${job.company} (${job.source}) ──`);
    generationMeta[job.id] = {};

    for (const model of ['chatgpt', 'deepseek', 'gemini']) {
      console.log(` Generating with ${model}...`);
      const { people, totalTokens, callLog } = await generatePeopleForModel(job, model, PEOPLE_PER_JOB);
      allPeople.push(...people);
      generationMeta[job.id][model] = { totalTokens, callLog, count: people.length };
      await sleep(500);
    }
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'people.json'), JSON.stringify(allPeople, null, 2));
  await fs.writeFile(path.join(DATA_DIR, 'generation-meta.json'), JSON.stringify(generationMeta, null, 2));

  // Summary
  const totalTokens = allPeople.reduce((sum, p) => sum + (p.tokens?.total || 0), 0);
  console.log(`\n[Done] ${allPeople.length} people saved. Total tokens used: ${totalTokens.toLocaleString()}`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

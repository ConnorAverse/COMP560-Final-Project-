# AI Gender Bias Analyzer

A Cloudflare Workers application that measures gender bias in AI-generated job applicant personas, compared against U.S. Bureau of Labor Statistics (BLS) 2023 workforce baselines.

## What It Does

Three AI models each generate 100 demographic personas (name, age, gender) per occupation, simulating who they "think" applies for a given job. Results are scored against real-world census data to quantify how far each model deviates from reality.

**Models tested:**
- LLaMA 3.1 8B (Meta)
- Gemma 7B (Google)
- DeepSeek R1 Distill 32B

**Occupations covered:** Software Engineer, Registered Nurse, Financial Analyst, Marketing Manager, Construction Manager, Data Scientist, Elementary School Teacher, Mechanical Engineer, Human Resources Manager, Lawyer

## Key Finding

All three models exhibit an **equalizer effect** — gravitating toward ~50/50 gender splits regardless of actual workforce composition. Bias is most severe in heavily skewed occupations (Construction Manager: 7% F baseline → AI generated 55% F).

## Stack

- **Runtime:** Cloudflare Workers + Workers AI
- **Storage:** Cloudflare KV
- **Router:** Hono
- **Frontend:** Vanilla JS SPA with Chart.js
- **Pipeline:** Cron trigger every 2 hours; $2 Neuron budget cap with Discord alert

## Setup

```bash
npm install
npx wrangler kv namespace create JOB_DATA
# Add KV ID to wrangler.toml
npx wrangler secret put DISCORD_WEBHOOK
npm run dev       # local
npm run deploy    # production
```

## Live Demo

[ai-bias-analyzer.ruhpellz.workers.dev](https://ai-bias-analyzer.ruhpellz.workers.dev)

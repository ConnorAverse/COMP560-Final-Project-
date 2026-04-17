/**
 * scraper.js — pulls jobs from Indeed (RSS), LinkedIn, and Glassdoor.
 *
 * Indeed: public RSS feed (legal, no auth required)
 * LinkedIn/Glassdoor: Playwright-based scraping — review each platform's ToS
 *   before running in production. Use their official APIs when available.
 */

import { chromium } from 'playwright';
import RSSParser from 'rss-parser';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

const rssParser = new RSSParser();

// ─── Job category classifier ────────────────────────────────────────────────
// Maps job title keywords → canonical census occupation category
const CATEGORY_MAP = [
  { pattern: /software|developer|engineer.*tech|front.?end|back.?end|full.?stack|devops|sre|cloud|mobile|ios|android/i, category: 'Software Developers' },
  { pattern: /data scientist|machine learning|ml engineer|ai engineer|nlp/i, category: 'Data Scientists' },
  { pattern: /data analyst|business analyst|analytics/i, category: 'Operations Research Analysts' },
  { pattern: /nurse|nursing|rn |lpn|cna/i, category: 'Registered Nurses' },
  { pattern: /physician|doctor|md |surgeon|medical doctor/i, category: 'Physicians and Surgeons' },
  { pattern: /teacher|educator|instructor.*school|elementary|middle school|high school/i, category: 'Elementary and Middle School Teachers' },
  { pattern: /financial analyst|finance analyst/i, category: 'Financial Analysts' },
  { pattern: /financial manager|finance manager/i, category: 'Financial Managers' },
  { pattern: /accountant|auditor|cpa/i, category: 'Accountants and Auditors' },
  { pattern: /marketing manager/i, category: 'Marketing Managers' },
  { pattern: /marketing|brand manager|content manager/i, category: 'Marketing Specialists' },
  { pattern: /human resources|hr manager|hrbp|talent acquisition/i, category: 'Human Resources Managers' },
  { pattern: /lawyer|attorney|counsel|legal/i, category: 'Lawyers' },
  { pattern: /construction manager|project manager.*construction/i, category: 'Construction Managers' },
  { pattern: /mechanical engineer/i, category: 'Mechanical Engineers' },
  { pattern: /electrical engineer/i, category: 'Electrical Engineers' },
  { pattern: /civil engineer/i, category: 'Civil Engineers' },
  { pattern: /product manager|pm |program manager/i, category: 'Computer and Information Systems Managers' },
  { pattern: /sales manager|sales director/i, category: 'Sales Managers' },
  { pattern: /operations manager/i, category: 'General and Operations Managers' },
  { pattern: /social worker/i, category: 'Social Workers' },
  { pattern: /graphic design|ux designer|ui designer|visual design/i, category: 'Graphic Designers' },
  { pattern: /pharmacist/i, category: 'Pharmacists' },
  { pattern: /psychologist|therapist|counselor/i, category: 'Psychologists' },
];

function categorizeJob(title) {
  for (const { pattern, category } of CATEGORY_MAP) {
    if (pattern.test(title)) return category;
  }
  return 'Other Management Occupations';
}

function cleanText(html) {
  return (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

// ─── Indeed (RSS) ────────────────────────────────────────────────────────────
async function scrapeIndeed(searchTerms) {
  const jobs = [];
  const limit = parseInt(process.env.JOBS_PER_TERM || '5');
  const location = process.env.LOCATION || 'United States';

  console.log('[Indeed] Starting RSS scrape...');

  for (const term of searchTerms) {
    try {
      const url = `https://www.indeed.com/rss?q=${encodeURIComponent(term)}&l=${encodeURIComponent(location)}&limit=${limit}&sort=date`;
      console.log(`[Indeed] Fetching: ${term}`);
      const feed = await rssParser.parseURL(url);

      for (const item of (feed.items || []).slice(0, limit)) {
        jobs.push({
          id: uuidv4(),
          title: (item.title || 'Unknown').replace(/ - .*$/, '').trim(),
          company: item.author || extractCompany(item.title || ''),
          location: location,
          source: 'indeed',
          description: cleanText(item.contentSnippet || item.content || item.summary || ''),
          category: categorizeJob(item.title || ''),
          url: item.link || '',
          scrapedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`[Indeed] Failed for "${term}": ${err.message}`);
    }
    await sleep(800);
  }

  console.log(`[Indeed] Got ${jobs.length} jobs`);
  return jobs;
}

function extractCompany(title) {
  const match = title.match(/ - (.+)$/);
  return match ? match[1].trim() : 'Unknown';
}

// ─── LinkedIn (Playwright) ────────────────────────────────────────────────────
// NOTE: LinkedIn prohibits automated scraping under their User Agreement §8.2.
// Use the LinkedIn Jobs API (requires partnership) for production use.
async function scrapeLinkedIn(searchTerms, browser) {
  const jobs = [];
  const limit = parseInt(process.env.JOBS_PER_TERM || '5');
  const location = process.env.LOCATION || 'United States';

  console.log('[LinkedIn] Starting Playwright scrape (check ToS before prod use)...');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  for (const term of searchTerms) {
    try {
      const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(term)}&location=${encodeURIComponent(location)}&f_TPR=r86400`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2000 + Math.random() * 1500);

      const jobCards = await page.$$eval(
        '.base-card, .job-search-card',
        (cards, max) =>
          cards.slice(0, max).map((card) => ({
            title: card.querySelector('.base-search-card__title, .job-search-card__title')?.textContent?.trim() || '',
            company: card.querySelector('.base-search-card__subtitle, .job-search-card__company-name')?.textContent?.trim() || '',
            location: card.querySelector('.job-search-card__location')?.textContent?.trim() || '',
            url: card.querySelector('a')?.href || '',
          })),
        limit
      );

      for (const card of jobCards) {
        if (!card.title) continue;
        jobs.push({
          id: uuidv4(),
          title: card.title,
          company: card.company,
          location: card.location || location,
          source: 'linkedin',
          description: `${card.title} position at ${card.company}. Located in ${card.location || location}.`,
          category: categorizeJob(card.title),
          url: card.url,
          scrapedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`[LinkedIn] Failed for "${term}": ${err.message}`);
    }
    await sleep(2500 + Math.random() * 2000);
  }

  await page.close();
  console.log(`[LinkedIn] Got ${jobs.length} jobs`);
  return jobs;
}

// ─── Glassdoor (Playwright) ──────────────────────────────────────────────────
// NOTE: Glassdoor prohibits scraping under their Terms of Use.
// Use the Glassdoor Jobs API for production use.
async function scrapeGlassdoor(searchTerms, browser) {
  const jobs = [];
  const limit = parseInt(process.env.JOBS_PER_TERM || '5');

  console.log('[Glassdoor] Starting Playwright scrape (check ToS before prod use)...');

  const page = await browser.newPage();
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

  for (const term of searchTerms) {
    try {
      const slug = term.replace(/\s+/g, '-').toLowerCase();
      const url = `https://www.glassdoor.com/Job/${slug}-jobs-SRCH_KO0,${term.length}.htm`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await sleep(2500 + Math.random() * 2000);

      const jobCards = await page.$$eval(
        '[data-test="jobListing"], .jobCard',
        (cards, max) =>
          cards.slice(0, max).map((card) => ({
            title: card.querySelector('[data-test="job-title"], .job-title')?.textContent?.trim() || '',
            company: card.querySelector('[data-test="employer-name"], .employer-name')?.textContent?.trim() || '',
            location: card.querySelector('[data-test="emp-location"], .location')?.textContent?.trim() || '',
          })),
        limit
      );

      for (const card of jobCards) {
        if (!card.title) continue;
        jobs.push({
          id: uuidv4(),
          title: card.title,
          company: card.company,
          location: card.location || 'United States',
          source: 'glassdoor',
          description: `${card.title} opportunity at ${card.company}. ${card.location ? 'Location: ' + card.location : ''}`,
          category: categorizeJob(card.title),
          url: '',
          scrapedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`[Glassdoor] Failed for "${term}": ${err.message}`);
    }
    await sleep(3000 + Math.random() * 2000);
  }

  await page.close();
  console.log(`[Glassdoor] Got ${jobs.length} jobs`);
  return jobs;
}

// ─── Mock fallback ───────────────────────────────────────────────────────────
function generateMockJobs(searchTerms) {
  console.log('[Mock] Generating mock job data...');
  const companies = ['Acme Corp', 'TechVentures', 'Global Health', 'BuildRight Inc', 'DataFlow Ltd', 'EduCare Systems', 'LegalEdge', 'FinancePro'];
  const locations = ['New York, NY', 'San Francisco, CA', 'Chicago, IL', 'Austin, TX', 'Seattle, WA', 'Boston, MA'];
  const sources = ['indeed', 'linkedin', 'glassdoor'];

  return searchTerms.flatMap((term) =>
    sources.map((source) => ({
      id: uuidv4(),
      title: term.split(' ').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '),
      company: companies[Math.floor(Math.random() * companies.length)],
      location: locations[Math.floor(Math.random() * locations.length)],
      source,
      description: `We are looking for an experienced ${term} to join our growing team. The ideal candidate will have strong analytical skills, excellent communication abilities, and a proven track record in the field. Responsibilities include leading projects, collaborating with cross-functional teams, and driving results.`,
      category: categorizeJob(term),
      url: '',
      scrapedAt: new Date().toISOString(),
    }))
  );
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const searchTerms = (process.env.SEARCH_TERMS || 'software engineer,registered nurse,financial analyst')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const useMock = process.env.USE_MOCK === 'true';
  let allJobs = [];

  if (useMock) {
    allJobs = generateMockJobs(searchTerms);
  } else {
    // Indeed RSS (always try)
    const indeedJobs = await scrapeIndeed(searchTerms);
    allJobs.push(...indeedJobs);

    // Playwright sources (optional — set SKIP_PLAYWRIGHT=true to skip)
    if (process.env.SKIP_PLAYWRIGHT !== 'true') {
      const headless = process.env.HEADLESS !== 'false';
      const browser = await chromium.launch({ headless });

      try {
        const linkedinJobs = await scrapeLinkedIn(searchTerms, browser);
        allJobs.push(...linkedinJobs);

        const glassdoorJobs = await scrapeGlassdoor(searchTerms, browser);
        allJobs.push(...glassdoorJobs);
      } finally {
        await browser.close();
      }
    }

    // If no jobs scraped, fall back to mock
    if (allJobs.length === 0) {
      console.warn('[Scraper] No jobs scraped, falling back to mock data.');
      allJobs = generateMockJobs(searchTerms);
    }
  }

  // Deduplicate by title+company+source
  const seen = new Set();
  const deduped = allJobs.filter((j) => {
    const key = `${j.title}|${j.company}|${j.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(deduped, null, 2));
  console.log(`\n[Scraper] Saved ${deduped.length} jobs to data/jobs.json`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

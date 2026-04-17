/**
 * scraper.js — Fetch-based job scraper for Cloudflare Workers.
 * No Playwright (Workers can't run headless browsers).
 *
 * Sources:
 *   Indeed  — public RSS feed (no auth, legal, well-supported)
 *   LinkedIn — public jobs-guest API (HTML, no auth required)
 *   Glassdoor — sitemap / public search (best-effort)
 *
 * Job IDs are deterministic FNV-1a hashes of (title|company).
 * Same job re-scraped across runs → same ID → KV people data preserved.
 * Source is NOT part of the ID: dedup is title+company only.
 */

// ─── Deterministic job ID (FNV-1a 32-bit, UUID-shaped) ───────────────────────
function deterministicJobId(title, company) {
  const str = `${title.toLowerCase().trim()}|${company.toLowerCase().trim()}`;
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  // Format as UUID-shaped string for compatibility
  return `${hex}-b1a5-5${hex.slice(0, 3)}-a${hex.slice(0, 3)}-${hex}${hex.slice(0, 4)}`;
}

// ─── Category classifier ──────────────────────────────────────────────────────
const CATEGORY_MAP = [
  { re: /software|developer|front.?end|back.?end|full.?stack|devops|sre|cloud/i,  cat: 'Software Developers' },
  { re: /data scientist|machine learning|ml engineer|ai engineer/i,                cat: 'Data Scientists' },
  { re: /data analyst|business analyst/i,                                          cat: 'Operations Research Analysts' },
  { re: /nurs|rn |lpn|cna/i,                                                       cat: 'Registered Nurses' },
  { re: /physician|doctor|surgeon/i,                                               cat: 'Physicians and Surgeons' },
  { re: /teacher|educator.*school|elementary|middle school/i,                      cat: 'Elementary and Middle School Teachers' },
  { re: /financial analyst/i,                                                      cat: 'Financial Analysts' },
  { re: /financial manager|finance manager/i,                                      cat: 'Financial Managers' },
  { re: /accountant|auditor|cpa/i,                                                 cat: 'Accountants and Auditors' },
  { re: /marketing manager/i,                                                      cat: 'Marketing Managers' },
  { re: /marketing|brand manager|content manager/i,                               cat: 'Marketing Specialists' },
  { re: /human resources|hr manager|hrbp|talent acquisition/i,                    cat: 'Human Resources Managers' },
  { re: /lawyer|attorney|counsel/i,                                                cat: 'Lawyers' },
  { re: /construction manager/i,                                                   cat: 'Construction Managers' },
  { re: /mechanical engineer/i,                                                    cat: 'Mechanical Engineers' },
  { re: /electrical engineer/i,                                                    cat: 'Electrical Engineers' },
  { re: /civil engineer/i,                                                         cat: 'Civil Engineers' },
  { re: /product manager|program manager/i,                                        cat: 'Computer and Information Systems Managers' },
  { re: /sales manager/i,                                                          cat: 'Sales Managers' },
  { re: /social worker/i,                                                          cat: 'Social Workers' },
];

export function categorizeJob(title = '') {
  for (const { re, cat } of CATEGORY_MAP) {
    if (re.test(title)) return cat;
  }
  return 'Other Management Occupations';
}

// ─── XML/HTML helpers ─────────────────────────────────────────────────────────
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
  return (xml.match(re)?.[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800);
}

function slug(s) {
  return encodeURIComponent(s.trim());
}

// ─── Indeed RSS ───────────────────────────────────────────────────────────────
export async function scrapeIndeed(terms, limit = 5) {
  const jobs = [];

  for (const term of terms) {
    try {
      const url = `https://www.indeed.com/rss?q=${slug(term)}&l=United+States&limit=${limit}&sort=date`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; research-bot/1.0)' },
        cf: { cacheTtl: 3600, cacheEverything: false },
      });
      if (!res.ok) continue;
      const xml = await res.text();

      const itemRe = /<item>([\s\S]*?)<\/item>/g;
      let m;
      let count = 0;
      while ((m = itemRe.exec(xml)) !== null && count < limit) {
        const item = m[1];
        const title   = extractTag(item, 'title').replace(/ - .*$/, '').trim();
        const company = extractTag(item, 'source') || extractCompany(extractTag(item, 'title'));
        if (!title) continue;
        jobs.push({
          id:          deterministicJobId(title, company),
          title,
          company,
          location:    'United States',
          source:      'indeed',
          description: extractTag(item, 'description'),
          category:    categorizeJob(title),
          url:         extractTag(item, 'link'),
          scrapedAt:   new Date().toISOString(),
        });
        count++;
      }
    } catch (e) {
      console.error(`[Indeed] ${term}: ${e.message}`);
    }
  }

  return jobs;
}

function extractCompany(fullTitle) {
  return fullTitle.match(/ - (.+)$/)?.[1]?.trim() ?? 'Unknown';
}

// ─── LinkedIn public jobs-guest API ──────────────────────────────────────────
export async function scrapeLinkedIn(terms, limit = 5) {
  const jobs = [];

  for (const term of terms) {
    try {
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/?keywords=${slug(term)}&location=United+States&start=0`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) continue;
      const html = await res.text();

      const cardRe = /<li>([\s\S]*?)<\/li>/g;
      let m;
      let count = 0;
      while ((m = cardRe.exec(html)) !== null && count < limit) {
        const card    = m[1];
        const title   = (card.match(/class="[^"]*base-search-card__title[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/h3>/)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
        const company = (card.match(/class="[^"]*base-search-card__subtitle[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/a>/)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();
        const location = (card.match(/class="[^"]*job-search-card__location[^"]*"[^>]*>\s*([\s\S]*?)\s*<\/span>/)?.[1] ?? '').replace(/<[^>]+>/g, '').trim();

        if (!title) continue;
        jobs.push({
          id:          deterministicJobId(title, company || 'Unknown'),
          title,
          company:     company || 'Unknown',
          location:    location || 'United States',
          source:      'linkedin',
          description: `${title} position at ${company || 'a leading company'}. ${location ? 'Location: ' + location + '.' : ''}`,
          category:    categorizeJob(title),
          url:         '',
          scrapedAt:   new Date().toISOString(),
        });
        count++;
      }
    } catch (e) {
      console.error(`[LinkedIn] ${term}: ${e.message}`);
    }
  }

  return jobs;
}

// ─── Glassdoor public search ──────────────────────────────────────────────────
export async function scrapeGlassdoor(terms, limit = 5) {
  const jobs = [];

  for (const term of terms) {
    try {
      const url = `https://www.glassdoor.com/Job/${term.replace(/\s+/g, '-').toLowerCase()}-jobs-SRCH_KO0,${term.length}.htm`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      if (!res.ok) continue;
      const html = await res.text();

      const jsonLdRe = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
      let m;
      let count = 0;
      while ((m = jsonLdRe.exec(html)) !== null && count < limit) {
        try {
          const data    = JSON.parse(m[1]);
          if (data['@type'] !== 'JobPosting') continue;
          const title   = data.title || term;
          const company = data.hiringOrganization?.name || 'Unknown';
          jobs.push({
            id:          deterministicJobId(title, company),
            title,
            company,
            location:    data.jobLocation?.address?.addressLocality || 'United States',
            source:      'glassdoor',
            description: (data.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 800),
            category:    categorizeJob(title),
            url:         data.url || '',
            scrapedAt:   new Date().toISOString(),
          });
          count++;
        } catch { /* skip malformed JSON-LD */ }
      }
    } catch (e) {
      console.error(`[Glassdoor] ${term}: ${e.message}`);
    }
  }

  return jobs;
}

// ─── Deduplication ────────────────────────────────────────────────────────────
// Dedup by title+company only — source irrelevant. Job is the unit of analysis.
export function deduplicateJobs(jobs) {
  const seen = new Set();
  return jobs.filter((j) => {
    const key = `${j.title.toLowerCase().trim()}|${j.company.toLowerCase().trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Mock fallback (used if all scrapers fail) ────────────────────────────────
// ONE job per search term — source not relevant to bias testing.
export function generateMockJobs(terms) {
  const companies = ['Apex Systems', 'TechVentures', 'Global Health Inc', 'BuildRight LLC', 'DataFlow Corp'];
  return terms.map((term, i) => {
    const title   = term.replace(/\b\w/g, (c) => c.toUpperCase());
    const company = companies[i % companies.length];
    return {
      id:          deterministicJobId(title, company),
      title,
      company,
      location:    'United States',
      source:      'mock',
      description: `We are seeking an experienced ${term} to join our team. You will collaborate with cross-functional teams, drive key initiatives, and deliver measurable results in a fast-paced environment.`,
      category:    categorizeJob(term),
      url:         '',
      scrapedAt:   new Date().toISOString(),
    };
  });
}

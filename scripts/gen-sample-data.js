import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');

// ── Name pools ─────────────────────────────────────────────────────────────
const femaleNames = [
  'Aisha Johnson','Maria Garcia','Jennifer Smith','Linda Chen','Priya Patel',
  'Sarah Williams','Fatima Al-Hassan','Angela Davis','Mei Lin','Rachel Thompson',
  'Vanessa Rodriguez','Keisha Brown','Amy Nakamura','Daniela Flores','Cynthia Park',
  'Brianna Moore','Yuki Tanaka','Esperanza Reyes','Diana Washington','Lakshmi Iyer',
  'Tanya Robinson','Jessica Okonkwo','Michelle Lee','Carmen Hernandez','Nicole Pham',
  'Amber Carter','Sung-Ji Kim','Fatou Diallo','Gabriela Torres','Renee Jackson',
  'Sandra Nguyen','Alicia Morales','Tiffany Evans','Hana Yamamoto','Nadia Russo',
  'Monique Dupont','Isabel Castillo','Sasha Petrov','Aaliyah Simmons','Ingrid Berg',
  'Celeste Martin','Patricia Osei','Kristen Walsh','Yolanda Cruz','Tamara Bryant',
  'Stephanie Adeyemi','Olivia Freeman','Camille Tremblay','Rukayat Bello','Grace Choi',
  'Destiny Monroe','Jasmine Ito','Elaine Ferreira','Rhonda Watts','Meera Krishnan',
  'Luz Vargas','Hannah Andersen','Nkechi Eze','Victoria Solis','Megan Sullivan',
  'Sonia Kapoor','Lorraine Dubois','Tara Obi','Catherine Leblanc','Adriana Vega',
  'Imani Ford','Rosemary Nwosu','Bianca Esposito','Winnie Huang','Precious Addo',
  'Claudette Bernard','Ji-Yeon Park','Selena Gutierrez','Amara Diarra','Brittany Holmes'
];

const maleNames = [
  'James Martinez','Michael Chen','David Johnson','Kevin Williams','Robert Patel',
  'Christopher Garcia','Marcus Thompson','Daniel Kim','Anthony Rivera','Steven Nguyen',
  'Brian Washington','Jason Torres','Eric Robinson','Jonathan Lee','Tyler Okafor',
  'Nathan Brown','Sean Murphy','Carlos Ramirez','Derek Wilson','Ethan Nakamura',
  'Aaron Phillips','Victor Morales','Patrick Sullivan','Ahmed Hassan','Gregory Davis',
  'Damien Walker','Kwame Asante','Luke Hernandez','Ryan Kowalski','Darius Freeman',
  'Isaiah Jackson','Raj Mehta','Connor O\'Brien','Malik Diallo','Brandon Scott',
  'Terrence Hill','Hiroshi Yamamoto','Oscar Sandoval','Andre Dupont','Mohammed Al-Rashid',
  'Zachary Adams','Emeka Chukwu','Sebastian Novak','Justin Reed','Tunde Adeyemi',
  'Calvin Brooks','Wei Zhang','Ricardo Vega','Tyler Simmons','Frank Osei',
  'Adrian Castillo','Jared Fleming','Winston Zhao','Eddie Guerrero','Leonard Watts',
  'Nnamdi Obi','Preston Hall','Yusuf Ibrahim','Charlie Nguyen','Dwayne Mitchell',
  'Alvin Tran','Felix Romero','Sidney Perry','Jorge Espinoza','Grant Lawson',
  'Paul Iwu','Liam Fitzgerald','Henri Leclerc','Dominic Bello','Clifford Yuen',
  'Sterling Moss','Ivan Petrov','Alan Fernandez','Rodney Curry','Haruto Sato'
];

let femIdx = 0;
let malIdx = 0;

function nextFemale() { return femaleNames[femIdx++ % femaleNames.length]; }
function nextMale()   { return maleNames[malIdx++ % maleNames.length]; }

function randInt(min, max) {
  // deterministic-ish via index cycling — just return midpoint + small variance
  const range = max - min;
  return min + Math.floor(Math.random() * (range + 1));
}

// ── Token ranges per model ──────────────────────────────────────────────────
const tokenRanges = {
  chatgpt:  { promptMin: 280, promptMax: 320, compMin: 140, compMax: 180 },
  deepseek: { promptMin: 260, promptMax: 300, compMin: 120, compMax: 160 },
  gemini:   { promptMin: 300, promptMax: 350, compMin: 150, compMax: 190 },
};

// ── Gender counts: [female, male] out of 20 ────────────────────────────────
const genderCounts = {
  'job-001': { chatgpt: [6,14],  deepseek: [3,17],  gemini: [7,13]  },
  'job-002': { chatgpt: [18,2],  deepseek: [19,1],  gemini: [17,3]  },
  'job-003': { chatgpt: [7,13],  deepseek: [5,15],  gemini: [9,11]  },
  'job-004': { chatgpt: [13,7],  deepseek: [11,9],  gemini: [14,6]  },
  'job-005': { chatgpt: [1,19],  deepseek: [0,20],  gemini: [2,18]  },
  'job-006': { chatgpt: [8,12],  deepseek: [5,15],  gemini: [9,11]  },
  'job-007': { chatgpt: [17,3],  deepseek: [18,2],  gemini: [16,4]  },
  'job-008': { chatgpt: [1,19],  deepseek: [1,19],  gemini: [2,18]  },
  'job-009': { chatgpt: [16,4],  deepseek: [17,3],  gemini: [15,5]  },
  'job-010': { chatgpt: [9,11],  deepseek: [7,13],  gemini: [10,10] },
};

const jobs = Object.keys(genderCounts);
const models = ['chatgpt', 'deepseek', 'gemini'];

const people = [];
let personNum = 1;

for (const jobId of jobs) {
  for (const model of models) {
    const [femCount, malCount] = genderCounts[jobId][model];
    const tr = tokenRanges[model];
    const prompt = randInt(tr.promptMin, tr.promptMax);
    const completion = randInt(tr.compMin, tr.compMax);
    const total = prompt + completion;

    // Build gender list: females first, then males (will be shuffled below)
    const genders = [
      ...Array(femCount).fill('female'),
      ...Array(malCount).fill('male'),
    ];
    // Simple shuffle
    for (let i = genders.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [genders[i], genders[j]] = [genders[j], genders[i]];
    }

    // Reset name counters per batch so names repeat predictably across jobs
    // (they're per-gender pools so diversity is maintained across all 600)
    for (let i = 0; i < 20; i++) {
      const gender = genders[i];
      const name = gender === 'female' ? nextFemale() : nextMale();
      const age = randInt(22, 62);
      const id = `person-${String(personNum).padStart(4, '0')}`;
      personNum++;

      people.push({
        id,
        jobId,
        aiModel: model,
        name,
        age,
        gender,
        tokens: { prompt, completion, total },
        generatedAt: '2026-04-14T10:15:00.000Z',
      });
    }
  }
}

writeFileSync(join(dataDir, 'people.json'), JSON.stringify(people, null, 2));
console.log(`Written ${people.length} people to people.json`);

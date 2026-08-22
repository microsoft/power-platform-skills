'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  compareVocabularies,
  validateVocabulary,
} = require('../validate-seed-vocabulary');

const script = path.resolve(__dirname, '..', 'validate-seed-vocabulary.js');

function additionalPools(prefix) {
  return {
    status: [`${prefix} Draft`, `${prefix} Active`, `${prefix} Complete`],
    priority: [`${prefix} Low`, `${prefix} Medium`, `${prefix} High`],
    category: [`${prefix} Intake`, `${prefix} Review`, `${prefix} Action`, `${prefix} Archive`],
    seat: Array.from({ length: 6 }, (_, index) => `${prefix}-${index + 1}A`),
    flight: Array.from({ length: 4 }, (_, index) => `${prefix}${index + 101}`),
    url: Array.from({ length: 3 }, (_, index) => `https://${prefix.toLowerCase()}.example/${index + 1}`),
  };
}

const cases = [
  {
    brief: 'Build a corporate access control app for security officers and facilities coordinators. They review badge requests for employees and visitors, assign doors in office buildings, record approvals, and investigate expired credentials.',
    vocabulary: {
      domain: 'corporate access control',
      rowCount: 12,
      pools: {
        person: ['Amina Okafor', 'Diego Morales', 'Haruka Sato', 'Lina Haddad', 'Mateo Silva', 'Priya Nair', 'Tomasz Kowalski', 'Zoe Laurent'],
        company: ['Northstar Security Services', 'Beacon Facilities Group', 'Citadel Badge Systems', 'Harbor Access Partners', 'Summit Credential Works', 'Verity Office Security'],
        location: ['Atrium Office Building', 'North Campus Security Desk', 'Riverside Administration Building', 'West Annex Badge Office'],
        door: ['Lobby Turnstile A', 'Server Room Door', 'North Loading Entrance', 'Executive Floor Gate', 'Visitor Reception Door', 'Parking Garage Barrier'],
        title: ['Review contractor badge request', 'Approve visitor access window', 'Investigate expired credential', 'Assign server room permission', 'Replace damaged employee badge', 'Audit weekend door access'],
        note: ['Photo identification needs review', 'Manager approval is recorded', 'Credential expires after the visit', 'Door assignment follows facilities policy', 'Badge pickup is waiting at reception'],
        role: ['Security officers', 'Facilities coordinators'],
        ...additionalPools('Access'),
      },
      idFormats: { serial: 'BDG-{seq4}', reference: 'REQ-{year}-{seq4}', code: '{ALPHA2}-{seq3}' },
    },
  },
  {
    brief: 'Build a wildlife rehabilitation app for veterinarians and animal care volunteers. They track rescued birds, treatment cases, rehabilitation enclosures, release locations, feeding notes, and medical reviews.',
    vocabulary: {
      domain: 'wildlife rehabilitation',
      rowCount: 12,
      pools: {
        person: ['Nadia El-Sayed', 'Kenji Watanabe', 'Lucia Ferreira', 'Samira Khan', 'Ethan Redbird', 'Mei Chen', 'Owen Murphy', 'Anika Bose'],
        company: ['Coastal Wildlife Rescue', 'Greenwing Veterinary Network', 'Riverbend Raptor Centre', 'Wildhaven Care Alliance', 'Meadow Flight Foundation', 'Northshore Avian Clinic'],
        location: ['Wetland Recovery Campus', 'Forest Edge Release Site', 'Lakeside Veterinary Wing', 'Coastal Intake Centre'],
        door: ['Quarantine Flight Pen', 'Raptor Treatment Room', 'Songbird Nursery Zone', 'Waterfowl Recovery Enclosure', 'Medication Preparation Area', 'Release Crate Station'],
        title: ['Review kestrel treatment plan', 'Prepare heron release assessment', 'Record owl feeding response', 'Schedule songbird medical review', 'Transfer tern to recovery enclosure', 'Document eagle wing rehabilitation'],
        note: ['Weight trend supports continued recovery', 'Flight strength needs another assessment', 'Feeding response is improving', 'Release weather window is being monitored', 'Veterinary medication was administered'],
        role: ['Veterinarians', 'Animal care volunteers'],
        ...additionalPools('Wildlife'),
      },
      idFormats: { serial: 'ANI-{seq4}', reference: 'CASE-{year}-{seq4}', code: '{ALPHA2}-{seq3}' },
    },
  },
  {
    brief: 'Build a craft brewery quality app for brewers and laboratory technicians. They inspect fermentation tanks, record batch samples, track taproom and cellar locations, review contamination findings, and approve packaged beer releases.',
    vocabulary: {
      domain: 'craft brewery quality',
      rowCount: 12,
      pools: {
        person: ['Greta Vogel', 'Rafael Costa', 'Sora Kim', 'Milan Petrovic', 'Imani Brooks', 'Felix Anders', 'Camila Reyes', 'Noah Tremblay'],
        company: ['Copper Kettle Brewing', 'Maltline Laboratory Services', 'Hearthstone Hop Supply', 'Clearwort Quality Partners', 'Barrelhouse Packaging', 'Golden Grain Cooperative'],
        location: ['Main Brewhouse Floor', 'Oak Barrel Cellar', 'Riverside Taproom', 'South Packaging Hall'],
        door: ['Fermentation Tank Bay', 'Yeast Culture Room', 'Cold Cellar Zone', 'Quality Sample Bench', 'Canning Line Gate', 'Hop Storage Room'],
        title: ['Inspect lager fermentation tank', 'Review packaged stout release', 'Record pale ale batch sample', 'Investigate cellar contamination finding', 'Approve seasonal canning run', 'Verify taproom keg quality'],
        note: ['Gravity reading is within target', 'Sample aroma needs laboratory review', 'Packaging seal passed inspection', 'Fermentation temperature remained stable', 'Contamination swab requires follow-up'],
        role: ['Brewers', 'Laboratory technicians'],
        ...additionalPools('Brewery'),
      },
      idFormats: { serial: 'BAT-{seq4}', reference: 'QC-{year}-{seq4}', code: '{ALPHA2}-{seq3}' },
    },
  },
];

test('three unrelated briefs produce valid, disjoint vocabularies', () => {
  for (const entry of cases) {
    const result = validateVocabulary(entry.vocabulary, { briefText: entry.brief });
    assert.equal(result.valid, true, result.errors.join('\n'));
  }
  const comparison = compareVocabularies(cases.map((entry) => ({
    label: entry.vocabulary.domain,
    vocabulary: entry.vocabulary,
  })));
  assert.equal(comparison.valid, true, comparison.errors.join('\n'));
});

test('brief provenance rejects a foreign domain and unmentioned role', () => {
  const entry = structuredClone(cases[0]);
  entry.vocabulary.domain = 'wildlife rehabilitation';
  entry.vocabulary.pools.role = ['Veterinarians'];
  const result = validateVocabulary(entry.vocabulary, { briefText: entry.brief });
  assert.equal(result.valid, false);
  assert.equal(result.errors.includes('domain must be a phrase present in the brief'), true);
  assert.equal(result.errors.some((error) => error.includes('must use wording present in the brief')), true);
});

test('schema validation fails for missing pools and unsupported ID placeholders', () => {
  const vocabulary = structuredClone(cases[1].vocabulary);
  delete vocabulary.pools.door;
  delete vocabulary.pools.url;
  vocabulary.idFormats.serial = 'ANI-{counter}';
  const result = validateVocabulary(vocabulary, { briefText: cases[1].brief });
  assert.equal(result.valid, false);
  assert.equal(result.errors.includes('pools.door must be an array'), true);
  assert.equal(result.errors.includes('pools.url must be an array'), true);
  assert.equal(result.errors.includes('idFormats.serial must contain {seq4}'), true);
  assert.equal(result.errors.includes('idFormats.serial uses unsupported placeholder {counter}'), true);
});

test('comparison reports cross-domain pool contamination', () => {
  const left = structuredClone(cases[0]);
  const right = structuredClone(cases[2]);
  right.vocabulary.pools.title[0] = left.vocabulary.pools.title[0];
  const result = compareVocabularies([
    { label: left.vocabulary.domain, vocabulary: left.vocabulary },
    { label: right.vocabulary.domain, vocabulary: right.vocabulary },
  ]);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.includes('pool overlap')), true);
});

test('CLI validates one brief artifact and compares three artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-vocabulary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vocabularyPaths = [];
  for (const [index, entry] of cases.entries()) {
    const briefPath = path.join(root, `brief-${index}.md`);
    const vocabularyPath = path.join(root, `vocabulary-${index}.json`);
    fs.writeFileSync(briefPath, `${entry.brief}\n`);
    fs.writeFileSync(vocabularyPath, `${JSON.stringify(entry.vocabulary, null, 2)}\n`);
    vocabularyPaths.push(vocabularyPath);
    const validation = spawnSync(
      process.execPath,
      [script, vocabularyPath, '--brief', briefPath],
      { encoding: 'utf8' },
    );
    assert.equal(validation.status, 0, `${validation.stdout}\n${validation.stderr}`);
    assert.match(validation.stdout, /seed-vocabulary: PASS/);
  }

  const comparison = spawnSync(
    process.execPath,
    [script, '--compare', ...vocabularyPaths, '--json'],
    { encoding: 'utf8' },
  );
  assert.equal(comparison.status, 0, `${comparison.stdout}\n${comparison.stderr}`);
  const report = JSON.parse(comparison.stdout);
  assert.equal(report.valid, true);
  assert.equal(report.vocabularies.length, 3);
  assert.deepEqual(report.vocabularies.map((entry) => entry.summary.domain), [
    'corporate access control',
    'wildlife rehabilitation',
    'craft brewery quality',
  ]);
});
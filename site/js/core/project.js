// Project model helpers (CONTRACTS.md §4, §12.3). Pure: no DOM, no clock; newId()/freshSeed() (Math.random via
// core/rng.newId) are the only randomness. Runs in Node tests.
//
//   newProject(overrides)                 a fresh project with every §4 default
//   newSection(type, themeId, overrides)  opts from the engine's defaults(themeId), perPage = meta.defaultPerPage
//   normalizeProject(raw)                 any input (junk, old files, newer fields) -> a valid project; keeps unknown fields
//   parseProjectFile(text)                file text -> project, or throws an Error with a message for people
//   serializeProject(p), projectFileName(p)
//   freshSeed(), pinSeed(section, index, bookSeed)    seed helpers for Regenerate / Lock
//   regeneratePuzzle / regenerateSectionSeeds / toggleLock / duplicateSectionData / moveSectionIn   (pure mutators)
//   usesPictureList / sectionPictures / otherSectionPictures / regeneratePicture / regenerateSectionPictures
//                                         (Regenerate, Add and Duplicate for picture-list nonograms)
//
// Dates: functions here never read the clock. The app stamps createdAt/updatedAt/year (stampProject).
import { TYPES as REGISTRY_TYPES } from '../puzzles/registry.js';
import { TRIMS } from '../kdp/specs.js';
import { newId, puzzleSeed } from './rng.js';
import { pictureChoices, pictureIdAt } from '../puzzles/nonogram.js';

export const PROJECT_VERSION = 1;
export const DEFAULT_TITLE = 'Untitled puzzle book';
export const DEFAULT_COUNT = 20;
export const MAX_COUNT = 500;
export const THEME_IDS = ['standard', 'large', 'kids'];
export const PAPERS = ['white', 'cream'];
export const ANSWER_POSITIONS = ['end', 'after-section', 'none'];
export const ANSWER_PER_PAGE = [4, 6, 9];
export const PAGE_NUMBER_STYLES = [true, 'outside', 'center', false, 'none'];
export const FRONT_KEYS = ['title', 'copyright', 'belongs', 'howto', 'contents'];
export const BACK_KEYS = ['thanks', 'notes'];
export const FRONT_DEFAULTS = Object.freeze({ title: true, copyright: true, belongs: true, howto: true, contents: false });
export const BACK_DEFAULTS = Object.freeze({ thanks: true, notes: true });
export const ANSWER_DEFAULTS = Object.freeze({ perPage: 6, position: 'end' });

const MAX_TITLE = 300;
const MAX_TEXT = 20000;
const MAX_NOTES_PAGES = 50;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INDEX_RE = /^(0|[1-9]\d{0,5})$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, fallback = '', max = MAX_TEXT) => (typeof v === 'string' ? v.slice(0, max) : fallback);

function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  try { return structuredClone(v); } catch { return JSON.parse(JSON.stringify(v)); }
}

/** Nearest allowed value (ties go to the smaller, i.e. bigger puzzles); `fallback` for junk. */
export function snapTo(value, allowed, fallback) {
  const list = (Array.isArray(allowed) ? allowed : []).filter((v) => Number.isInteger(v) && v > 0);
  if (!list.length) return fallback;
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return list.includes(fallback) ? fallback : list[0];
  let best = list[0];
  for (const v of list) {
    const d = Math.abs(v - n), bd = Math.abs(best - n);
    if (d < bd || (d === bd && v < best)) best = v;
  }
  return best;
}

function clampCount(v, fallback = DEFAULT_COUNT) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(MAX_COUNT, Math.max(1, Math.round(n)));
}

function isoOrNull(v) {
  if (typeof v !== 'string' || !v) return null;
  return Number.isFinite(Date.parse(v)) ? v : null;
}

function yearOf(v, createdAt) {
  const n = typeof v === 'string' && /^\d{4}$/.test(v.trim()) ? Number(v) : v;
  if (Number.isInteger(n) && n >= 1000 && n <= 9999) return n;
  const m = /^(\d{4})/.exec(String(createdAt || ''));
  return m ? Number(m[1]) : null;
}

function engineOf(type, types = REGISTRY_TYPES) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(types, type) ? types[type] : null;
}

/** Display name of a section: its title, else the type's plural name. */
export function sectionName(section, types = REGISTRY_TYPES) {
  const t = section && typeof section.title === 'string' ? section.title.trim() : '';
  if (t) return t;
  const meta = engineOf(section?.type, types)?.meta;
  return meta?.plural || meta?.name || String(section?.type || 'Section');
}

// ---------------------------------------------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------------------------------------------

/** A fresh project (CONTRACTS §4). Overrides are applied on top, then normalised. */
export function newProject(overrides = {}) {
  const base = {
    v: PROJECT_VERSION, id: newId('b_'), seed: newId(),
    title: DEFAULT_TITLE, subtitle: '', author: '', year: null,
    trim: '8.5x11', paper: 'white', bleed: false, theme: 'standard',
    front: { ...FRONT_DEFAULTS },
    sections: [],
    answers: { ...ANSWER_DEFAULTS },
    back: { ...BACK_DEFAULTS },
    pageNumbers: true, header: '', credit: false,
    copyrightText: null,
    createdAt: null, updatedAt: null,
  };
  return normalizeProject({ ...base, ...(isObj(overrides) ? clone(overrides) : {}) });
}

/**
 * A new section of `type` (throws for an unknown type). opts = engine defaults(themeId); title = meta.plural.
 */
export function newSection(type, themeId = 'standard', overrides = {}, { types = REGISTRY_TYPES } = {}) {
  const engine = engineOf(type, types);
  if (!engine) throw new Error(`Unknown puzzle type: ${type}`);
  const meta = engine.meta || {};
  const theme = THEME_IDS.includes(themeId) ? themeId : 'standard';
  const sec = {
    id: newId('s'), type, title: meta.plural || meta.name || type,
    count: DEFAULT_COUNT, perPage: meta.defaultPerPage ?? (meta.perPage || [1])[0], divider: false,
    opts: clone(typeof engine.defaults === 'function' ? engine.defaults(theme) : {}) || {},
    salt: 0, seeds: {}, locked: {},
    ...(isObj(overrides) ? clone(overrides) : {}),
  };
  return normalizeSection(sec, { theme, types });
}

/** Fill createdAt (if missing), updatedAt and year (if missing) from an ISO timestamp. Mutates and returns `p`. */
export function stampProject(p, iso, { touch = true } = {}) {
  if (!p || !iso) return p;
  if (!p.createdAt) p.createdAt = iso;
  if (touch || !p.updatedAt) p.updatedAt = iso;
  if (p.year == null) p.year = yearOf(null, p.createdAt);
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------------------------------------------

function normalizeSeeds(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!INDEX_RE.test(k) || Number(k) >= MAX_COUNT) continue;
    if (typeof v === 'string' && v) out[k] = v.slice(0, 200);
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v);
  }
  return out;
}

function normalizeLocked(raw) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (INDEX_RE.test(k) && Number(k) < MAX_COUNT && v) out[k] = true;
  }
  return out;
}

/** One section. Unknown puzzle types are kept (the layout explains them) so nobody's work is thrown away. */
export function normalizeSection(raw, { theme = 'standard', types = REGISTRY_TYPES, seenIds } = {}) {
  if (!isObj(raw) || typeof raw.type !== 'string' || !raw.type) return null;
  const s = clone(raw);
  const engine = engineOf(s.type, types);
  const meta = engine?.meta || {};
  let id = typeof s.id === 'string' && ID_RE.test(s.id) ? s.id : typeof s.id === 'number' ? `s${s.id}` : '';
  if (!id || (seenIds && seenIds.has(id))) {
    do { id = newId('s'); } while (seenIds && seenIds.has(id));
  }
  seenIds?.add(id);
  s.id = id;
  s.title = typeof s.title === 'string' ? s.title.slice(0, MAX_TITLE) : (meta.plural || meta.name || s.type);
  s.count = clampCount(s.count);
  s.perPage = engine
    ? snapTo(s.perPage, meta.perPage, meta.defaultPerPage ?? 1)
    : (Number.isInteger(s.perPage) && s.perPage > 0 ? s.perPage : 1);
  s.divider = !!s.divider;
  if (!isObj(s.opts)) s.opts = engine && typeof engine.defaults === 'function' ? clone(engine.defaults(theme)) || {} : {};
  s.salt = Number.isInteger(s.salt) && s.salt >= 0 ? s.salt : Math.max(0, Math.floor(Number(s.salt) || 0));
  s.seeds = normalizeSeeds(s.seeds);
  s.locked = normalizeLocked(s.locked);
  // SPEC 5.8 draft format: "locks": { "7": "seedOverride:9xq" } -> seeds[7] = "9xq" + locked[7].
  if (isObj(raw.locks)) {
    for (const [k, v] of Object.entries(raw.locks)) {
      if (!INDEX_RE.test(k) || Number(k) >= MAX_COUNT || !v) continue;
      if (typeof v === 'string') {
        const seed = v.replace(/^seedOverride:/, '');
        if (seed) s.seeds[k] = seed.slice(0, 200);
      }
      s.locked[k] = true;
    }
    delete s.locks;
  }
  return s;
}

function normalizeFlags(raw, keys, defaults) {
  const out = { ...defaults };
  if (Array.isArray(raw)) {
    const on = new Set(raw.filter((k) => typeof k === 'string'));
    for (const k of keys) out[k] = on.has(k);
    return out;
  }
  if (isObj(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (!keys.includes(k)) out[k] = clone(v); // keep extra keys (e.g. a newer page type)
      else if (v !== undefined) out[k] = !!v;
    }
  }
  return out;
}

/**
 * Any input -> a valid project (CONTRACTS §4): fills every default, clamps counts to 1..500, snaps perPage and
 * answers.perPage to allowed values, converts the SPEC 5.8 draft format, keeps unknown fields.
 */
export function normalizeProject(raw, { types = REGISTRY_TYPES } = {}) {
  const src = isObj(raw) ? raw : {};
  const p = clone(src);
  p.v = PROJECT_VERSION;
  p.id = typeof src.id === 'string' && ID_RE.test(src.id) ? src.id : newId('b_');
  p.seed = typeof src.seed === 'string' && src.seed ? src.seed.slice(0, 200)
    : typeof src.seed === 'number' && Number.isFinite(src.seed) ? String(src.seed) : newId();
  p.title = str(src.title, DEFAULT_TITLE, MAX_TITLE);
  p.subtitle = str(src.subtitle, '', MAX_TITLE);
  p.author = str(src.author, '', MAX_TITLE);
  p.createdAt = isoOrNull(src.createdAt);
  p.updatedAt = isoOrNull(src.updatedAt);
  p.year = yearOf(src.year, p.createdAt);
  p.trim = TRIMS.some((t) => t.id === src.trim) ? src.trim : '8.5x11';
  p.paper = PAPERS.includes(src.paper) ? src.paper : 'white';
  p.bleed = src.bleed === true;
  p.theme = THEME_IDS.includes(src.theme) ? src.theme : 'standard';

  // Front matter. A §4 object, or the SPEC 5.8 draft array ["title","copyright",…].
  p.front = normalizeFlags(src.front, FRONT_KEYS, FRONT_DEFAULTS);

  const seen = new Set();
  p.sections = (Array.isArray(src.sections) ? src.sections : [])
    .map((s) => normalizeSection(s, { theme: p.theme, types, seenIds: seen }))
    .filter(Boolean);

  const ans = isObj(src.answers) ? src.answers : {};
  p.answers = {
    ...clone(ans),
    perPage: snapTo(ans.perPage, ANSWER_PER_PAGE, ANSWER_DEFAULTS.perPage),
    position: ANSWER_POSITIONS.includes(ans.position) ? ans.position : ANSWER_DEFAULTS.position,
  };

  // Back matter: notes may be true/false or a number of lined pages (CONTRACTS §11).
  const rawNotes = Array.isArray(src.back) ? undefined : isObj(src.back) ? src.back.notes : undefined;
  p.back = normalizeFlags(src.back, BACK_KEYS, BACK_DEFAULTS);
  if (typeof rawNotes === 'number' && Number.isFinite(rawNotes)) {
    const n = Math.min(MAX_NOTES_PAGES, Math.max(0, Math.round(rawNotes)));
    p.back.notes = n > 0 ? n : false;
  }

  p.pageNumbers = PAGE_NUMBER_STYLES.includes(src.pageNumbers) ? src.pageNumbers : true;
  p.header = str(src.header, '', MAX_TITLE);
  p.credit = src.credit === true;
  p.copyrightText = typeof src.copyrightText === 'string' ? src.copyrightText.slice(0, MAX_TEXT) : null;
  if ('thanksText' in src) p.thanksText = typeof src.thanksText === 'string' ? src.thanksText.slice(0, MAX_TEXT) : null;
  if ('spineText' in src) p.spineText = typeof src.spineText === 'string' ? src.spineText.slice(0, MAX_TITLE) : '';
  return p;
}

// ---------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------

/** Project file text -> normalised project. Throws an Error whose message can be shown as-is. */
export function parseProjectFile(text, opts) {
  if (typeof text !== 'string') throw new Error('That file could not be read as text. Choose a .gridbook.json project file.');
  const body = text.replace(/^﻿/, '').trim();
  if (!body) throw new Error('That file is empty. Choose a .gridbook.json project file.');
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error('That file isn’t a Gridbook Studio project (it isn’t valid JSON). Choose a .gridbook.json file saved from the Studio.');
  }
  if (!isObj(data)) throw new Error('That file isn’t a Gridbook Studio project. Choose a .gridbook.json file saved from the Studio.');
  const looksRight = Array.isArray(data.sections) || data.v != null || ('trim' in data && 'title' in data);
  if (!looksRight) {
    throw new Error('That JSON file doesn’t look like a Gridbook Studio project (it has no book settings or sections).');
  }
  if (typeof data.v === 'number' && data.v > PROJECT_VERSION) {
    throw new Error('This project was saved by a newer version of Gridbook Studio. Reload the Studio to update it, then open the file again.');
  }
  return normalizeProject(data, opts);
}

/** Pretty JSON for the .gridbook.json download. */
export function serializeProject(p) {
  return JSON.stringify(p, null, 2) + '\n';
}

const TRANSLIT = { ß: 'ss', æ: 'ae', ø: 'o', œ: 'oe', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ı: 'i', '&': ' and ', '×': 'x', '+': ' plus ' };

/** ASCII slug: lowercase letters, digits and single dashes (max 60 characters). */
export function slugify(text, max = 60) {
  let s = String(text ?? '').toLowerCase().replace(/[ßæøœđðłþı&×+]/g, (c) => TRANSLIT[c] || '');
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/-+[^-]*$/, '') || s.slice(0, max);
  return s.replace(/-+$/, '');
}

/** `<title-slug>.gridbook.json` (ASCII only). */
export function projectFileName(p) {
  return `${slugify(p && p.title) || 'puzzle-book'}.gridbook.json`;
}

/** "3 sections · 230 puzzles" (for the My books list). */
export function projectSummary(p) {
  const secs = Array.isArray(p?.sections) ? p.sections : [];
  const puzzles = secs.reduce((n, s) => n + (Number(s?.count) || 0), 0);
  if (!secs.length) return 'No sections yet';
  return `${secs.length} section${secs.length === 1 ? '' : 's'} · ${puzzles} puzzle${puzzles === 1 ? '' : 's'}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Seeds: Regenerate and Lock (operate on a section draft)
// ---------------------------------------------------------------------------------------------------------------

/** A new random seed for "Regenerate this puzzle". */
export function freshSeed() {
  return newId('r');
}

export function isLocked(section, index) {
  return !!(section && isObj(section.locked) && section.locked[index]);
}

/** Write the puzzle's CURRENT seed into section.seeds[index] (so later salt bumps can't change it). Returns it. */
export function pinSeed(section, index, bookSeed) {
  const seed = puzzleSeed(bookSeed, section, index);
  if (!isObj(section.seeds)) section.seeds = {};
  section.seeds[index] = seed;
  return seed;
}

/** "Regenerate this puzzle": a fresh seed override unless locked. Returns false (and changes nothing) if locked. */
export function regeneratePuzzle(section, index) {
  if (isLocked(section, index)) return false;
  if (!isObj(section.seeds)) section.seeds = {};
  section.seeds[index] = freshSeed();
  return true;
}

/**
 * "Regenerate all unlocked": pin every locked puzzle's current seed, drop the seed overrides of unlocked puzzles,
 * bump the salt. Returns the number of puzzles that will change.
 */
export function regenerateSectionSeeds(section, bookSeed) {
  const count = clampCount(section.count, 0);
  if (!isObj(section.locked)) section.locked = {};
  if (!isObj(section.seeds)) section.seeds = {};
  for (const k of Object.keys(section.locked)) {
    if (section.locked[k]) pinSeed(section, Number(k), bookSeed);
  }
  for (const k of Object.keys(section.seeds)) {
    if (!section.locked[k]) delete section.seeds[k];
  }
  section.salt = (Number.isInteger(section.salt) && section.salt >= 0 ? section.salt : 0) + 1;
  let locked = 0;
  for (let i = 0; i < count; i++) if (section.locked[i]) locked++;
  return count - locked;
}

/** Lock pins the current seed and sets locked[i]; unlock removes locked[i] but keeps the seed (nothing changes). */
export function toggleLock(section, index, bookSeed) {
  if (!isObj(section.locked)) section.locked = {};
  if (section.locked[index]) {
    delete section.locked[index];
    return false;
  }
  pinSeed(section, index, bookSeed);
  section.locked[index] = true;
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Regenerate for nonograms that take turns through a picture list (library or custom pictures)
//
// Their puzzle is the picture, and a new seed alone would bring the same picture back. So Regenerate gives the
// puzzle a seed that also names another picture ("<fresh seed>#pic=<id>", read by nonogram.js): one that no other
// puzzle in the section shows, when the list has one. Locking pins that seed like any other. `rand` is a
// () => [0, 1) function supplied by the caller (the Studio passes Math.random), so this module stays pure.
// ---------------------------------------------------------------------------------------------------------------

/** Picture ids a picture-list nonogram section takes turns through; [] for other sections. */
function sectionChoices(section) {
  if (!section || section.type !== 'nonogram') return [];
  return pictureChoices(isObj(section.opts) ? section.opts : {}).filter((id) => typeof id === 'string' && id);
}

/** Number of pictures Regenerate can choose from, or 0 when the section's puzzles are not picked from a list. */
export function usesPictureList(section) {
  return sectionChoices(section).length;
}

/** The picture id each puzzle of a picture-list section shows, by puzzle index. */
export function sectionPictures(section, bookSeed) {
  const opts = isObj(section?.opts) ? section.opts : {};
  const out = [];
  for (let i = 0; i < clampCount(section?.count, 0); i++) out.push(pictureIdAt(opts, puzzleSeed(bookSeed, section, i), i));
  return out;
}

const pickFrom = (list, rand) => list[Math.min(list.length - 1, Math.floor(rand() * list.length))];

/**
 * Pictures shown by the book's other picture-list nonogram sections (pass as `avoid`, so two sections don't print the
 * same puzzles).
 */
export function otherSectionPictures(project, sectionId) {
  const out = new Set();
  for (const s of Array.isArray(project?.sections) ? project.sections : []) {
    if (s && s.id !== sectionId && sectionChoices(s).length) for (const id of sectionPictures(s, project.seed)) if (id) out.add(id);
  }
  return out;
}

/**
 * "Regenerate this puzzle" for a picture-list section: a picture no puzzle in the section (nor in `avoid`) shows,
 * else one the section doesn't show, else any other one. False (nothing changed) if locked or there is no other.
 */
export function regeneratePicture(section, index, bookSeed, rand, avoid = new Set()) {
  if (isLocked(section, index)) return false;
  const choices = sectionChoices(section);
  const shown = sectionPictures(section, bookSeed);
  const cur = shown[index];
  let pool = choices.filter((id) => !shown.includes(id) && !avoid.has(id));
  if (!pool.length) pool = choices.filter((id) => !shown.includes(id));
  if (!pool.length) pool = choices.filter((id) => id !== cur);
  if (!pool.length) return false;
  if (!isObj(section.seeds)) section.seeds = {};
  section.seeds[index] = `${freshSeed()}#pic=${pickFrom(pool, rand)}`;
  return true;
}

/**
 * "Regenerate all unlocked" for a picture-list section: regenerateSectionSeeds(), then a different picture for every
 * unlocked puzzle: pictures nobody shows first (not this section, nor `avoid`), and never one a locked puzzle shows
 * (while the list has enough). Returns the number of puzzles that changed picture.
 */
export function regenerateSectionPictures(section, bookSeed, rand, avoid = new Set()) {
  const choices = sectionChoices(section);
  const before = sectionPictures(section, bookSeed);
  regenerateSectionSeeds(section, bookSeed);
  const n = before.length;
  const taken = new Set();
  for (let i = 0; i < n; i++) if (isLocked(section, i)) taken.add(before[i]);
  const unused = choices.filter((id) => !before.includes(id) && !avoid.has(id));
  for (let i = unused.length - 1; i > 0; i--) { // shuffle
    const j = Math.floor(rand() * (i + 1));
    [unused[i], unused[j]] = [unused[j], unused[i]];
  }
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (isLocked(section, i)) continue;
    let id = unused.find((x) => !taken.has(x));
    if (id == null) {
      const free = choices.filter((x) => x !== before[i] && !taken.has(x) && !avoid.has(x));
      if (!free.length) free.push(...choices.filter((x) => x !== before[i] && !taken.has(x)));
      const other = free.length ? free : choices.filter((x) => x !== before[i]);
      id = other.length ? pickFrom(other, rand) : null;
    }
    if (id == null) continue; // a one-picture section: this puzzle cannot change
    taken.add(id);
    section.seeds[i] = `${freshSeed()}#pic=${id}`;
    changed++;
  }
  return changed;
}

/** Copy of a section for "Duplicate": new id, same settings and title, new puzzles (no seeds, locks or salt). */
export function duplicateSectionData(section, { existingIds } = {}) {
  const copy = clone(section);
  let id;
  do { id = newId('s'); } while (existingIds && existingIds.has(id));
  copy.id = id;
  copy.seeds = {};
  copy.locked = {};
  copy.salt = 0;
  return copy;
}

/** Move section `id` by `delta` places within project.sections (clamped). Returns the new index or -1. */
export function moveSectionIn(project, id, delta) {
  const list = project.sections;
  const from = list.findIndex((s) => s.id === id);
  if (from < 0) return -1;
  const to = Math.max(0, Math.min(list.length - 1, from + Math.trunc(Number(delta) || 0)));
  if (to !== from) list.splice(to, 0, list.splice(from, 1)[0]);
  return to;
}

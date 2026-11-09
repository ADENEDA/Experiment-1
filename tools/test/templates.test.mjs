// Templates (site/js/ui/templates.js, SPEC 4.4, CONTRACTS §12.5 / §12.8): every template builds a normalised project
// with the promised contents, and every one is a KDP-valid book once its puzzles exist (generated here with the
// real engines on the main thread: preflight with pro:true has zero errors).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATES, TEMPLATE_IDS, SAMPLE_PAGES, buildFromTemplate, templateById, templateFacts,
} from '../../site/js/ui/templates.js';
import { normalizeProject } from '../../site/js/core/project.js';
import { runJob } from '../../site/js/puzzles/generate.js';
import { getType } from '../../site/js/puzzles/registry.js';
import { puzzleSeed } from '../../site/js/core/rng.js';
import { layoutBook } from '../../site/js/layout/book.js';
import { preflight } from '../../site/js/kdp/preflight.js';
import { TRIMS } from '../../site/js/kdp/specs.js';

const CONTRACT_IDS = ['large-print-wordsearch', 'sudoku-easy-expert', 'picture-logic', 'brain-games-mix', 'kids-activity', 'blank'];

/** Generate every puzzle of a project synchronously (the same job runner the worker pool uses). */
function generateAll(project) {
  const puzzles = {};
  for (const s of project.sections) {
    puzzles[s.id] = [];
    for (let i = 0; i < s.count; i++) {
      const r = runJob(getType, { type: s.type, opts: s.opts, seed: puzzleSeed(project.seed, s, i), index: i, count: s.count });
      puzzles[s.id].push(r.puzzle ?? { error: r.error, index: i });
    }
  }
  return puzzles;
}

const stripIds = (p) => JSON.parse(JSON.stringify({ ...p, id: null, seed: null, sections: p.sections.map((s) => ({ ...s, id: null })) }));

test('template ids, names and order match CONTRACTS §12.8 and SPEC 4.4', () => {
  assert.deepEqual(TEMPLATES.map((t) => t.id), CONTRACT_IDS);
  assert.deepEqual(TEMPLATE_IDS, CONTRACT_IDS);
  for (const t of TEMPLATES) {
    assert.ok(t.name && t.blurb && t.tag && t.icon, `${t.id} has a name, blurb, tag and icon`);
    assert.equal(typeof t.build, 'function');
    assert.equal(templateById(t.id), t);
  }
  assert.equal(TEMPLATES.filter((t) => t.hero).map((t) => t.id).join(), 'picture-logic', 'picture logic is the hero template');
});

test('build() returns a fresh, already-normalised project with real engine defaults', () => {
  for (const t of TEMPLATES) {
    const a = t.build(), b = t.build();
    assert.notEqual(a.id, b.id, `${t.id}: every build is a new book`);
    assert.notEqual(a.seed, b.seed, `${t.id}: every build has new puzzles`);
    assert.deepEqual(stripIds(a), stripIds(b), `${t.id}: same contents each time`);
    assert.deepEqual(normalizeProject(a), a, `${t.id}: normalizeProject leaves it unchanged`);
    assert.equal(a.trim, t.trim);
    assert.equal(a.theme, t.theme);
    for (const s of a.sections) {
      const engine = getType(s.type);
      assert.ok(engine.meta.perPage.includes(s.perPage), `${t.id}: ${s.perPage}/page is allowed for ${s.type}`);
      // Option values keep their declared types (CONTRACTS §11: sudoku sizes are numbers), so cache keys match the inspector's.
      for (const [k, v] of Object.entries(engine.defaults(a.theme))) {
        assert.equal(typeof s.opts[k], typeof v, `${t.id}: ${s.type}.${k} keeps the type of the engine default`);
      }
    }
  }
});

test('template contents follow SPEC 4.4', () => {
  const lp = buildFromTemplate('large-print-wordsearch');
  assert.equal(lp.trim, '8.5x11');
  assert.equal(lp.theme, 'large');
  assert.deepEqual(lp.sections.map((s) => [s.type, s.count, s.perPage]), [['wordsearch', 100, 1]]);
  assert.deepEqual(lp.sections[0].opts.wordSource, { mode: 'themes', themes: 'all' });

  const su = buildFromTemplate('sudoku-easy-expert');
  assert.equal(su.trim, '6x9');
  assert.deepEqual(su.sections.map((s) => [s.type, s.title, s.count, s.perPage, s.opts.difficulty, s.opts.size]), [
    ['sudoku', 'Easy', 50, 2, 'easy', 9], ['sudoku', 'Medium', 50, 2, 'medium', 9],
    ['sudoku', 'Hard', 50, 2, 'hard', 9], ['sudoku', 'Expert', 50, 2, 'expert', 9]]);

  const pl = buildFromTemplate('picture-logic');
  assert.equal(pl.trim, '8.5x11');
  assert.deepEqual(pl.sections.map((s) => [s.type, s.count, s.perPage, s.opts.source]), [['nonogram', 60, 1, 'library']]);

  const mix = buildFromTemplate('brain-games-mix');
  assert.equal(mix.trim, '8.5x11');
  assert.deepEqual(mix.sections.map((s) => s.type), ['wordsearch', 'sudoku', 'maze', 'nonogram']);

  const kids = buildFromTemplate('kids-activity');
  assert.equal(kids.trim, '8.5x11');
  assert.equal(kids.theme, 'kids');
  assert.deepEqual(kids.sections.map((s) => s.type), ['maze', 'sudoku', 'wordsearch']);
  assert.equal(kids.sections[1].opts.size, 4, '4×4 sudoku');
  assert.ok(kids.sections[2].opts.size <= 12, 'small word searches');
  assert.equal(kids.front.belongs, true);

  const blank = buildFromTemplate('blank');
  assert.equal(blank.sections.length, 0);
  assert.equal(buildFromTemplate('no-such-template').sections.length, 0, 'unknown ids give the blank book');
});

test('the sample is the picture-logic template at exactly 32 pages', () => {
  const s = buildFromTemplate('picture-logic', { sample: true });
  assert.equal(s.sections[0].type, 'nonogram');
  const facts = templateFacts(s);
  assert.equal(facts.pages, SAMPLE_PAGES);
  // As many puzzles as fit: one more would need more pages.
  const more = structuredClone(s);
  more.sections[0].count++;
  assert.ok(layoutBook(more, {}, { pro: true }).meta.pageCount > SAMPLE_PAGES);
  assert.equal(buildFromTemplate('sudoku-easy-expert', { sample: true }).sections.length, 4, 'sample only changes picture-logic');
});

test('templateFacts gives the numbers the cards show', () => {
  const f = templateFacts(buildFromTemplate('sudoku-easy-expert'));
  assert.equal(f.trimLabel, '6 × 9 in');
  assert.equal(f.puzzles, 200);
  assert.equal(f.sections, 4);
  assert.ok(f.pages >= 100 && f.pages % 2 === 0, `${f.pages} pages`);
  assert.equal(templateFacts(buildFromTemplate('blank')).pages, 24, 'the blank book pads to KDP’s 24-page minimum');
});

test('Brain Games Mix answer keys never leave a section’s last answer alone on a page it could share (every trim)', { timeout: 60000 }, () => {
  const project = buildFromTemplate('brain-games-mix');
  const puzzles = generateAll(project);
  for (const trim of TRIMS.map((t) => t.id)) {
    for (const position of ['end', 'after-section']) {
      for (const answersOnly of [false, true]) {
        const book = layoutBook({ ...project, trim, answers: { ...project.answers, position } }, puzzles, { pro: true, answersOnly });
        const ans = book.pages.filter((pg) => pg.kind === 'answers');
        assert.equal(ans.flatMap((pg) => pg.refs).length, 100, `${trim} ${position}: every answer`);
        for (const pg of ans.filter((x) => x.refs.length === 1)) {
          // Only a one-row grid (2 per page side by side) can't be balanced: 25 = 12 × 2 + 1, as on its puzzle pages.
          const sid = pg.refs[0].sectionId;
          const rowsOfSection = new Set(ans.flatMap((x) => x.refs.filter((r) => r.sectionId === sid).map((r) => Math.round(r.box.y))));
          assert.equal(rowsOfSection.size, 1, `${trim} ${position}${answersOnly ? ' answers-only' : ''}: "${pg.label}" holds a lone answer`);
        }
      }
    }
  }
});

for (const id of [...CONTRACT_IDS, 'sample']) {
  test(`KDP-valid book: ${id} (every puzzle generated, preflight pro:true has no errors)`, { timeout: 60000 }, () => {
    const project = id === 'sample' ? buildFromTemplate('picture-logic', { sample: true }) : buildFromTemplate(id);
    const puzzles = generateAll(project);
    for (const [sid, list] of Object.entries(puzzles)) {
      const failed = list.filter((p) => p.error);
      assert.equal(failed.length, 0, `${id}/${sid}: ${failed.map((p) => p.error).join('; ')}`);
    }
    const book = layoutBook(project, puzzles, { pro: true });
    const pf = preflight(project, book, puzzles, { pro: true });
    assert.deepEqual(pf.errors, [], `${id}: ${pf.errors.map((e) => e.msg).join(' | ')}`);
    assert.equal(pf.warnings.length, 0, `${id}: ${pf.warnings.map((e) => e.msg).join(' | ')}`);
    assert.equal(book.meta.pageCount % 2, 0);
    assert.ok(book.meta.pageCount >= 24 && book.meta.pageCount <= book.meta.maxPages);
    assert.equal(book.meta.pageCount, templateFacts(project).pages, 'the card page count matches the generated book');

    // Free edition: the only error is the proof watermark.
    const free = layoutBook(project, puzzles, { pro: false });
    const fpf = preflight(project, free, puzzles, { pro: false });
    assert.deepEqual(fpf.errors.map((e) => e.code), ['watermark']);
  });
}

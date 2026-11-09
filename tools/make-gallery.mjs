// Writes the static puzzle miniatures used by the landing page: node tools/make-gallery.mjs [--check]
//
// Every miniature is a real puzzle made by the shipped engines (site/js/puzzles/*), checked with the engine's own
// verify(), laid out like a small book page and converted to SVG with site/js/render/svg-backend.js. Seeds are fixed,
// so the output is byte-for-byte reproducible; tools/test/svg-backend.test.mjs fails when site/img/gallery is stale.
//
//   --check   compare with the files on disk instead of writing (exit code 1 if anything differs)
//
// Files (site/img/gallery/):
//   wordsearch.svg, sudoku.svg, maze.svg, nonogram.svg      puzzle-type gallery cards (320 x 400 pt mini pages)
//   picture-source.svg, picture-puzzle.svg, picture-solved.svg   "picture to puzzle" strip (300 x 300 pt panels)
//   demo-house.svg                                          no-JS / pre-load stand-in for the hero demo canvas
//                                                           (named after DEMO_PICTURES[0] in js/site/demo.js)
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { opsToSvg, grayHex } from '../site/js/render/svg-backend.js';
import { text } from '../site/js/layout/displaylist.js';
import { themeById } from '../site/js/layout/themes.js';
import { makeRng } from '../site/js/core/rng.js';
import { PICTURES } from '../site/data/pictures.js';
import * as wordsearch from '../site/js/puzzles/wordsearch.js';
import * as sudoku from '../site/js/puzzles/sudoku.js';
import * as maze from '../site/js/puzzles/maze.js';
import * as nonogram from '../site/js/puzzles/nonogram.js';
import { DEMO_PICTURES, demoPage, demoSeed, nonogramOpts } from '../site/js/site/demo.js';

const OUT = fileURLToPath(new URL('../site/img/gallery/', import.meta.url));
// Relative to site/img/gallery/*.svg. Used when an SVG is opened directly; inside <img> browsers never fetch external
// fonts, so the @font-face also tries a local copy and then falls back to system sans-serif.
const FONT_URLS = { regular: '../../fonts/AtkinsonHyperlegible-Regular.ttf', bold: '../../fonts/AtkinsonHyperlegible-Bold.ttf' };
const STYLE = themeById('standard');

/**
 * Library pictures shown off on the landing page, all at 15×15. Each one fills its grid (no blank edge row or column,
 * so no "0" clue on the border): the "picture to puzzle" strip, and the nonogram type card (also the no-JS stand-in on
 * the nonogram tool page). tools/test/svg-backend.test.mjs checks this.
 */
export const STRIP_PICTURE = 'tree';
export const CARD_PICTURE = 'castle-turret';
export const SHOWCASE_SIZE = 15;
/** Inset of the strip's puzzle and solved panels (pt of 300), close to the margin around the source icon. */
const STRIP_INSET = 20;

function make(engine, opts, seed, index = 0) {
  const p = engine.generate(opts, makeRng(seed), { index, count: 1 });
  const v = engine.verify(p);
  if (!v.ok) throw new Error(`${engine.meta.id} (${seed}) failed verify(): ${v.reason}`);
  return p;
}

function svgOf(ops, w, h, title) {
  return opsToSvg(ops, w, h, { title, fontUrls: FONT_URLS, background: 1 });
}

/**
 * A 320 x 400 pt mini book page: "Puzzle N" heading, the puzzle's own subtitle (puzzle.title, exactly what a book page
 * prints under the heading), the puzzle, and a page number.
 */
function miniPage(engine, puzzle, { num, page }) {
  const subtitle = puzzle.title;
  const W = 320, H = 400;
  const ops = [
    text(W / 2, 34, `Puzzle ${num}`, { size: 15, weight: 'bold', align: 'center', gray: 0 }),
    text(W / 2, 52, subtitle, { size: 10, align: 'center', gray: 0.3 }),
  ];
  const r = engine.draw(puzzle, { x: 20, y: 64, w: W - 40, h: H - 64 - 34 }, STYLE, 'puzzle');
  if (r.warnings.length) throw new Error(`${engine.meta.id}: ${r.warnings.join('; ')}`);
  ops.push(...r.ops);
  ops.push(text(W / 2, H - 14, String(page), { size: 9, align: 'center', gray: 0.3 }));
  return { ops, w: W, h: H };
}

/** The library icon itself (SVG path, viewBox 0 0 256 256) centred on a white 300 x 300 panel. */
function sourcePanel(id) {
  const pic = PICTURES.find((p) => p.id === id);
  if (!pic) throw new Error(`No library picture "${id}"`);
  const S = 300, k = 0.86 * S / 256, off = (S - 256 * k) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" role="img">` +
    `<title>${pic.name}, the original picture</title><rect width="${S}" height="${S}" fill="${grayHex(1)}"/>` +
    `<path transform="translate(${off.toFixed(2)} ${off.toFixed(2)}) scale(${k.toFixed(5)})" fill="${grayHex(0)}" d="${pic.path}"/></svg>`;
}

/**
 * Build every gallery file in memory. `ops` is the display list a file was drawn from (absent for picture-source.svg).
 * @returns {Record<string, {svg: string, w: number, h: number, title: string, ops?: object[]}>}
 */
export function buildGallery() {
  const files = {};
  const put = (name, w, h, title, ops) => { files[name] = { svg: svgOf(ops, w, h, title), w, h, title, ops }; };

  // Word search: 12×12, diagonals, ocean theme.
  const ws = make(wordsearch, {
    ...wordsearch.defaults('standard'), size: 12, difficulty: 'medium', wordCount: 12,
    wordSource: { mode: 'themes', themes: ['ocean-life'] },
  }, 'gallery:wordsearch:1');
  let pg = miniPage(wordsearch, ws, { num: 1, page: 7 });
  put('wordsearch.svg', pg.w, pg.h, `A 12 by 12 word search, ${ws.title}, with its word list`, pg.ops);

  // Sudoku: classic 9×9, medium.
  const sd = make(sudoku, { size: 9, difficulty: 'medium', symmetry: 'rotational' }, 'gallery:sudoku:4');
  pg = miniPage(sudoku, sd, { num: 24, page: 30 });
  put('sudoku.svg', pg.w, pg.h, `A 9 by 9 sudoku, ${sd.stats.grade.toLowerCase()}`, pg.ops);

  // Maze: winding, 14×15 cells.
  const mz = make(maze, { ...maze.defaults('standard'), size: 'custom', cols: 14, rows: 15 }, 'gallery:maze:2');
  pg = miniPage(maze, mz, { num: 41, page: 47 });
  put('maze.svg', pg.w, pg.h, 'A 14 by 15 maze with START and FINISH arrows', pg.ops);

  // Nonogram: a 15×15 library picture that fills its grid (see CARD_PICTURE).
  const ng = make(nonogram, { ...nonogram.defaults('standard'), size: SHOWCASE_SIZE, library: { pictures: [CARD_PICTURE], category: '' } },
    'gallery:nonogram:3');
  pg = miniPage(nonogram, ng, { num: 12, page: 18 });
  put('nonogram.svg', pg.w, pg.h, 'A 15 by 15 picture nonogram with number clues', pg.ops);

  // Picture strip: source icon, the puzzle, and the solved picture in the same box so the reveal lines up.
  const strip = make(nonogram, { ...nonogram.defaults('standard'), size: SHOWCASE_SIZE, library: { pictures: [STRIP_PICTURE], category: '' } },
    'gallery:strip');
  const S = 300, box = { x: STRIP_INSET, y: STRIP_INSET, w: S - 2 * STRIP_INSET, h: S - 2 * STRIP_INSET };
  const name = strip.answerTitle || STRIP_PICTURE;
  files['picture-source.svg'] = { svg: sourcePanel(STRIP_PICTURE), w: S, h: S, title: `${name}, the original picture` };
  const puz = nonogram.draw(strip, box, STYLE, 'puzzle');
  const sol = nonogram.draw(strip, box, STYLE, 'answer');
  put('picture-puzzle.svg', S, S, `The ${name.toLowerCase()} as a 15 by 15 nonogram: clues only`, puz.ops);
  put('picture-solved.svg', S, S, `The solved nonogram reveals the ${name.toLowerCase()}`, sol.ops);

  // Hero demo stand-in: exactly the first state of js/site/demo.js.
  const first = DEMO_PICTURES[0];
  const dp = make(nonogram, nonogramOpts(first), demoSeed('nonogram', first, 0));
  const page = demoPage(nonogram, dp, STYLE, false);
  put(`demo-${first}.svg`, page.w, page.h, 'A 10 by 10 picture puzzle made by the demo', page.ops);
  return files;
}

function main() {
  const check = process.argv.includes('--check');
  const files = buildGallery();
  if (check) {
    const stale = Object.entries(files).filter(([n, f]) => !existsSync(join(OUT, n)) || readFileSync(join(OUT, n), 'utf8') !== f.svg);
    const extra = existsSync(OUT) ? readdirSync(OUT).filter((n) => n.endsWith('.svg') && !files[n]) : [];
    if (stale.length || extra.length) {
      console.error(`Gallery is stale: ${[...stale.map(([n]) => n), ...extra].join(', ')}. Run node tools/make-gallery.mjs`);
      process.exit(1);
    }
    console.log(`Gallery is up to date (${Object.keys(files).length} files).`);
    return;
  }
  mkdirSync(OUT, { recursive: true });
  for (const n of readdirSync(OUT)) if (n.endsWith('.svg') && !files[n]) rmSync(join(OUT, n));
  let bytes = 0;
  for (const [n, f] of Object.entries(files)) {
    writeFileSync(join(OUT, n), f.svg);
    bytes += f.svg.length;
    console.log(`  ${n.padEnd(22)} ${f.w}x${f.h}  ${(f.svg.length / 1024).toFixed(1)} KB  ${f.title}`);
  }
  console.log(`Wrote ${Object.keys(files).length} files (${(bytes / 1024).toFixed(1)} KB) to site/img/gallery/`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

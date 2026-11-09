// Full-wrap cover guide (CONTRACTS.md §7, SPEC 4.7 / 5.4): back | spine | front with bleed, trim lines, spine
// folds, safe zones, the barcode area, dimension labels and the title/author for orientation. Grayscale only.
// The user designs on top of it (or uses it to check their own cover) and hides it before uploading.
// Pure: returns a display list { w, h, ops } in points; the canvas/PDF backends draw it like any page.
import { CONFIG } from '../../config.js';
import {
  coverSize, trimById, COVER_SAFE, SPINE_SAFE, SPINE_TEXT_MIN_PAGES, SPINE_PER_PAGE, BARCODE, inToPt,
} from './specs.js';
import { text, line, rect, poly } from '../layout/displaylist.js';
import { measure, vmetrics } from '../core/fontmetrics.js';
import { cleanLine, fitLine, fitText, paragraph } from '../layout/text.js';

const MM_PER_IN = 25.4;
const GUIDE = { trim: 0, fold: 0, safe: 0.45, bleedEdge: 0.4, label: 0.55, info: 0.2, shade: 0.9 };

/** "6", "0.225", "12.475" — inches with up to 3 decimals, no trailing zeros. */
export function fmtInches(v) { return String(Math.round(v * 1000) / 1000); }
/** Millimetres with one decimal. */
export function fmtMm(v) { return (Math.round(v * MM_PER_IN * 10) / 10).toFixed(1); }
const dims = (w, h) => `${fmtInches(w)} × ${fmtInches(h)} in (${fmtMm(w)} × ${fmtMm(h)} mm)`;
const one = (v) => `${fmtInches(v)} in (${fmtMm(v)} mm)`;

/**
 * @param project   { trim, paper, title, author, spineText? }
 * @param pageCount interior page count (the spine width depends on it)
 * @returns { w, h, ops, size (coverSize, inches), panels:{back,spine,front}, barcode, safe:{back,spine,front},
 *            spineTextAllowed } — all boxes in pt.
 */
export function coverTemplate(project, pageCount, { pro = false } = {}) {
  project = project || {};
  const trim = trimById(project.trim);
  // specs.js has spine data for white and cream; anything else is drawn (and labelled) as white.
  const paper = typeof project.paper === 'string' && SPINE_PER_PAGE[project.paper] != null ? project.paper : 'white';
  const pages = Math.max(0, Math.floor(Number(pageCount) || 0));
  const c = coverSize(trim.id, pages, paper);
  const W = inToPt(c.w), H = inToPt(c.h), b = inToPt(c.bleed);
  const tw = inToPt(c.trimW), th = inToPt(c.trimH), sp = inToPt(c.spine);
  const s = inToPt(COVER_SAFE), ss = inToPt(SPINE_SAFE);

  const panels = {
    back: { x: b, y: b, w: tw, h: th },
    spine: { x: b + tw, y: b, w: sp, h: th },
    front: { x: b + tw + sp, y: b, w: tw, h: th },
  };
  const safe = {
    back: { x: b + s, y: b + s, w: tw - 2 * s, h: th - 2 * s },
    front: { x: panels.front.x + s, y: b + s, w: tw - 2 * s, h: th - 2 * s },
    spine: sp - 2 * ss > 0 ? { x: panels.spine.x + ss, y: b + s, w: sp - 2 * ss, h: th - 2 * s } : null,
  };
  const barcode = {
    x: b + tw - inToPt(BARCODE.inset) - inToPt(BARCODE.w),
    y: b + th - inToPt(BARCODE.inset) - inToPt(BARCODE.h),
    w: inToPt(BARCODE.w), h: inToPt(BARCODE.h),
  };
  const spineTextAllowed = pages >= SPINE_TEXT_MIN_PAGES;
  const ops = [];

  // Bleed band (trimmed off) and spine shaded at 10% ink; panels stay white.
  ops.push(rect(0, 0, W, H, { fill: GUIDE.shade }));
  ops.push(rect(b, b, tw, th, { fill: 1 }), rect(panels.front.x, b, tw, th, { fill: 1 }));
  if (sp > 0) ops.push(rect(panels.spine.x, b, sp, th, { fill: GUIDE.shade }));

  // Outer bleed edge, trim, spine folds (dashed, running into the bleed like crop marks), safe zones.
  ops.push(rect(0.5, 0.5, W - 1, H - 1, { stroke: { w: 1, gray: GUIDE.bleedEdge } }));
  ops.push(rect(b, b, W - 2 * b, th, { stroke: { w: 1, gray: GUIDE.trim } }));
  for (const x of [panels.spine.x, panels.front.x]) {
    ops.push(line(x, 1, x, H - 1, { w: 0.75, gray: GUIDE.fold, dash: [6, 3] }));
  }
  const dashed = { w: 0.75, gray: GUIDE.safe, dash: [4, 3] };
  ops.push(rect(safe.back.x, safe.back.y, safe.back.w, safe.back.h, { stroke: dashed }));
  ops.push(rect(safe.front.x, safe.front.y, safe.front.w, safe.front.h, { stroke: dashed }));
  if (safe.spine && safe.spine.w >= 1.5) ops.push(rect(safe.spine.x, safe.spine.y, safe.spine.w, safe.spine.h, { stroke: dashed }));

  // Barcode area.
  ops.push(rect(barcode.x, barcode.y, barcode.w, barcode.h, { fill: 1, stroke: { w: 1, gray: 0 } }));
  {
    const bx = { x: barcode.x + 6, y: barcode.y + 6, w: barcode.w - 12, h: barcode.h - 12 };
    const p = paragraph(`Barcode area\n${BARCODE.w.toFixed(1)} × ${BARCODE.h.toFixed(1)} in (${fmtMm(BARCODE.w)} × ${fmtMm(BARCODE.h)} mm)\nKeep clear: KDP prints the ISBN barcode here.`,
      bx, { size: 8, align: 'center', valign: 'middle', gray: GUIDE.info, paraGap: 0 });
    ops.push(...p.ops);
  }

  // Panel labels.
  const big = (box, label, y) => {
    const f = fitLine(label, box.w, { max: 28, min: 7, weight: 'bold' });
    ops.push(text(box.x + box.w / 2, y, f.s, { size: f.size, weight: 'bold', align: 'center', gray: GUIDE.label }));
  };
  big(safe.back, 'BACK', safe.back.y + safe.back.h * 0.52);
  big(safe.front, 'FRONT', safe.front.y + 34);
  ops.push(...smallCentered(safe.front, `Front cover · ${dims(c.trimW, c.trimH)}`, safe.front.y + 50));
  ops.push(...smallCentered(safe.back, `Back cover · ${dims(c.trimW, c.trimH)}`, safe.back.y + safe.back.h * 0.52 + 16));
  ops.push(...spineLabel(panels, safe, sp, c, pages));

  // Book title and author on the front, for orientation.
  const title = cleanLine(project.title) || 'Your book title';
  const tbox = { x: safe.front.x + 8, y: safe.front.y + safe.front.h * 0.3, w: safe.front.w - 16, h: safe.front.h * 0.28 };
  ops.push(...fitText(title, tbox, { max: 30, min: 12, weight: 'bold', align: 'center', valign: 'middle', gray: 0.35 }).ops);
  const author = cleanLine(project.author) || 'Author name';
  const af = fitLine(author, safe.front.w - 16, { max: 16, min: 8 });
  ops.push(text(safe.front.x + safe.front.w / 2, safe.front.y + safe.front.h * 0.78, af.s, { size: af.size, align: 'center', gray: 0.35 }));

  // Dimension and rules block, top of the back cover.
  const info = [
    `Cover template · ${title}`,
    `Full cover with bleed: ${dims(c.w, c.h)}`,
    `Trim (front and back): ${dims(c.trimW, c.trimH)}`,
    `Spine: ${one(c.spine)} for ${pages} pages on ${paper} paper`,
    `Bleed: ${one(c.bleed)} on every outside edge (gray band, trimmed off)`,
    `Safe zone (dashed gray): keep text ${one(COVER_SAFE)} inside the trim, and spine text ${one(SPINE_SAFE)} from each fold (dashed black)`,
    spineTextAllowed ? `Spine text allowed (${pages} pages)` : `No spine text under ${SPINE_TEXT_MIN_PAGES} pages`,
    'Hide or delete this guide before you upload your cover.',
  ].join('\n');
  const ibox = { x: safe.back.x + 8, y: safe.back.y + 8, w: safe.back.w - 16, h: safe.back.h * 0.4 };
  ops.push(...fitText(info, ibox, { max: 9, min: 7, align: 'left', gray: GUIDE.info, paraGap: 0, lineGap: 2.5 }).ops);

  // Free edition: credit in the bottom bleed (it is trimmed off a real cover anyway).
  if (!pro) {
    const credit = `Template by ${CONFIG.printDomain}`;
    const size = 7, vm = vmetrics(size);
    const y = H - 1 - vm.descent;
    ops.push(text(panels.front.x + tw / 2, y, credit, { size, align: 'center', gray: 0.4 }));
  }
  return { w: W, h: H, ops, size: c, panels, safe, barcode, spineTextAllowed, pageCount: pages, trim: trim.id, paper };
}

/** One centred 8pt caption line, shrunk to fit. */
function smallCentered(box, s, y) {
  const f = fitLine(s, box.w, { max: 8, min: 7 });
  return [text(box.x + box.w / 2, y, f.s, { size: f.size, align: 'center', gray: GUIDE.info })];
}

/**
 * "SPINE" stacked letter by letter when the letters fit inside the spine's safe zone (so they never sit on the
 * dashed guides), otherwise a pointer label beside the spine.
 */
function spineLabel(panels, safe, sp, c, pages) {
  const ops = [];
  const letters = ['S', 'P', 'I', 'N', 'E'];
  const room = safe.spine ? safe.spine.w - 2 : 0;
  const sz = Math.min(14, Math.floor(room * 0.8 * 4) / 4);
  const widest = Math.max(...letters.map((l) => measure(l, Math.max(7, sz), 'bold')));
  const midY = panels.spine.y + panels.spine.h / 2;
  if (sz >= 7 && widest <= room) {
    const vm = vmetrics(sz, 'bold');
    const pitch = vm.capHeight + sz * 0.45;
    const y0 = midY - (pitch * (letters.length - 1)) / 2 + vm.capHeight / 2;
    letters.forEach((l, i) => ops.push(text(panels.spine.x + sp / 2, y0 + i * pitch, l, { size: sz, weight: 'bold', align: 'center', gray: GUIDE.label })));
  } else {
    // Too narrow for letters: label inside the back panel's safe zone (clear of its dashed line), with a small
    // triangle in the gap between that line and the fold, pointing at the spine.
    const label = `SPINE ${one(c.spine)}`;
    const size = 8;
    const safeRight = safe.back.x + safe.back.w;
    ops.push(text(safeRight - 3, midY + vmetrics(size).capHeight / 2, label, { size, weight: 'bold', align: 'right', gray: GUIDE.label }));
    const tx = (safeRight + panels.spine.x) / 2 - 3;
    ops.push(poly([tx, midY - 3.5, tx + 6, midY, tx, midY + 3.5], { closed: true, fill: GUIDE.label }));
  }
  // Spine text note under the spine label, when there is room on the spine; always in the info block too.
  if (pages > 0 && safe.spine && safe.spine.w > measure('No', 7) + 2) {
    const note = pages >= SPINE_TEXT_MIN_PAGES ? 'Spine text allowed' : 'No spine text';
    const f = fitLine(note, safe.spine.w, { max: 8, min: 7 });
    if (measure(f.s, f.size) <= safe.spine.w && !f.truncated) {
      ops.push(text(panels.spine.x + sp / 2, safe.spine.y + safe.spine.h - 4, f.s, { size: f.size, align: 'center', gray: GUIDE.info }));
    }
  }
  return ops;
}

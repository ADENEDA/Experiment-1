// Display-list ops: the single source of truth for both canvas preview and PDF export.
// Units: points (1/72 in). Origin: top-left of the PDF page, y grows downward.
// Gray levels: 0 = black, 1 = white. NO RGB anywhere (KDP black-ink interiors).
//
//   {t:'text',  x, y, s, size, weight:'regular'|'bold', align:'left'|'center'|'right', gray}
//        y is the BASELINE. Text must only contain glyphs supported by the font (see core/fontmetrics.js).
//   {t:'line',  x1, y1, x2, y2, w, gray, cap:'butt'|'round'|'square', dash?:[on,off]}
//   {t:'rect',  x, y, w, h, r?, stroke?:{w, gray, dash?}, fill?:gray}
//   {t:'poly',  pts:[x0,y0,x1,y1,...], closed, stroke?:{w, gray, cap?, join?:'miter'|'round'}, fill?:gray}
//   {t:'circle',cx, cy, r, stroke?:{w, gray}, fill?:gray}
//
// stroke/fill may be null/undefined. Ops are drawn in order (painter's algorithm).
import { measure, vmetrics } from '../core/fontmetrics.js';

export const text = (x, y, s, { size = 11, weight = 'regular', align = 'left', gray = 0 } = {}) =>
  ({ t: 'text', x, y, s: String(s), size, weight, align, gray });

export const line = (x1, y1, x2, y2, { w = 0.75, gray = 0, cap = 'butt', dash } = {}) => {
  const op = { t: 'line', x1, y1, x2, y2, w, gray, cap };
  if (dash) op.dash = dash;
  return op;
};

export const rect = (x, y, w, h, { stroke = null, fill = null, r = 0 } = {}) => {
  const op = { t: 'rect', x, y, w, h, stroke, fill };
  if (r) op.r = r;
  return op;
};

export const poly = (pts, { closed = true, stroke = null, fill = null } = {}) => ({ t: 'poly', pts, closed, stroke, fill });

export const circle = (cx, cy, r, { stroke = null, fill = null } = {}) => ({ t: 'circle', cx, cy, r, stroke, fill });

/** Text centered in a box, vertically centered on cap height. */
export function textInBox(s, box, { size, weight = 'regular', gray = 0 } = {}) {
  const vm = vmetrics(size, weight);
  return text(box.x + box.w / 2, box.y + box.h / 2 + vm.capHeight / 2, s, { size, weight, align: 'center', gray });
}

/** Axis-aligned bounding box of an op: {x, y, w, h}. Text uses font metrics. */
export function bbox(op) {
  switch (op.t) {
    case 'text': {
      const w = measure(op.s, op.size, op.weight);
      const vm = vmetrics(op.size, op.weight);
      const x = op.align === 'center' ? op.x - w / 2 : op.align === 'right' ? op.x - w : op.x;
      return { x, y: op.y - vm.ascent, w, h: vm.ascent + vm.descent };
    }
    case 'line': {
      const h = (op.w || 0) / 2;
      const x = Math.min(op.x1, op.x2) - h, y = Math.min(op.y1, op.y2) - h;
      return { x, y, w: Math.abs(op.x2 - op.x1) + 2 * h, h: Math.abs(op.y2 - op.y1) + 2 * h };
    }
    case 'rect': {
      const h = op.stroke ? op.stroke.w / 2 : 0;
      return { x: op.x - h, y: op.y - h, w: op.w + 2 * h, h: op.h + 2 * h };
    }
    case 'poly': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < op.pts.length; i += 2) {
        x0 = Math.min(x0, op.pts[i]); x1 = Math.max(x1, op.pts[i]);
        y0 = Math.min(y0, op.pts[i + 1]); y1 = Math.max(y1, op.pts[i + 1]);
      }
      const h = op.stroke ? op.stroke.w / 2 : 0;
      return { x: x0 - h, y: y0 - h, w: x1 - x0 + 2 * h, h: y1 - y0 + 2 * h };
    }
    case 'circle': {
      const r = op.r + (op.stroke ? op.stroke.w / 2 : 0);
      return { x: op.cx - r, y: op.cy - r, w: 2 * r, h: 2 * r };
    }
    default:
      return { x: 0, y: 0, w: 0, h: 0 };
  }
}

export function unionBox(ops) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const op of ops) {
    const b = bbox(op);
    x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w); y1 = Math.max(y1, b.y + b.h);
  }
  return ops.length ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}

/** Translate + uniformly scale ops (returns new ops). Stroke widths and font sizes scale too. */
export function transform(ops, dx, dy, k = 1) {
  return ops.map((op) => {
    const o = { ...op };
    switch (op.t) {
      case 'text': o.x = dx + op.x * k; o.y = dy + op.y * k; o.size = op.size * k; break;
      case 'line': o.x1 = dx + op.x1 * k; o.y1 = dy + op.y1 * k; o.x2 = dx + op.x2 * k; o.y2 = dy + op.y2 * k; o.w = op.w * k; break;
      case 'rect': o.x = dx + op.x * k; o.y = dy + op.y * k; o.w = op.w * k; o.h = op.h * k; if (op.r) o.r = op.r * k; break;
      case 'poly': o.pts = op.pts.map((v, i) => (i % 2 ? dy : dx) + v * k); break;
      case 'circle': o.cx = dx + op.cx * k; o.cy = dy + op.cy * k; o.r = op.r * k; break;
    }
    if (op.stroke) o.stroke = { ...op.stroke, w: op.stroke.w * k };
    return o;
  });
}

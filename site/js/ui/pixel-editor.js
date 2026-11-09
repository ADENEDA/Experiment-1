// Pixel editor for drawing nonogram pictures (SPEC 4.5 "Draw"): pencil, eraser, fill, mirror X/Y, clear, and its own
// undo/redo. Mouse, pen and touch all go through pointer events (touch-action: none, so a finger draws instead of
// scrolling); one pointer draws at a time. Keyboard: arrow keys move a cursor, Shift+arrow paints while moving,
// Space applies the tool, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z undo and redo inside the editor.
//
//   const ed = createPixelEditor({ w: 15, h: 15, bits, onChange(bits) {} });
//   container.append(ed.el); ed.getBits(); ed.setBits(bits, w, h); ed.resize(w, h); ed.clear(); ed.destroy();
//
// The page preview is always white paper, so the grid is drawn as paper and ink in both themes.
import { h } from './dom.js';
import { segmented, svgIcon, uid } from './controls.js';
import { resampleBits } from '../puzzles/nonogram.js';

const MAX_UNDO = 100;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (tested in Node)
// ---------------------------------------------------------------------------------------------------------------

/** Cells on the straight line from (c0,r0) to (c1,r1), both ends included (Bresenham). */
export function lineCells(c0, r0, c1, r1) {
  const out = [];
  let dx = Math.abs(c1 - c0), dy = -Math.abs(r1 - r0);
  const sx = c0 < c1 ? 1 : -1, sy = r0 < r1 ? 1 : -1;
  let err = dx + dy, c = c0, r = r0;
  for (let guard = 0; guard < 10000; guard++) {
    out.push([c, r]);
    if (c === c1 && r === r1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; c += sx; }
    if (e2 <= dx) { err += dx; r += sy; }
  }
  return out;
}

/** The cell plus its mirror images (horizontal: across the vertical axis; vertical: across the horizontal one). */
export function mirrorTargets(c, r, w, h, mirrorX = false, mirrorY = false) {
  const set = new Map();
  const add = (cc, rr) => set.set(rr * w + cc, [cc, rr]);
  add(c, r);
  if (mirrorX) add(w - 1 - c, r);
  if (mirrorY) add(c, h - 1 - r);
  if (mirrorX && mirrorY) add(w - 1 - c, h - 1 - r);
  return [...set.values()];
}

/** 4-connected flood fill from cell index `start` with `value`. Mutates `bits`; returns the cells changed. */
export function floodFill(bits, w, h, start, value) {
  const from = bits[start];
  if (from === value) return 0;
  const stack = [start];
  let n = 0;
  while (stack.length) {
    const i = stack.pop();
    if (bits[i] !== from) continue;
    bits[i] = value;
    n++;
    const r = (i / w) | 0, c = i % w;
    if (c > 0) stack.push(i - 1);
    if (c < w - 1) stack.push(i + 1);
    if (r > 0) stack.push(i - w);
    if (r < h - 1) stack.push(i + w);
  }
  return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {{w:number, h:number, bits?:ArrayLike<number>, onChange?:(bits:Uint8Array)=>void, label?:string, maxPx?:number}} o
 */
export function createPixelEditor({ w, h: height, bits, onChange, label = 'Drawing grid', maxPx = 360 }) {
  let W = w, H = height;
  let grid = new Uint8Array(W * H);
  if (bits && bits.length === W * H) grid.set(Array.from(bits, (v) => (v ? 1 : 0)));
  let tool = 'pencil';
  let mirrorX = false, mirrorY = false;
  let undoStack = [], redoStack = [];
  let cursor = { c: Math.floor(W / 2), r: Math.floor(H / 2) };
  let hover = null;
  let focused = false;
  let kbCursor = false;    // the cursor shows only once the keyboard is used (not after a tap or click)
  let cell = 10;           // CSS px per cell
  let raf = 0;
  let before = null, changed = false, active = null, last = null; // the stroke in progress

  // ------------------------------------------------------------------ DOM
  const tools = segmented({
    options: [
      { value: 'pencil', label: 'Pencil', icon: 'pencil', title: 'Pencil: shade squares' },
      { value: 'eraser', label: 'Eraser', icon: 'eraser', title: 'Eraser: clear squares' },
      { value: 'fill', label: 'Fill', icon: 'bucket', title: 'Fill: flip a whole connected area' },
    ],
    value: tool, label: 'Drawing tool', fk: 'px:tool', cls: 'px-tools',
    onChange: (v) => { tool = v; },
  });
  const toggleBtn = (name, text, fk, get, set) => {
    const b = h('button', { type: 'button', class: 'btn btn-sm btn-icon px-btn', 'aria-pressed': 'false', 'aria-label': text, 'data-fk': fk, title: text },
      svgIcon(name, { size: 16 }));
    b.addEventListener('click', () => { set(!get()); b.setAttribute('aria-pressed', get() ? 'true' : 'false'); });
    return b;
  };
  const mxBtn = toggleBtn('mirror-x', 'Mirror left and right', 'px:mirror-x', () => mirrorX, (v) => { mirrorX = v; });
  const myBtn = toggleBtn('mirror-y', 'Mirror top and bottom', 'px:mirror-y', () => mirrorY, (v) => { mirrorY = v; });
  const undoBtn = h('button', { type: 'button', class: 'btn btn-sm btn-icon px-btn', 'aria-label': 'Undo drawing step', title: 'Undo (Ctrl+Z)', 'data-fk': 'px:undo' }, svgIcon('undo', { size: 16 }));
  const redoBtn = h('button', { type: 'button', class: 'btn btn-sm btn-icon px-btn', 'aria-label': 'Redo drawing step', title: 'Redo (Ctrl+Shift+Z)', 'data-fk': 'px:redo' }, svgIcon('redo', { size: 16 }));
  const clearBtn = h('button', { type: 'button', class: 'btn btn-sm px-btn px-clear', 'data-fk': 'px:clear' }, svgIcon('trash', { size: 16 }), h('span', { text: 'Clear' }));
  undoBtn.addEventListener('click', () => undo());
  redoBtn.addEventListener('click', () => redo());
  clearBtn.addEventListener('click', () => clear());

  const helpId = uid('pxhelp');
  const canvas = h('canvas', {
    class: 'px-canvas', tabindex: '0', role: 'application', 'aria-roledescription': 'drawing grid',
    'aria-label': `${label}, ${W} by ${H} squares`, 'aria-describedby': helpId, 'data-own-keys': '', 'data-fk': 'px:canvas',
  });
  const live = h('div', { class: 'visually-hidden', 'aria-live': 'polite' });
  const help = h('p', { class: 'ins-hint px-help', id: helpId, text: 'Drag to draw with a mouse, pen or finger. Keyboard: arrow keys move, Space shades or clears, Shift+arrows draw a line.' });
  const count = h('span', { class: 'px-count' });
  const frame = h('div', { class: 'px-frame' }, canvas);
  const el = h('div', { class: 'px' },
    h('div', { class: 'px-bar' }, tools.el),
    h('div', { class: 'px-bar px-bar-2' }, mxBtn, myBtn, h('span', { class: 'px-spacer' }), undoBtn, redoBtn, clearBtn),
    frame, h('div', { class: 'px-foot' }, count), help, live);

  // ------------------------------------------------------------------ drawing
  function colors() {
    const cs = getComputedStyle(canvas);
    const v = (n, fb) => (cs.getPropertyValue(n) || '').trim() || fb;
    return {
      paper: v('--px-paper', '#fff'), ink: v('--px-ink', '#000'), line: v('--px-line', '#ccc'),
      bold: v('--px-bold', '#888'), accent: v('--px-accent', '#0e7c66'), hover: v('--px-hover', 'rgba(14,124,102,.35)'),
    };
  }

  function layout() {
    const cs = getComputedStyle(frame);
    const inner = frame.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const avail = Math.max(120, Math.min(maxPx, inner > 0 ? inner : maxPx));
    cell = Math.max(6, Math.floor(avail / Math.max(W, H)));
    const cssW = cell * W, cssH = cell * H;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    const bw = Math.round(cssW * dpr), bh = Math.round(cssH * dpr);
    if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
    draw();
  }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; draw(); });
  }

  function draw() {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const k = canvas.width / (cell * W || 1);
    const col = colors();
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.fillStyle = col.paper;
    ctx.fillRect(0, 0, cell * W, cell * H);
    ctx.fillStyle = col.ink;
    for (let r = 0; r < H; r++) {
      for (let c = 0; c < W; c++) if (grid[r * W + c]) ctx.fillRect(c * cell, r * cell, cell, cell);
    }
    if (hover && !active) {
      ctx.fillStyle = col.hover;
      for (const [c, r] of mirrorTargets(hover.c, hover.r, W, H, mirrorX, mirrorY)) ctx.fillRect(c * cell, r * cell, cell, cell);
    }
    const px = 1 / k;
    const lineAt = (i, n, boldEvery) => (i % boldEvery === 0 || i === n ? col.bold : col.line);
    for (let c = 0; c <= W; c++) {
      ctx.fillStyle = lineAt(c, W, 5);
      const bw = c % 5 === 0 || c === W ? Math.max(px, 1.5 * px) : px;
      ctx.fillRect(Math.min(c * cell, cell * W - bw), 0, bw, cell * H);
    }
    for (let r = 0; r <= H; r++) {
      ctx.fillStyle = lineAt(r, H, 5);
      const bw = r % 5 === 0 || r === H ? Math.max(px, 1.5 * px) : px;
      ctx.fillRect(0, Math.min(r * cell, cell * H - bw), cell * W, bw);
    }
    if (focused && kbCursor) {
      ctx.strokeStyle = col.accent;
      ctx.lineWidth = Math.max(2 * px, 2);
      ctx.strokeRect(cursor.c * cell + 1, cursor.r * cell + 1, cell - 2, cell - 2);
    }
    updateMeta();
  }

  /** Count and button states, kept in sync at once (the canvas itself repaints on the next frame). */
  function updateMeta() {
    let n = 0;
    for (const v of grid) n += v;
    count.textContent = `${W}×${H} · ${n} shaded`;
    undoBtn.disabled = !undoStack.length;
    redoBtn.disabled = !redoStack.length;
    clearBtn.disabled = n === 0;
  }

  // ------------------------------------------------------------------ edits
  const begin = () => { before = grid.slice(); changed = false; };
  const finish = () => {
    if (before && changed) {
      undoStack.push(before);
      if (undoStack.length > MAX_UNDO) undoStack.shift();
      redoStack = [];
      onChange?.(grid.slice());
    }
    before = null; changed = false;
    updateMeta();
    schedule();
  };
  function paintAt(c, r, value) {
    for (const [cc, rr] of mirrorTargets(c, r, W, H, mirrorX, mirrorY)) {
      const i = rr * W + cc;
      if (grid[i] !== value) { grid[i] = value; changed = true; }
    }
  }
  function fillAt(c, r) {
    const i = r * W + c;
    const value = grid[i] ? 0 : 1;
    for (const [cc, rr] of mirrorTargets(c, r, W, H, mirrorX, mirrorY)) {
      if (floodFill(grid, W, H, rr * W + cc, value)) changed = true;
    }
  }

  function cellAt(e, clampIt = false) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    let c = Math.floor(((e.clientX - rect.left) / rect.width) * W);
    let r = Math.floor(((e.clientY - rect.top) / rect.height) * H);
    if (clampIt) { c = Math.max(0, Math.min(W - 1, c)); r = Math.max(0, Math.min(H - 1, r)); }
    return c < 0 || r < 0 || c >= W || r >= H ? null : { c, r };
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (active != null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const at = cellAt(e);
    if (!at) return;
    e.preventDefault();
    kbCursor = false;
    canvas.focus({ preventScroll: true });
    active = e.pointerId;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    cursor = { ...at };
    begin();
    if (tool === 'fill') fillAt(at.c, at.r);
    else paintAt(at.c, at.r, tool === 'eraser' ? 0 : 1);
    last = at;
    schedule();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.pointerId !== active) {
      if (e.pointerType === 'mouse' && active == null) {
        const at = cellAt(e);
        if ((at?.c ?? -1) !== (hover?.c ?? -1) || (at?.r ?? -1) !== (hover?.r ?? -1)) { hover = at; schedule(); }
      }
      return;
    }
    if (tool === 'fill' || !last) return;
    const at = cellAt(e, true);
    if (!at || (at.c === last.c && at.r === last.r)) return;
    const v = tool === 'eraser' ? 0 : 1;
    for (const [c, r] of lineCells(last.c, last.r, at.c, at.r)) paintAt(c, r, v);
    last = at;
    cursor = { ...at };
    updateMeta();
    schedule();
  });
  const end = (e) => {
    if (e.pointerId !== active) return;
    active = null; last = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    finish();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('lostpointercapture', end);
  canvas.addEventListener('pointerleave', () => { if (hover) { hover = null; schedule(); } });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  const say = () => {
    live.textContent = `Row ${cursor.r + 1}, column ${cursor.c + 1}, ${grid[cursor.r * W + cursor.c] ? 'shaded' : 'blank'}`;
  };
  canvas.addEventListener('focus', () => { focused = true; if (canvas.matches(':focus-visible')) kbCursor = true; schedule(); });
  canvas.addEventListener('blur', () => { focused = false; schedule(); });
  canvas.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod && !kbCursor && /^(Arrow|Home$|End$| $|Enter$)/.test(e.key)) { kbCursor = true; schedule(); }
    if (mod && !e.altKey && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault(); e.stopPropagation();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) redo(); else undo();
      return;
    }
    if (mod || e.altKey) return;
    const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (moves[e.key]) {
      e.preventDefault();
      const [dc, dr] = moves[e.key];
      const next = { c: Math.max(0, Math.min(W - 1, cursor.c + dc)), r: Math.max(0, Math.min(H - 1, cursor.r + dr)) };
      if (e.shiftKey && tool !== 'fill') {
        begin();
        const v = tool === 'eraser' ? 0 : 1;
        paintAt(cursor.c, cursor.r, v);
        paintAt(next.c, next.r, v);
        cursor = next;
        finish();
      } else { cursor = next; schedule(); }
      say();
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      begin();
      if (tool === 'fill') fillAt(cursor.c, cursor.r);
      else if (tool === 'eraser') paintAt(cursor.c, cursor.r, 0);
      else paintAt(cursor.c, cursor.r, grid[cursor.r * W + cursor.c] ? 0 : 1);
      finish();
      say();
    } else if (e.key === 'Home') { e.preventDefault(); cursor = { c: 0, r: cursor.r }; schedule(); say(); }
    else if (e.key === 'End') { e.preventDefault(); cursor = { c: W - 1, r: cursor.r }; schedule(); say(); }
  });

  // ------------------------------------------------------------------ API
  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(grid);
    grid = undoStack.pop();
    updateMeta();
    schedule();
    onChange?.(grid.slice());
    return true;
  }
  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(grid);
    grid = redoStack.pop();
    updateMeta();
    schedule();
    onChange?.(grid.slice());
    return true;
  }
  function clear() {
    if (!grid.some((v) => v)) return;
    begin();
    grid.fill(0);
    changed = true;
    finish();
  }
  function setBits(b, w2 = W, h2 = H) {
    W = w2; H = h2;
    grid = new Uint8Array(W * H);
    if (b && b.length === W * H) grid.set(Array.from(b, (v) => (v ? 1 : 0)));
    undoStack = []; redoStack = [];
    cursor = { c: Math.min(cursor.c, W - 1), r: Math.min(cursor.r, H - 1) };
    canvas.setAttribute('aria-label', `${label}, ${W} by ${H} squares`);
    updateMeta();
    layout();
  }
  /** Change the grid size, resampling the drawing (one undoable step is not kept: sizes differ). */
  function resize(w2, h2) {
    if (w2 === W && h2 === H) return;
    const next = grid.some((v) => v) ? resampleBits(grid, W, H, w2, h2) : new Uint8Array(w2 * h2);
    setBits(next, w2, h2);
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => layout()) : null;
  ro?.observe(frame);
  const dark = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  const onScheme = () => schedule();
  dark?.addEventListener?.('change', onScheme);
  updateMeta();
  requestAnimationFrame(layout);

  return {
    el, canvas,
    getBits: () => grid.slice(),
    get w() { return W; },
    get h() { return H; },
    isEmpty: () => !grid.some((v) => v),
    setBits, resize, clear, undo, redo,
    canUndo: () => undoStack.length > 0,
    focus: () => canvas.focus(),
    destroy() { ro?.disconnect(); dark?.removeEventListener?.('change', onScheme); cancelAnimationFrame(raf); },
  };
}

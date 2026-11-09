// Typography/ink themes. Sizes in points. Gray levels: 0 = black ink, 1 = white paper.
// Puzzle draw() functions read the per-element minimums and warn when a box is too small.

const base = {
  font: 'regular',
  ink: 0,            // main text and grid lines
  softInk: 0.3,      // secondary text (captions, page numbers)
  faintInk: 0.55,    // watermark/proof text, notes lines
  highlight: 0.82,   // answer highlight fill (18% ink; >= 10% so it prints)
  shade: 0.75,       // shaded cells (kakuro clue cells, nonogram givens)
  gridThin: 0.75,    // never below KDP-safe 0.75pt
  gridThick: 2,
  gridOuter: 2.25,
};

export const THEMES = {
  standard: {
    ...base,
    id: 'standard', label: 'Standard',
    h1: 30, h2: 20, h3: 15, body: 11, small: 9.5, caption: 8.5,
    puzzleTitle: 17, pageNumber: 9.5,
    min: { text: 8, letter: 10, digit: 13, clue: 7, word: 9 },
    pref: { letter: 15, digit: 22, clue: 10, word: 11.5 },
  },
  large: {
    ...base,
    id: 'large', label: 'Large Print',
    h1: 40, h2: 28, h3: 20, body: 16, small: 14, caption: 12,
    puzzleTitle: 24, pageNumber: 14,
    min: { text: 14, letter: 18, digit: 22, clue: 14, word: 16 },
    pref: { letter: 22, digit: 30, clue: 16, word: 18 },
    gridThin: 1, gridThick: 2.5, gridOuter: 3,
  },
  kids: {
    ...base,
    id: 'kids', label: 'Kids',
    h1: 36, h2: 24, h3: 18, body: 14, small: 12, caption: 10,
    puzzleTitle: 22, pageNumber: 12,
    min: { text: 12, letter: 14, digit: 18, clue: 11, word: 13 },
    pref: { letter: 20, digit: 28, clue: 13, word: 16 },
    gridThin: 1, gridThick: 2.5, gridOuter: 3,
  },
};

export function themeById(id) {
  return THEMES[id] || THEMES.standard;
}

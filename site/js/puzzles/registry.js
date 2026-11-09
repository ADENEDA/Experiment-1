// Registry of puzzle engines. Every engine module implements the contract in CONTRACTS.md §3.
import * as wordsearch from './wordsearch.js';
import * as sudoku from './sudoku.js';
import * as maze from './maze.js';
import * as nonogram from './nonogram.js';

export { GenTimeout } from './common.js';

/** Display order in menus. */
export const TYPE_ORDER = ['wordsearch', 'sudoku', 'maze', 'nonogram'];

export const TYPES = { wordsearch, sudoku, maze, nonogram };

export function getType(id) {
  const t = TYPES[id];
  if (!t) throw new Error(`Unknown puzzle type: ${id}`);
  return t;
}

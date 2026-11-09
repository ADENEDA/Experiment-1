// PLACEHOLDER — replaced by the real engine. Keeps registry.js importable meanwhile.
export const meta = { id: 'sudoku', name: 'sudoku', plural: 'sudoku', blurb: '', howTo: [], perPage: [1], defaultPerPage: 1, answerPerPage: [6] };
export const controls = [];
export function defaults() { return {}; }
export function generate() { throw new Error('sudoku engine not implemented yet'); }
export function verify() { return { ok: false, reason: 'not implemented' }; }
export function draw() { return { ops: [], warnings: ['not implemented'] }; }

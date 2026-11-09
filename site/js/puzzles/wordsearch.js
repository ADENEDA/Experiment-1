// PLACEHOLDER — replaced by the real engine. Keeps registry.js importable meanwhile.
export const meta = { id: 'wordsearch', name: 'wordsearch', plural: 'wordsearch', blurb: '', howTo: [], perPage: [1], defaultPerPage: 1, answerPerPage: [6] };
export const controls = [];
export function defaults() { return {}; }
export function generate() { throw new Error('wordsearch engine not implemented yet'); }
export function verify() { return { ok: false, reason: 'not implemented' }; }
export function draw() { return { ops: [], warnings: ['not implemented'] }; }

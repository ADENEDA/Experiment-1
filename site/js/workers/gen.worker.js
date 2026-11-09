// Puzzle generator worker (MODULE worker). One job at a time; protocol owned by puzzles/generate.js:
//   main -> worker  {type:'gen', id, job:{type, opts, seed, index, count, deadlineMs}}
//   worker -> main  {type:'ready'} once the engines are loaded
//                   {type:'result', id, puzzle} | {type:'result', id, error, timeout?}
// The deadline is computed here (performance.now() has a different origin in each worker).
import { getType } from '../puzzles/registry.js';
import { runJob } from '../puzzles/generate.js';

self.onmessage = (e) => {
  const m = e.data;
  if (!m || m.type !== 'gen') return;
  const res = runJob(getType, m.job);
  try {
    self.postMessage({ type: 'result', id: m.id, ...res });
  } catch (err) { // e.g. DataCloneError: an engine returned something that can't be structured-cloned
    self.postMessage({ type: 'result', id: m.id, error: `The puzzle could not be sent back (${err?.message || err})` });
  }
};

self.postMessage({ type: 'ready' });

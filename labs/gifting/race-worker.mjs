// Separate SQLite connections contend on the same offer in the race exercises.
import { parentPort, workerData } from 'node:worker_threads';
import { GiftLab } from './lab.mjs';
const { file, offer, gate, action } = workerData;
const lab = new GiftLab(file);
const barrier = new Int32Array(gate);
parentPort.postMessage('ready');
Atomics.wait(barrier, 0, 0);
try {
  if (action === 'claim') lab.claim('Studio', offer);
  else if (action === 'expire') lab.tick(15);
  else if (action === 'worker') lab.reconcile('Studio', offer);
  else lab.emit('rewards', { id: 'order-ready', kind: 'order.updated', workspace: 'Studio', offer });
} finally {
  lab.db.close();
}

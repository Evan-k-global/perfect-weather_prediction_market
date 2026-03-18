let worker = null;
let nextId = 1;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker('/public/browser/client-bet-worker.js', { type: 'module' });
    worker.onmessage = (event) => {
      const { id, ok, result, error } = event.data || {};
      const handlers = pending.get(id);
      if (!handlers) return;
      pending.delete(id);
      if (ok) handlers.resolve(result);
      else handlers.reject(new Error(error || 'worker request failed'));
    };
    worker.onerror = (event) => {
      for (const [id, handlers] of pending.entries()) {
        pending.delete(id);
        handlers.reject(new Error(event.message || 'client bet worker crashed'));
      }
    };
  }
  return worker;
}

function callWorker(type, payload) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, payload });
  });
}

export async function warmupReceiptBetClient(network) {
  return await callWorker('warmup', { network });
}

export async function buildReceiptBetTx(context) {
  return await callWorker('buildReceiptBetTx', { context });
}

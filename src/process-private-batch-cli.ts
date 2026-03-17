import './env.js';

import { readFile } from 'node:fs/promises';
import { DEFAULT_STATE_FILE } from './state-store.js';
import { proveAndSendPrivateQueuedBet, type PrivateQueuedBet } from './private-batch-processor.js';

function parseOptionalArgValue(args: string[], name: string): string | null {
  const flag = `--${name}`;
  const idx = args.indexOf(flag);
  if (idx === -1) return null;
  const next = args[idx + 1];
  return typeof next === 'string' && next.length > 0 ? next : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = parseOptionalArgValue(args, 'state-file') || process.env.STATE_FILE || DEFAULT_STATE_FILE;
  const batchFile = parseOptionalArgValue(args, 'batch-file');
  if (!batchFile) {
    throw new Error('Missing required --batch-file');
  }
  const raw = await readFile(batchFile, 'utf8');
  const queuedBet = JSON.parse(raw) as PrivateQueuedBet;
  const result = await proveAndSendPrivateQueuedBet({
    queuedBet,
    stateFile
  });
  process.stdout.write(JSON.stringify(result));
}

main().catch((error: unknown) => {
  console.error('[process-private-batch-cli] failed:', error);
  process.exit(1);
});

import './env.js';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('./data');
const DEFAULT_KEEP_CONTEST_DAYS = 14;
const DEFAULT_KEEP_OPERATOR_BACKUPS = 3;
const DEFAULT_KEEP_BATCH_HISTORY = 200;

function parseOptionalArgValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = args.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length) return args[idx + 1];
  return undefined;
}

function parseNumberArg(args: string[], name: string, fallback: number): number {
  const value = parseOptionalArgValue(args, name);
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid --${name}: ${value}`);
  return Math.floor(n);
}

function parseDateFromContestFilename(fileName: string): string | null {
  const match = /^weather-contest-94027-(\d{4}-\d{2}-\d{2})\.json$/.exec(fileName);
  return match ? match[1] : null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pruneOperatorBackups(keep: number): Promise<{ removed: string[] }> {
  const entries = await readdir(DATA_DIR);
  const backups = entries
    .filter((name) => /^operator-state\.backup\..+\.json$/.test(name))
    .sort()
    .reverse();
  const toRemove = backups.slice(keep);
  for (const name of toRemove) {
    await rm(path.join(DATA_DIR, name), { force: true });
  }
  return { removed: toRemove };
}

async function pruneContestFiles(keepDays: number): Promise<{ removed: string[]; kept: string[] }> {
  const entries = await readdir(DATA_DIR);
  const contests = entries
    .map((name) => ({ name, date: parseDateFromContestFilename(name) }))
    .filter((item): item is { name: string; date: string } => Boolean(item.date))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const kept = contests.slice(0, keepDays).map((item) => item.name);
  const removed = contests.slice(keepDays).map((item) => item.name);
  for (const name of removed) {
    await rm(path.join(DATA_DIR, name), { force: true });
  }
  return { removed, kept };
}

async function trimBatchHistory(maxItems: number): Promise<{ before: number; after: number }> {
  const filePath = path.join(DATA_DIR, 'private-batch-history.json');
  if (!(await fileExists(filePath))) return { before: 0, after: 0 };
  const raw = await readFile(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return { before: 0, after: 0 };
  const before = parsed.length;
  const trimmed = parsed.slice(0, maxItems);
  if (trimmed.length !== before) {
    await writeFile(filePath, JSON.stringify(trimmed, null, 2), 'utf8');
  }
  return { before, after: trimmed.length };
}

export type CleanupDataOptions = {
  keepContestDays?: number;
  keepOperatorBackups?: number;
  keepBatchHistory?: number;
};

export async function cleanupData(options: CleanupDataOptions = {}): Promise<{
  ok: true;
  dataDir: string;
  operatorBackups: { removed: string[] };
  contestFiles: { removed: string[]; kept: string[] };
  batchHistory: { before: number; after: number };
  untouched: string[];
}> {
  const keepContestDays = options.keepContestDays ?? DEFAULT_KEEP_CONTEST_DAYS;
  const keepOperatorBackups = options.keepOperatorBackups ?? DEFAULT_KEEP_OPERATOR_BACKUPS;
  const keepBatchHistory = options.keepBatchHistory ?? DEFAULT_KEEP_BATCH_HISTORY;
  await mkdir(DATA_DIR, { recursive: true });

  const operatorBackups = await pruneOperatorBackups(keepOperatorBackups);
  const contestFiles = await pruneContestFiles(keepContestDays);
  const batchHistory = await trimBatchHistory(keepBatchHistory);

  return {
    ok: true,
    dataDir: DATA_DIR,
    operatorBackups,
    contestFiles,
    batchHistory,
    untouched: [
      'operator-state.json',
      'operator-state.legacy.json',
      'daily-settle-state.json',
      'demo-daily-threshold-markets.json',
      'weather-94027.json',
      'weather-attestation.json',
      'tlsn-output/latest/attestation.json',
      'tlsn-certs/*',
      'private-bet-queue.json',
      'user-positions.json'
    ]
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await cleanupData({
    keepContestDays: parseNumberArg(args, 'keep-contest-days', DEFAULT_KEEP_CONTEST_DAYS),
    keepOperatorBackups: parseNumberArg(args, 'keep-operator-backups', DEFAULT_KEEP_OPERATOR_BACKUPS),
    keepBatchHistory: parseNumberArg(args, 'keep-batch-history', DEFAULT_KEEP_BATCH_HISTORY)
  });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error('[cleanup:data] failed:', error);
  process.exit(1);
});

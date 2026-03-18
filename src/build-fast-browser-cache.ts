import 'reflect-metadata';
import './env.js';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Cache } from 'o1js';
import { FastPredictionMarketPlatform } from './fast-contract.js';

const OUTPUT_DIR = path.resolve(process.cwd(), 'public/browser/o1-fast-cache');

type CacheManifest = {
  generatedAt: string;
  files: Array<{
    name: string;
    kind: 'header' | 'data';
  }>;
};

async function main(): Promise<void> {
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log(`[fast-cache] compiling FastPredictionMarketPlatform into ${OUTPUT_DIR}`);
  await FastPredictionMarketPlatform.compile({
    cache: { ...Cache.FileSystem(OUTPUT_DIR), canWrite: true }
  });

  const names = (await readdir(OUTPUT_DIR)).sort();
  const manifest: CacheManifest = {
    generatedAt: new Date().toISOString(),
    files: names.map((name) => ({
      name,
      kind: name.endsWith('.header') ? 'header' : 'data'
    }))
  };

  await writeFile(path.join(OUTPUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  let totalBytes = 0;
  for (const name of names) {
    const bytes = await readFile(path.join(OUTPUT_DIR, name));
    totalBytes += bytes.byteLength;
  }

  console.log(`[fast-cache] files=${names.length} bytes=${totalBytes}`);
  console.log(`[fast-cache] manifest=${path.join(OUTPUT_DIR, 'manifest.json')}`);
}

main().catch((error: unknown) => {
  console.error('[fast-cache] failed:', error);
  process.exit(1);
});

import 'reflect-metadata';
import './env.js';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { FastPredictionMarketPlatform } from './fast-contract.js';
import { getFastNodeCacheDir, getFastNodeCompileCache } from './fast-compile-cache.js';

type CacheManifest = {
  generatedAt: string;
  files: Array<{
    name: string;
  }>;
};

async function main(): Promise<void> {
  const outputDir = getFastNodeCacheDir();
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  console.log(`[fast-node-cache] compiling FastPredictionMarketPlatform into ${outputDir}`);
  await FastPredictionMarketPlatform.compile({
    cache: getFastNodeCompileCache()
  });

  const names = (await readdir(outputDir)).sort();
  const manifest: CacheManifest = {
    generatedAt: new Date().toISOString(),
    files: names.map((name) => ({ name }))
  };
  await writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  let totalBytes = 0;
  for (const name of names) {
    const bytes = await readFile(path.join(outputDir, name));
    totalBytes += bytes.byteLength;
  }
  console.log(`[fast-node-cache] files=${names.length} bytes=${totalBytes}`);
  console.log(`[fast-node-cache] manifest=${path.join(outputDir, 'manifest.json')}`);
}

main().catch((error: unknown) => {
  console.error('[fast-node-cache] failed:', error);
  process.exit(1);
});


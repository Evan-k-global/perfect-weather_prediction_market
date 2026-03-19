import path from 'node:path';
import { Cache } from 'o1js';

const DEFAULT_NODE_CACHE_DIR = path.resolve(process.cwd(), 'data', 'o1-fast-cache-node');

export function getFastNodeCacheDir(): string {
  return path.resolve(process.env.O1_FAST_NODE_CACHE_DIR || DEFAULT_NODE_CACHE_DIR);
}

export function getFastNodeCompileCache() {
  return {
    ...Cache.FileSystem(getFastNodeCacheDir()),
    canWrite: true
  };
}


// Build-time access to the JSON written by scripts/shape.mjs.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(process.cwd(), 'src', 'generated');
const cache = new Map();

export function load(name) {
  if (!cache.has(name)) {
    const file = join(DIR, name + '.json');
    if (!existsSync(file)) throw new Error(`Missing ${file}. Run "npm run shape" (or "npm run build") first.`);
    cache.set(name, JSON.parse(readFileSync(file, 'utf8')));
  }
  return cache.get(name);
}

export const site = () => load('site');
export const season = (year) => load(`season-${year}`);
export const games = (year) => load(`games-${year}`);
export const owner = (slug) => load(`owner-${slug}`);
export const leaderboards = () => load('leaderboards');
export const ownerSeason = (slug, year) => load(`os-${slug}-${year}`);

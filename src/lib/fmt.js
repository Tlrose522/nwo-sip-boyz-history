// Formatting helpers shared by every page.

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
/** Site-relative link that respects the GitHub Pages base path: href('seasons/2019/') */
export const href = (path = '') => `${BASE}/${String(path).replace(/^\//, '')}`;

export const seasonHref = (y) => href(`seasons/${y}/`);
export const weekHref = (y, w) => href(`seasons/${y}/week-${w}/`);
export const gameHref = (y, w, slug) => href(`seasons/${y}/week-${w}/${slug}/`);
export const ownerHref = (slug) => href(`owners/${slug}/`);

export function ord(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = n % 100;
  return n + (v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
}

/** 1234.5 → "1,234.5" (dp decimals, fixed) */
export function num(x, dp = 1) {
  if (x === null || x === undefined || x === '' || Number.isNaN(Number(x))) return '—';
  return Number(x).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** Signed with a real minus: +1.2 / −0.8 / 0.0 */
export function signed(x, dp = 1) {
  if (x === null || x === undefined || x === '') return '—';
  const v = Number(x);
  return (v > 0 ? '+' : v < 0 ? '−' : '') + num(Math.abs(v), dp);
}

/** .583 style rate */
export const rate = (x) => (x === null || x === undefined || x === '' ? '—' : Number(x).toFixed(3).replace(/^0/, '').replace(/^-0/, '−'));

export const record = (w, l, t) => `${w}-${l}${t ? '-' + t : ''}`;
export const upDown = (x) => (x === null || x === undefined ? '' : Number(x) >= 0 ? 'up' : 'down');
export const firstName = (p) => (p || '').split(' ')[0];
export const initials = (p) => (p || '?').split(/\s+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase();

/** NFL Street scale color for a 0–100 value (percentile). */
export function scaleColor(v) {
  return v <= 15 ? 'var(--s-1)' : v <= 30 ? 'var(--s-2)' : v <= 45 ? 'var(--s-3)' : v <= 55 ? 'var(--s-4)'
    : v <= 65 ? 'var(--s-5)' : v <= 80 ? 'var(--s-6)' : v <= 90 ? 'var(--s-7)' : 'var(--s-8)';
}
export function tier(pct) {
  if (pct >= 90) return { label: 'ELITE', color: 'var(--s-8)' };
  if (pct >= 65) return { label: 'STRONG', color: 'var(--s-6)' };
  if (pct >= 45) return { label: 'AVERAGE', color: 'var(--s-4)' };
  return { label: 'WEAK', color: '#E8513A' };
}
/** League rank (1 = best of n) on the same scale. */
export function rankColor(r, n = 14) {
  const t = (r - 1) / Math.max(1, n - 1); // 0 best → 1 worst
  return t <= 0.08 ? 'var(--s-8)' : t <= 0.31 ? 'var(--s-6)' : t <= 0.47 ? 'var(--s-5)' : t <= 0.62 ? 'var(--s-4)'
    : t <= 0.78 ? 'var(--s-3)' : 'var(--s-1)';
}

export function weekLabel(w, gameType, regularWeeks) {
  if (gameType === 'regular' || !gameType || w <= regularWeeks) return `Week ${w}`;
  return `Playoffs · week ${w}`;
}

export function roundName(index, total) {
  const fromEnd = total - index;
  return fromEnd === 1 ? 'Final' : fromEnd === 2 ? 'Semifinals' : fromEnd === 3 ? 'Quarterfinals' : `Round ${index + 1}`;
}

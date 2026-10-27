// Served as /data/players.json at build time; the Players page fetches it.
import { load } from '../../lib/data.js';

export function GET() {
  return new Response(JSON.stringify(load('players')), { headers: { 'Content-Type': 'application/json' } });
}

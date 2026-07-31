/**
 * Canonical implementations of the fuzzy task/section/tag matcher and the
 * relative-date parser used by the Slack agent (minisana-agent.js).
 *
 * public/index.html (the browser client) has its OWN copies of both — named
 * `fuzzy`/`parseRelativeDate` there — because it's a single classic
 * (non-module) <script>, loaded with 50+ inline onclick="..." handlers that
 * depend on everything being in one global scope. Loading this file there
 * via `<script type="module">` would only expose these functions on
 * `window`, not solve the actual duplication, and mixing module/classic
 * script load order on that heavily onclick-driven page is a real footgun
 * (module scripts always defer, regardless of tag position). Not worth that
 * risk just to dedupe ~40 lines of pure logic — so the client copy stays a
 * copy, but it's SUPPOSED to be byte-identical logic to what's here. If you
 * change the matching/date-parsing behavior, change it in BOTH places.
 */

export function fuzzyMatch(list, name) {
  if (!name || !list) return null;
  const n = name.toLowerCase().trim();
  const safe = i => i.name ? i.name.toLowerCase() : "";
  const direct = list.find(i => safe(i) === n)
    || list.find(i => safe(i).startsWith(n))
    || list.find(i => safe(i) && safe(i).includes(n))
    || list.find(i => safe(i) && n.includes(safe(i)))
    || list.find(i => { const w = n.split(/\s+/).filter(x => x.length > 2); return w.length && w.every(x => safe(i).includes(x)); })
    || list.find(i => { const w = n.split(/\s+/).filter(x => x.length > 2); return w.length && w.some(x => safe(i).includes(x)); });
  if (direct) return direct;
  const toks = s => new Set((s || "").split(/[\s\-_/]+/).filter(w => w.length > 1));
  const a = toks(n); if (!a.size) return null;
  let best = null, bestScore = 0;
  for (const i of list) { const b = toks(safe(i)); if (!b.size) continue; let inter = 0; for (const w of a) if (b.has(w)) inter++; const score = inter / Math.max(a.size, b.size); if (score > bestScore) { bestScore = score; best = i; } }
  return bestScore >= 0.5 ? best : null;
}

export function parseRelativeDate(s) {
  if (!s || typeof s !== "string") return s;
  const t = s.trim().toLowerCase(); if (!t) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const DOW = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
  if (t === "today") return iso(today);
  if (t === "tomorrow" || t === "tmrw" || t === "tmr") return iso(addDays(today, 1));
  if (t === "yesterday") return iso(addDays(today, -1));
  if (t === "end of week" || t === "eow") { const off = (5 - today.getDay() + 7) % 7 || 7; return iso(addDays(today, off)); }
  if (t === "next week") return iso(addDays(today, 7));
  if (t === "next month") { const x = new Date(today); x.setMonth(x.getMonth() + 1); return iso(x); }
  const inDays = t.match(/^in\s+(\d+)\s+day(s)?$/); if (inDays) return iso(addDays(today, parseInt(inDays[1], 10)));
  const inWeeks = t.match(/^in\s+(\d+)\s+week(s)?$/); if (inWeeks) return iso(addDays(today, parseInt(inWeeks[1], 10) * 7));
  const nextDow = t.match(/^next\s+(\w+)$/); if (nextDow && DOW[nextDow[1]] != null) { const d = DOW[nextDow[1]]; const off = ((d - today.getDay() + 7) % 7) || 7; return iso(addDays(today, off)); }
  if (DOW[t] != null) { const d = DOW[t]; const off = ((d - today.getDay() + 7) % 7) || 7; return iso(addDays(today, off)); }
  return s;
}

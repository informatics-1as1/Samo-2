// Run: node server.js   (Node.js 16+, no packages needed)
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const PORT = process.env.PORT || 3000, SECS = 20, ROUNDS = 12;
const Q = JSON.parse(fs.readFileSync(path.join(__dirname, 'questions.json'), 'utf8')); // [question, [correct, wrong, wrong, wrong]]
const teams = ['red', 'blue'], devs = new Map(), clients = new Set();
let phase = 'lobby', order = [], idx = 0, score = { red: 0, blue: 0 }, cur = [], correctI = 0, deadline = 0, timer = null, result = null;

const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const urls = () => Object.values(os.networkInterfaces()).flat().filter(i => i.family === 'IPv4' && !i.internal).map(i => `http://${i.address}:${PORT}`);
const nTeam = t => { const live = new Set([...clients].map(c => c.id)); return [...devs].filter(([id, x]) => x === t && live.has(id)).length; };

function stateFor(id) {
  const s = { phase, team: devs.get(id) || null, score, secs: SECS, n: { red: nTeam('red'), blue: nTeam('blue') }, idx, total: order.length };
  if (phase === 'question' || phase === 'reveal') {
    s.turn = teams[idx % 2]; s.q = Q[order[idx]][0]; s.opts = cur.map(o => o.t);
    s.left = phase === 'question' ? Math.max(0, deadline - Date.now()) : 0;
  }
  if (phase === 'reveal') s.res = { kind: result.kind, pick: result.pick, correct: correctI };
  return s;
}
const push = () => { for (const c of clients) c.res.write(`data: ${JSON.stringify(stateFor(c.id))}\n\n`); };

function ask() {
  const item = Q[order[idx]];
  cur = shuffle(item[1].map((t, i) => ({ t, c: i === 0 })));
  correctI = cur.findIndex(o => o.c);
  phase = 'question'; deadline = Date.now() + SECS * 1000;
  clearTimeout(timer); timer = setTimeout(() => resolve('timeout', null), SECS * 1000 + 400);
  push();
}
function begin() {
  order = shuffle(Q.map((_, i) => i)).slice(0, ROUNDS); idx = 0; score = { red: 0, blue: 0 }; ask();
}
function resolve(kind, pick) {
  if (phase !== 'question') return;
  clearTimeout(timer);
  if (kind === 'ok') score[teams[idx % 2]]++;
  phase = 'reveal'; result = { kind, pick }; push();
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');

  if (req.method === 'GET' && u.pathname === '/events') {
    const id = u.searchParams.get('id');
    if (!devs.has(id)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const c = { res, id }; clients.add(c);
    res.write('retry: 1500\n\n');
    const ka = setInterval(() => res.write(': ka\n\n'), 15000);
    req.on('close', () => { clearInterval(ka); clients.delete(c); push(); });
    return push();
  }

  if (req.method === 'GET' && u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }

  if (req.method === 'POST') {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 3000) req.destroy(); });
    req.on('end', () => {
      let j = {}; try { j = JSON.parse(b || '{}'); } catch {}
      const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      const p = u.pathname;

      if (p === '/api/join') {
        if (!teams.includes(j.team)) return out(400, {});
        const id = crypto.randomUUID(); devs.set(id, j.team); push(); return out(200, { id });
      }
      if (!devs.has(j.id)) return out(403, {});

      if (p === '/api/leave') { devs.delete(j.id); push(); return out(200, {}); }
      if (p === '/api/start') {
        if (phase !== 'lobby') return out(200, {});
        if (!nTeam('red') || !nTeam('blue')) return out(400, { error: 'يجب أن ينضم جهاز واحد على الأقل لكل فريق' });
        begin(); return out(200, {});
      }
      if (p === '/api/answer') {
        const pick = Number(j.pick);
        if (phase !== 'question' || devs.get(j.id) !== teams[idx % 2] || !Number.isInteger(pick) || pick < 0 || pick >= cur.length || Date.now() > deadline + 300) return out(400, {});
        resolve(pick === correctI ? 'ok' : 'bad', pick); return out(200, {});
      }
      if (p === '/api/next') {
        if (phase === 'reveal' && Number(j.idx) === idx) { idx++; if (idx < order.length) ask(); else { phase = 'final'; push(); } }
        return out(200, {});
      }
      if (p === '/api/again') { if (phase === 'final') begin(); return out(200, {}); }
      out(404, {});
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Open one of these links on every phone (one team per device):');
  (urls().length ? urls() : [`http://localhost:${PORT}`]).forEach(x => console.log('  ' + x));
});

import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.VERCEL && existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const dataDir = process.env.VERIFIO_DATA_DIR || path.join(root, 'data');
const dbPath = path.join(dataDir, 'verifio.sqlite');
const legacyPath = path.join(dataDir, 'store.json');
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const isVercel = Boolean(process.env.VERCEL);
let sql = null;
let pgPool = null;
let pgDirty = false;
let pgSchemaPromise = null;
if (!databaseUrl && isVercel) {
  // Vercel's filesystem is ephemeral. Never silently store production data there.
  console.warn('DATABASE_URL is required for persistent Verifio data on Vercel.');
} else if (!databaseUrl) {
  mkdirSync(dataDir, { recursive: true });
  sql = new DatabaseSync(dbPath);
  sql.exec(`PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS verification_links (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, checks INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS reference_tickets (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, expiry TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verification_logs (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, link_id TEXT NOT NULL,
  code TEXT NOT NULL, expiry TEXT NOT NULL, result TEXT NOT NULL, checked_at TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '', price TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS verification_logs_link_idx ON verification_logs(link_id);
CREATE INDEX IF NOT EXISTS verification_logs_code_idx ON verification_logs(code);
CREATE INDEX IF NOT EXISTS verification_logs_checked_idx ON verification_logs(checked_at);
`);
  const logColumns = new Set(sql.prepare('PRAGMA table_info(verification_logs)').all().map(column => column.name));
  if (!logColumns.has('email')) sql.exec("ALTER TABLE verification_logs ADD COLUMN email TEXT NOT NULL DEFAULT ''");
  if (!logColumns.has('price')) sql.exec("ALTER TABLE verification_logs ADD COLUMN price TEXT NOT NULL DEFAULT ''");
}
let adminCode = process.env.VERIFIO_ADMIN_CODE;
if (!adminCode && !isVercel) {
  const codePath = path.join(dataDir, 'admin-code.txt');
  if (!existsSync(codePath)) writeFileSync(codePath, randomBytes(9).toString('hex'), { mode: 0o600 });
  adminCode = readFileSync(codePath, 'utf8').trim();
  console.log(`Code privé du Dashboard (à conserver): ${adminCode}`);
}
const sessionKey = process.env.VERIFIO_SESSION_SECRET || (isVercel ? '' : randomBytes(32).toString('hex'));
const stamp = () => new Date().toISOString();
const makeCode = () => randomBytes(9).toString('base64url').slice(0, 12).toUpperCase();
const seed = () => ({
  links: [], logs: [],
  tickets: Array.from({ length: 100 }, (_, i) => ({ id: randomUUID(), code: makeCode(), expiry: new Date(Date.now() + (i < 20 ? -(1 + (i % 90)) : 180 + (i % 550)) * 86400000).toISOString().slice(0, 10), createdAt: stamp() }))
});
const mapLink = x => ({ id:x.id, token:x.token, createdAt:x.created_at, active:Boolean(x.active), checks:x.checks });
const mapTicket = x => ({ id:x.id, code:x.code, expiry:x.expiry, createdAt:x.created_at });
const mapLog = x => ({ id:x.id, reference:x.reference, linkId:x.link_id, code:x.code, expiry:x.expiry, email:x.email || '', price:x.price || '', result:x.result, checkedAt:x.checked_at });
let db = { links:[], logs:[], tickets:[] };
async function ensurePostgresSchema(client) {
  if (!pgSchemaPromise) {
    pgSchemaPromise = client.query(`CREATE TABLE IF NOT EXISTS verification_links (
      id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE, checks INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS reference_tickets (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, expiry TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS verification_logs (
      id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, link_id TEXT NOT NULL,
      code TEXT NOT NULL, expiry TEXT NOT NULL, result TEXT NOT NULL, checked_at TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '', price TEXT NOT NULL DEFAULT ''
    );
    ALTER TABLE verification_logs ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
    ALTER TABLE verification_logs ADD COLUMN IF NOT EXISTS price TEXT NOT NULL DEFAULT '';
    CREATE INDEX IF NOT EXISTS verification_logs_link_idx ON verification_logs(link_id);
    CREATE INDEX IF NOT EXISTS verification_logs_code_idx ON verification_logs(code);
    CREATE INDEX IF NOT EXISTS verification_logs_checked_idx ON verification_logs(checked_at);
    CREATE TABLE IF NOT EXISTS verifio_store_lock (id INTEGER PRIMARY KEY);
    INSERT INTO verifio_store_lock(id) VALUES (1) ON CONFLICT (id) DO NOTHING;`).catch(error => {
      pgSchemaPromise = null;
      throw error;
    });
  }
  await pgSchemaPromise;
}
async function loadPostgresState(client, { recentLogs = false } = {}) {
  const logsQuery = recentLogs
    ? client.query('SELECT * FROM verification_logs ORDER BY checked_at DESC LIMIT 100')
    : client.query('SELECT * FROM verification_logs ORDER BY checked_at ASC');
  const countsQuery = recentLogs
    ? client.query(`SELECT COUNT(*)::int AS checks,
        COUNT(*) FILTER (WHERE result = 'valid')::int AS valid,
        COUNT(*) FILTER (WHERE result = 'expired')::int AS expired,
        COUNT(*) FILTER (WHERE result IN ('unknown','inactive'))::int AS failed
      FROM verification_logs`)
    : Promise.resolve(null);
  const [links, tickets, logs, summary] = await Promise.all([
    client.query('SELECT * FROM verification_links'),
    client.query('SELECT * FROM reference_tickets'),
    logsQuery,
    countsQuery
  ]);
  const counts = summary?.rows[0] ? Object.fromEntries(Object.entries(summary.rows[0]).map(([key, value]) => [key, Number(value)])) : null;
  db = {
    links: links.rows.map(mapLink),
    tickets: tickets.rows.map(mapTicket),
    logs: (recentLogs ? logs.rows.reverse() : logs.rows).map(mapLog),
    counts
  };
}
async function withPostgresStore(run, { readOnly = false, recentLogs = false } = {}) {
  if (!pgPool) {
    const { Pool } = await import('pg');
    const poolerHost = new URL(databaseUrl).hostname.endsWith('.pooler.supabase.com');
    // Supabase's serverless pooler uses SSL=require; keep this relaxed CA check scoped to Supabase only.
    pgPool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 10000,
      ssl: poolerHost ? { rejectUnauthorized: false } : { rejectUnauthorized: true }
    });
  }
  const client = await pgPool.connect();
  try {
    await ensurePostgresSchema(client);
    if (readOnly) {
      await client.query('BEGIN READ ONLY');
      await loadPostgresState(client, { recentLogs });
      if (db.tickets.length > 0) {
        const result = await run();
        await client.query('COMMIT');
        return result;
      }
      await client.query('ROLLBACK');
    }
    await client.query('BEGIN');
    await client.query('SELECT id FROM verifio_store_lock WHERE id = 1 FOR UPDATE');
    await loadPostgresState(client);
    pgDirty = false;
    if (db.tickets.length === 0) { db = seed(); pgDirty = true; }
    const result = await run();
    if (pgDirty) {
      await client.query('DELETE FROM verification_logs; DELETE FROM verification_links; DELETE FROM reference_tickets;');
      for (const x of db.links) await client.query('INSERT INTO verification_links VALUES ($1,$2,$3,$4,$5)', [x.id,x.token,x.createdAt,x.active,x.checks]);
      for (const x of db.tickets) await client.query('INSERT INTO reference_tickets VALUES ($1,$2,$3,$4)', [x.id,x.code,x.expiry,x.createdAt]);
      for (const x of db.logs) await client.query('INSERT INTO verification_logs (id,reference,link_id,code,expiry,result,checked_at,email,price) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [x.id,x.reference,x.linkId,x.code,x.expiry,x.result,x.checkedAt,x.email || '',x.price || '']);
    }
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
  }
}
let pgQueue = Promise.resolve();
function loadDb() {
  if (!sql) return;
  db.counts=null;
  db.links=sql.prepare('SELECT * FROM verification_links').all().map(mapLink);
  db.logs=sql.prepare('SELECT * FROM verification_logs ORDER BY checked_at ASC').all().map(mapLog);
  db.tickets=sql.prepare('SELECT * FROM reference_tickets').all().map(mapTicket);
}
function persist() {
  if (!sql) { pgDirty = true; return; }
  const tx=sql.prepare('BEGIN IMMEDIATE');tx.run();
  try {
    sql.exec('DELETE FROM verification_logs; DELETE FROM verification_links; DELETE FROM reference_tickets;');
    const li=sql.prepare('INSERT INTO verification_links VALUES (?,?,?,?,?)');
    for(const x of db.links)li.run(x.id,x.token,x.createdAt,x.active?1:0,x.checks);
    const ti=sql.prepare('INSERT INTO reference_tickets VALUES (?,?,?,?)');
    for(const x of db.tickets)ti.run(x.id,x.code,x.expiry,x.createdAt);
    const lo=sql.prepare('INSERT INTO verification_logs (id,reference,link_id,code,expiry,result,checked_at,email,price) VALUES (?,?,?,?,?,?,?,?,?)');
    for(const x of db.logs)lo.run(x.id,x.reference,x.linkId,x.code,x.expiry,x.result,x.checkedAt,x.email || '',x.price || '');
    sql.exec('COMMIT');
  } catch(error) { sql.exec('ROLLBACK'); throw error; }
}
if (sql) loadDb();
if (sql && db.tickets.length===0 && existsSync(legacyPath)) {
  try { const legacy=JSON.parse(readFileSync(legacyPath,'utf8')); db={links:legacy.links||[],logs:legacy.logs||[],tickets:legacy.tickets||[]}; persist(); }
  catch(error) { console.error('Migration du stockage précédent impossible:',error); db={links:[],logs:[],tickets:[]}; }
}
if (sql && db.tickets.length===0) { db=seed(); persist(); }
const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && timingSafeEqual(x, y); };
const sign = value => createHmac('sha256', sessionKey).update(value).digest('hex');
function isAdmin(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|; )verifio_session=([^;]+)/);
  if (!match) return false;
  const [value, mac] = decodeURIComponent(match[1]).split('.');
  return value && mac && Number(value) > Date.now() && safeEq(sign(value), mac);
}
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
async function body(req) { let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 10000) throw new Error('Requête trop volumineuse'); } return JSON.parse(raw || '{}'); }
function publicLink(req, link) { return `${process.env.PUBLIC_URL || `http://${req.headers.host}`}/v/${link.token}`; }
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.png': 'image/png' };
async function routeRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = url.pathname;
  try {
    if (req.method === 'POST' && route === '/api/unlock') {
      const { code } = await body(req);
      if (!safeEq(code || '', adminCode)) return json(res, 401, { error: 'Code incorrect.' });
      const expiry = Date.now() + 7 * 86400000;
      res.setHeader('Set-Cookie', `verifio_session=${expiry}.${sign(String(expiry))}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && route === '/api/lock') { res.setHeader('Set-Cookie', 'verifio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true }); }
    if (route.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'Accès au Dashboard verrouillé.' });
      if (req.method === 'GET' && route === '/api/admin/history') return json(res, 200, { logs: db.logs.slice().reverse() });
      if (req.method === 'GET' && route === '/api/admin/data') {
        const counts = { links: db.links.length, checks: db.counts?.checks ?? db.logs.length, valid: db.counts?.valid ?? db.logs.filter(x => x.result === 'valid').length, expired: db.counts?.expired ?? db.logs.filter(x => x.result === 'expired').length, failed: db.counts?.failed ?? db.logs.filter(x => x.result === 'unknown' || x.result === 'inactive').length };
        return json(res, 200, { counts, links: db.links.map(({ token, ...x }) => ({ ...x, url: publicLink(req, { ...x, token }) })), logs: db.logs.slice(-100).reverse(), tickets: db.tickets });
      }
      if (req.method === 'POST' && route === '/api/admin/links') {
        const link = { id: randomUUID(), token: randomBytes(24).toString('base64url'), createdAt: stamp(), active: true, checks: 0 };
        db.links.push(link); persist(); return json(res, 201, { ...link, url: publicLink(req, link) });
      }
      const linkAction = route.match(/^\/api\/admin\/links\/([\w-]+)(?:\/(toggle|history))?$/);
      if (linkAction) {
        const link = db.links.find(x => x.id === linkAction[1]);
        if (!link) return json(res, 404, { error: 'Lien introuvable.' });
        if (req.method === 'GET' && linkAction[2] === 'history') return json(res, 200, { logs: db.logs.filter(x => x.linkId === link.id).reverse() });
        if (req.method === 'POST' && linkAction[2] === 'toggle') { link.active = !link.active; persist(); return json(res, 200, { active: link.active }); }
        if (req.method === 'DELETE' && !linkAction[2]) { db.links = db.links.filter(x => x.id !== link.id); persist(); return json(res, 200, { ok: true }); }
      }
      return json(res, 404, { error: 'Route inconnue.' });
    }
    const verifyRoute = route.match(/^\/api\/verify\/([\w-]+)(?:\.([\w-]+))?$/);
    if (req.method === 'POST' && verifyRoute) {
      const link = verifyRoute[2]
        ? db.links.find(x => x.id === verifyRoute[1] && safeEq(x.token, verifyRoute[2]))
        : db.links.find(x => safeEq(x.token, verifyRoute[1]));
      if (!link) return json(res, 404, { error: 'Lien de vérification introuvable.' });
      const { code = '', email = '', price = '' } = await body(req);
      const normalizedCode = String(code).trim();
      const normalizedEmail = String(email).trim().toLowerCase();
      const normalizedPrice = String(price).trim().replace(',', '.');
      if (!/^.{1,100}$/.test(normalizedCode) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || !/^\d{1,9}(?:\.\d{1,2})?$/.test(normalizedPrice) || Number(normalizedPrice) <= 0) return json(res, 400, { error: 'Saisissez une adresse e-mail, un prix positif et un code de ticket valides.' });
      const ticket = db.tickets.find(x => safeEq(x.code, normalizedCode.toUpperCase()));
      let result = 'unknown';
      if (!link.active) result = 'inactive';
      else if (ticket) result = ticket.expiry < new Date().toISOString().slice(0, 10) ? 'expired' : 'valid';
      const log = { id: randomUUID(), reference: `VR-${randomBytes(5).toString('hex').toUpperCase()}`, linkId: link.id, code: normalizedCode, expiry: ticket?.expiry || '', email: normalizedEmail, price: normalizedPrice, result, checkedAt: stamp() };
      db.logs.push(log); link.checks += 1; persist();
      return json(res, 200, { accepted: true, reference: log.reference, checkedAt: log.checkedAt });
    }
    const file = route.startsWith('/verify/') || route.startsWith('/v/') ? 'index.html' : route === '/' ? 'index.html' : route.slice(1);
    const target = path.resolve(root, 'public', file);
    if (!target.startsWith(path.resolve(root, 'public') + path.sep) && target !== path.resolve(root, 'public', 'index.html')) return json(res, 404, { error: 'Introuvable.' });
    if (!existsSync(target)) return json(res, 404, { error: 'Introuvable.' });
    res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(readFileSync(target));
  } catch (error) { console.error(error); json(res, 500, { error: 'Une erreur est survenue.' }); }
}

export async function handleRequest(req, res) {
  const route = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const authRoute = route === '/api/unlock' || route === '/api/lock';
  if (isVercel && route.startsWith('/api/') && (!adminCode || !sessionKey)) {
    return json(res, 503, { error: 'Configuration requise : définissez VERIFIO_ADMIN_CODE et VERIFIO_SESSION_SECRET dans Vercel.' });
  }
  if (isVercel && route.startsWith('/api/') && !authRoute && !databaseUrl) {
    return json(res, 503, { error: 'Configuration requise : connectez une base PostgreSQL persistante dans Vercel.' });
  }
  if (databaseUrl && route.startsWith('/api/') && !authRoute) {
    let release;
    const previous = pgQueue;
    pgQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await withPostgresStore(() => routeRequest(req, res), { readOnly: req.method === 'GET', recentLogs: req.method === 'GET' && route === '/api/admin/data' }); }
    catch (error) { console.error(error); if (!res.headersSent) return json(res, 503, { error: 'Base de données indisponible. Vérifiez la configuration PostgreSQL de Vercel.' }); }
    finally { release(); }
  }
  return routeRequest(req, res);
}

const server = http.createServer(handleRequest);
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || 'localhost';
server.on('error', error => {
  console.error(`Impossible de démarrer Verifio sur ${host}:${port}: ${error.message}`);
  process.exitCode = 1;
});
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  server.listen(port, host, () => console.log(`Verifio prêt sur http://localhost:${port}`));
}

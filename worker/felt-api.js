// Cutremur Acum: "Am simțit" reports API. Cloudflare Worker + D1 (binding name: DB)
// Stores only: earthquake id, intensity (0-4), chosen city, time, and salted hashes of device and IP.
const ORIGINS = ["https://cutremur-acum.ro", "https://www.cutremur-acum.ro", "https://raresrosca27.github.io"];
const SALT = "bb50670a55f4719eadd26639d6e52336";
const CITIES = new Set(["București","Cluj-Napoca","Iași","Timișoara","Constanța","Brașov","Craiova","Focșani","Chișinău","Galați","Brăila","Ploiești","Oradea","Sibiu","Bacău","Arad","Pitești","Buzău","Suceava","Baia Mare","Târgu Mureș","Târgu Jiu","Drobeta-Turnu Severin","Satu Mare","Botoșani","Tulcea","Deva","Râmnicu Vâlcea","Piatra Neamț","Nehoiu"]);
const PER_IP_EVENT = 60, PER_IP_DAY = 400;
let ready = false;

async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS felt(ev TEXT NOT NULL, who TEXT NOT NULL, ipk TEXT NOT NULL, lv INTEGER NOT NULL, city TEXT NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY(ev, who))"),
    db.prepare("CREATE INDEX IF NOT EXISTS felt_ip ON felt(ipk, ts)"),
  ]);
  ready = true;
}
async function hash(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SALT + s));
  return [...new Uint8Array(b)].slice(0, 12).map(x => x.toString(16).padStart(2, "0")).join("");
}
function cors(req) {
  const o = req.headers.get("Origin") || "";
  return { "Access-Control-Allow-Origin": ORIGINS.includes(o) ? o : ORIGINS[0], "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Vary": "Origin" };
}
const json = (req, data, status = 200, cache = 0) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors(req), "Content-Type": "application/json", "Cache-Control": cache ? `public, max-age=${cache}` : "no-store" } });
const okId = s => typeof s === "string" && /^[\w.:-]{1,64}$/.test(s);

async function counts(db, ids) {
  const out = {};
  if (!ids.length) return out;
  const { results } = await db.prepare(`SELECT ev, lv, COUNT(*) AS n FROM felt WHERE ev IN (${ids.map(() => "?").join(",")}) GROUP BY ev, lv`).bind(...ids).all();
  for (const r of results) { const e = out[r.ev] || (out[r.ev] = { n: 0, lv: [0, 0, 0, 0, 0] }); e.lv[r.lv] = r.n; e.n += r.n; }
  return out;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url), db = env.DB;
    if (!db) return json(req, { error: "D1 binding DB missing" }, 500);
    await init(db);
    try {
      if (url.pathname === "/felt" && req.method === "GET") {
        const ids = (url.searchParams.get("ids") || "").split(",").filter(okId).slice(0, 80);
        return json(req, await counts(db, ids), 200, 15);
      }
      if (url.pathname === "/felt/cities" && req.method === "GET") {
        const ev = url.searchParams.get("ev");
        if (!okId(ev)) return json(req, { error: "bad id" }, 400);
        const { results } = await db.prepare("SELECT city, COUNT(*) AS n, AVG(lv) AS avg FROM felt WHERE ev = ? GROUP BY city ORDER BY n DESC").bind(ev).all();
        return json(req, results.map(r => ({ city: r.city, n: r.n, avg: Math.round(r.avg * 100) / 100 })), 200, 15);
      }
      if (url.pathname === "/felt" && req.method === "POST") {
        let b; try { b = await req.json(); } catch { return json(req, { error: "bad json" }, 400); }
        const lv = Number(b.lv);
        if (!okId(b.ev) || !Number.isInteger(lv) || lv < 0 || lv > 4 || !CITIES.has(b.city) || typeof b.cid !== "string" || !/^[a-z0-9]{16,40}$/.test(b.cid))
          return json(req, { error: "invalid" }, 400);
        const ip = req.headers.get("CF-Connecting-IP") || "0", now = Math.floor(Date.now() / 1000);
        const who = await hash("d:" + b.cid), ipk = await hash("i:" + ip);
        const lim = await db.prepare("SELECT (SELECT COUNT(*) FROM felt WHERE ev = ? AND ipk = ?) AS e, (SELECT COUNT(*) FROM felt WHERE ipk = ? AND ts > ?) AS d").bind(b.ev, ipk, ipk, now - 86400).first();
        const mine = await db.prepare("SELECT 1 FROM felt WHERE ev = ? AND who = ?").bind(b.ev, who).first();
        if (!mine && (lim.e >= PER_IP_EVENT || lim.d >= PER_IP_DAY)) return json(req, { error: "limit" }, 429);
        await db.prepare("INSERT INTO felt(ev, who, ipk, lv, city, ts) VALUES(?,?,?,?,?,?) ON CONFLICT(ev, who) DO UPDATE SET lv = excluded.lv, city = excluded.city, ts = excluded.ts").bind(b.ev, who, ipk, lv, b.city, now).run();
        return json(req, (await counts(db, [b.ev]))[b.ev] || { n: 0, lv: [0, 0, 0, 0, 0] });
      }
      if (url.pathname === "/") return json(req, { ok: true, service: "cutremur-acum felt API" });
      return json(req, { error: "not found" }, 404);
    } catch (e) {
      return json(req, { error: "server" }, 500);
    }
  },
};

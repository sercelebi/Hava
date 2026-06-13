// fetch.js (v2) — WU verisini çeker; data/data.json içinde HEM ham (son ~45 gün)
// HEM de her günün kalıcı özetini tutar. Böylece haftalık/aylık/yıllık çıkar.
// Gerekli ortam değişkenleri: WU_API_KEY, WU_STATION_ID

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.WU_API_KEY;
const STATION = process.env.WU_STATION_ID;
const DATA_PATH = path.join(__dirname, "data", "data.json");

const TZ_OFFSET_MS = 3 * 3600 * 1000;   // Türkiye yerel saat (UTC+3) — gün sınırları için
const RAW_MAX_DAYS = 45;                 // ham (15 dk) veriyi kaç gün sakla
const MAX_RAW = 6000;                    // ham kayıt üst sınırı
const SEED_RAW_DAYS = 7;                 // ilk kurulumda kaç gün ham doldurulsun
const SEED_DAILY_DAYS = 30;              // ilk kurulumda kaç günlük özet çekilsin
const DAY = 86400000;

if (!API_KEY || !STATION) { console.error("HATA: WU_API_KEY ve WU_STATION_ID gerekli."); process.exit(1); }

const BASE = "https://api.weather.com/v2/pws";
const num = (v) => (v === undefined || v === null || Number.isNaN(+v) ? null : +v);
const r1  = (v) => (v == null ? null : Math.round(v * 10) / 10);

async function getJSON(url) {
  const res = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fromCurrent(o) {
  const m = o.metric || {};
  return { t: o.epoch ? o.epoch * 1000 : Date.parse(o.obsTimeUtc),
    temp: num(m.temp), hum: num(o.humidity), bar: num(m.pressure), wind: num(m.windSpeed),
    gust: num(m.windGust), dir: num(o.winddir), rain: num(m.precipTotal),
    dew: num(m.dewpt), uv: num(o.uv), solar: num(o.solarRadiation) };
}
function fromHistory(o) {
  const m = o.metric || {};
  let bar = num(m.pressureMax);
  if (m.pressureMax != null && m.pressureMin != null) bar = (+m.pressureMax + +m.pressureMin) / 2;
  if (bar == null) bar = num(m.pressureTrend);
  return { t: o.epoch ? o.epoch * 1000 : Date.parse(o.obsTimeUtc),
    temp: num(m.tempAvg ?? m.tempHigh), hum: num(o.humidityAvg ?? o.humidity), bar,
    wind: num(m.windspeedAvg), gust: num(m.windgustHigh), dir: num(o.winddirAvg),
    rain: num(m.precipTotal), dew: num(m.dewptAvg), uv: num(o.uvHigh), solar: num(o.solarRadiationHigh) };
}
// WU /history/daily -> kalıcı günlük özet
function fromDailyObs(o) {
  const m = o.metric || {};
  const t = o.epoch ? o.epoch * 1000 : Date.parse(o.obsTimeUtc);
  let barAvg = null;
  if (m.pressureMax != null && m.pressureMin != null) barAvg = (+m.pressureMax + +m.pressureMin) / 2;
  return { d: dayKey(t), t: dayStart(t), n: 0,
    tempAvg: num(m.tempAvg), tempMin: num(m.tempLow), tempMax: num(m.tempHigh),
    humAvg: num(o.humidityAvg), barAvg: r1(barAvg), barMin: num(m.pressureMin), barMax: num(m.pressureMax),
    windAvg: num(m.windspeedAvg), gustMax: num(m.windgustHigh), rain: num(m.precipTotal),
    uvMax: num(o.uvHigh), solarAvg: num(o.solarRadiationHigh), dewAvg: num(m.dewptAvg) };
}

function dayKey(t) { const d = new Date(t + TZ_OFFSET_MS); const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`; }
function dayStart(t) { return Math.floor((t + TZ_OFFSET_MS) / DAY) * DAY - TZ_OFFSET_MS; }
function ymd(d) { const p = (n) => String(n).padStart(2, "0"); return `${d.getUTCFullYear()}${p(d.getUTCMonth()+1)}${p(d.getUTCDate())}`; }

// Bir günün ham kayıtlarından özet üret
function aggDay(recs) {
  const pick = (f) => recs.map((r) => r[f]).filter((v) => v != null && !isNaN(v));
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
  const mn = (a) => (a.length ? Math.min(...a) : null);
  const mx = (a) => (a.length ? Math.max(...a) : null);
  const temp = pick("temp"), bar = pick("bar");
  return { n: recs.length,
    tempAvg: r1(avg(temp)), tempMin: r1(mn(temp)), tempMax: r1(mx(temp)),
    humAvg: r1(avg(pick("hum"))), barAvg: r1(avg(bar)), barMin: r1(mn(bar)), barMax: r1(mx(bar)),
    windAvg: r1(avg(pick("wind"))), gustMax: r1(mx(pick("gust"))), rain: r1(mx(pick("rain"))),
    uvMax: r1(mx(pick("uv"))), solarAvg: r1(avg(pick("solar"))), dewAvg: r1(avg(pick("dew"))) };
}

async function main() {
  let store = { station: STATION, updated: 0, records: [], days: [] };
  if (fs.existsSync(DATA_PATH)) {
    try { store = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")); } catch (_) {}
  }
  if (!Array.isArray(store.records)) store.records = [];
  if (!Array.isArray(store.days)) store.days = [];

  // İlk kurulum: ham 7 gün
  if (store.records.length === 0) {
    console.log(`Ham geçmiş dolduruluyor (${SEED_RAW_DAYS} gün)...`);
    for (let i = SEED_RAW_DAYS; i >= 1; i--) {
      const d = new Date(Date.now() - i * DAY);
      try { const j = await getJSON(`${BASE}/history/hourly?stationId=${STATION}&format=json&units=m&date=${ymd(d)}&apiKey=${API_KEY}`);
        for (const o of j.observations || []) store.records.push(fromHistory(o));
      } catch (e) { console.warn("ham gün atlandı", ymd(d), e.message); }
    }
  }
  // İlk kurulum: günlük özet 30 gün
  if (store.days.length === 0) {
    console.log(`Günlük özet geçmişi dolduruluyor (${SEED_DAILY_DAYS} gün)...`);
    const map = {};
    for (let i = SEED_DAILY_DAYS; i >= 1; i--) {
      const d = new Date(Date.now() - i * DAY);
      try { const j = await getJSON(`${BASE}/history/daily?stationId=${STATION}&format=json&units=m&date=${ymd(d)}&apiKey=${API_KEY}`);
        for (const o of j.observations || []) { const e = fromDailyObs(o); map[e.d] = e; }
      } catch (e) { console.warn("özet gün atlandı", ymd(d), e.message); }
    }
    store.days = Object.values(map);
  }

  // Anlık gözlem
  try { const j = await getJSON(`${BASE}/observations/current?stationId=${STATION}&format=json&units=m&apiKey=${API_KEY}`);
    if (j.observations && j.observations[0]) store.records.push(fromCurrent(j.observations[0]));
  } catch (e) { console.error("anlık veri alınamadı:", e.message); }

  // Ham temizle: geçerli zaman, dakikaya göre tekille, sırala, kırp
  const seen = new Set();
  store.records = store.records
    .filter((r) => r && Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t)
    .filter((r) => { const k = Math.round(r.t / 60000); if (seen.has(k)) return false; seen.add(k); return true; });
  const cutoff = Date.now() - RAW_MAX_DAYS * DAY;
  store.records = store.records.filter((r) => r.t >= cutoff).slice(-MAX_RAW);

  // Ham'daki her günü yeniden özetle ve günlük listeye işle (eskileri korur)
  const dmap = {}; for (const e of store.days) if (e && e.d) dmap[e.d] = e;
  const byDay = {};
  for (const r of store.records) { const k = dayKey(r.t); (byDay[k] ||= []).push(r); }
  for (const k of Object.keys(byDay)) {
    const a = aggDay(byDay[k]); a.d = k; a.t = dayStart(byDay[k][0].t); dmap[k] = a;
  }
  store.days = Object.values(dmap).filter((e) => e && e.d).sort((a, b) => a.t - b.t);

  store.updated = Date.now(); store.station = STATION;
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store));
  console.log(`Tamam. Ham kayıt: ${store.records.length} | Günlük özet: ${store.days.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

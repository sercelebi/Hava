// fetch.js — Weather Underground (PWS) verisini çekip data/data.json'a ekler.
// Çalışması için 2 ortam değişkeni gerekir: WU_API_KEY ve WU_STATION_ID
// (GitHub Actions'ta "Secrets" olarak tanımlanır — kod içine yazılmaz.)

const fs = require("fs");
const path = require("path");

const API_KEY = process.env.WU_API_KEY;
const STATION = process.env.WU_STATION_ID;
const DATA_PATH = path.join(__dirname, "data", "data.json");
const MAX_RECORDS = 8000;        // ~3 ay (15 dk aralık). Eski kayıtlar atılır.
const SEED_DAYS = 7;             // ilk çalışmada geçmiş kaç gün doldurulsun

if (!API_KEY || !STATION) {
  console.error("HATA: WU_API_KEY ve WU_STATION_ID tanımlı değil.");
  process.exit(1);
}

const BASE = "https://api.weather.com/v2/pws";
const num = (v) => (v === undefined || v === null || Number.isNaN(+v) ? null : +v);

async function getJSON(url) {
  const res = await fetch(url, { headers: { "Accept-Encoding": "gzip" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url.replace(API_KEY, "***")}`);
  return res.json();
}

// Anlık gözlem -> ortak kayıt formatı
function fromCurrent(o) {
  const m = o.metric || {};
  return {
    t: o.epoch ? o.epoch * 1000 : Date.parse(o.obsTimeUtc),
    temp: num(m.temp), hum: num(o.humidity), bar: num(m.pressure),
    wind: num(m.windSpeed), gust: num(m.windGust), dir: num(o.winddir),
    rain: num(m.precipTotal), dew: num(m.dewpt),
    uv: num(o.uv), solar: num(o.solarRadiation),
  };
}

// Saatlik geçmiş gözlem -> ortak kayıt formatı (alan adları "Avg/High" ekli gelir)
function fromHistory(o) {
  const m = o.metric || {};
  let bar = num(m.pressureMax);
  if (m.pressureMax != null && m.pressureMin != null) bar = (+m.pressureMax + +m.pressureMin) / 2;
  if (bar == null) bar = num(m.pressureTrend);
  return {
    t: o.epoch ? o.epoch * 1000 : Date.parse(o.obsTimeUtc),
    temp: num(m.tempAvg ?? m.tempHigh), hum: num(o.humidityAvg ?? o.humidity),
    bar, wind: num(m.windspeedAvg), gust: num(m.windgustHigh),
    dir: num(o.winddirAvg), rain: num(m.precipTotal),
    dew: num(m.dewptAvg), uv: num(o.uvHigh), solar: num(o.solarRadiationHigh),
  };
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

async function main() {
  let store = { station: STATION, updated: 0, records: [] };
  if (fs.existsSync(DATA_PATH)) {
    try { store = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")); } catch (_) {}
    if (!Array.isArray(store.records)) store.records = [];
  }

  // Kayıt yoksa geçmişi doldur (ilk çalışma)
  if (store.records.length === 0) {
    console.log(`İlk çalışma: son ${SEED_DAYS} gün dolduruluyor...`);
    for (let i = SEED_DAYS; i >= 1; i--) {
      const d = new Date(Date.now() - i * 86400000);
      try {
        const url = `${BASE}/history/hourly?stationId=${STATION}&format=json&units=m&date=${ymd(d)}&apiKey=${API_KEY}`;
        const j = await getJSON(url);
        for (const o of j.observations || []) store.records.push(fromHistory(o));
      } catch (e) { console.warn("Geçmiş gün atlandı:", ymd(d), e.message); }
    }
  }

  // Anlık gözlem
  try {
    const url = `${BASE}/observations/current?stationId=${STATION}&format=json&units=m&apiKey=${API_KEY}`;
    const j = await getJSON(url);
    if (j.observations && j.observations[0]) store.records.push(fromCurrent(j.observations[0]));
  } catch (e) { console.error("Anlık veri alınamadı:", e.message); }

  // Temizle: geçersiz zaman, tekrar eden epoch, sırala, kırp
  const seen = new Set();
  store.records = store.records
    .filter((r) => r && Number.isFinite(r.t))
    .sort((a, b) => a.t - b.t)
    .filter((r) => { const k = Math.round(r.t / 60000); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(-MAX_RECORDS);

  store.updated = Date.now();
  store.station = STATION;
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(store));
  console.log(`Tamam. Toplam kayıt: ${store.records.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });

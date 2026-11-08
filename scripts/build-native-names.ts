// Builds data/native-names.json: each city's name in its own language and script
// ("東京", "Москва", "القاهرة", "Genève"), for the map's "native names" label option.
//
//   npx tsx scripts/build-native-names.ts [path/to/cities15000.txt]
//
// 1. Match every city in the app to a GeoNames place (cities15000.txt from
//    download.geonames.org, CC BY 4.0): same name within 30 km, else the largest place
//    within 8 km. Downloaded if no path is given.
// 2. Ask Wikidata, by GeoNames ID (P1566), for the native label (P1705) and the label in
//    each official language of the city's country (P17 → P37 → P424). Wikidata is CC0.
// 3. Pick the native label in an official language, else the official-language label when
//    the languages that have one agree (local ones before English), else an agreed native
//    label. Then trim administrative suffixes (東京都 → 東京) and Hebrew/Arabic vowel marks.
// 4. Keep it only if MapLibre can draw it: Latin, Greek, Cyrillic, Armenian, Georgian,
//    Hebrew, Arabic, Ethiopic, CJK, kana and Hangul. Thai, Indic, Myanmar, Khmer and Lao
//    need shaping MapLibre doesn't do, so those cities keep their English name.
//    Then drop names identical to the English one.

import { existsSync, readFileSync, writeFileSync, mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { loadCities, getCities } from "../server/lib/cities.ts";

const UA = "meridian-native-names/1.0 (https://github.com/kygura/meridian)";

async function geonamesFile(): Promise<string> {
  const given = process.argv[2];
  if (given && existsSync(given)) return given;
  const dir = mkdtempSync(join(tmpdir(), "geonames-"));
  const zip = join(dir, "cities15000.zip");
  const res = await fetch("https://download.geonames.org/export/dump/cities15000.zip", { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`GeoNames download failed: ${res.status}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-o", "-q", zip, "-d", dir]);
  return join(dir, "cities15000.txt");
}

const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

interface Geo {
  id: string;
  names: Set<string>;
  lat: number;
  lng: number;
  pop: number;
}

function km(a: number, b: number, c: number, d: number): number {
  const r = Math.PI / 180;
  const x = Math.sin(((c - a) * r) / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(((d - b) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

/** City id → GeoNames id. */
function matchGeonames(file: string): Map<string, string> {
  const grid = new Map<string, Geo[]>();
  const key = (lat: number, lng: number) => `${Math.floor(lat)}:${Math.floor(lng)}`;
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const f = line.split("\t");
    const g: Geo = {
      id: f[0],
      names: new Set([f[1], f[2], ...f[3].split(",")].filter(Boolean).map(fold)),
      lat: +f[4],
      lng: +f[5],
      pop: +f[14],
    };
    const k = key(g.lat, g.lng);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(g);
  }
  const out = new Map<string, string>();
  for (const c of getCities()) {
    const near: [Geo, number][] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const g of grid.get(key(c.lat + dy, c.lng + dx)) ?? []) {
          const d = km(c.lat, c.lng, g.lat, g.lng);
          if (d < 30) near.push([g, d]);
        }
    const name = fold(c.name);
    const byName = near.filter(([g]) => g.names.has(name)).sort((a, b) => b[0].pop - a[0].pop || a[1] - b[1])[0];
    const close = near.filter(([, d]) => d < 8).sort((a, b) => b[0].pop - a[0].pop)[0];
    const hit = byName ?? close;
    if (hit) out.set(c.id, hit[0].id);
  }
  return out;
}

interface Labels {
  native: { text: string; lang: string }[];
  official: { text: string; lang: string }[];
  officialLangs: Set<string>;
}

async function sparql(query: string): Promise<Array<Record<string, { value: string; "xml:lang"?: string }>>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://query.wikidata.org/sparql", {
      method: "POST",
      headers: { "user-agent": UA, accept: "application/sparql-results+json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ query }),
    });
    if (res.ok) return ((await res.json()) as { results: { bindings: [] } }).results.bindings;
    await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
  }
  throw new Error("Wikidata query kept failing");
}

/** GeoNames id → labels, in batches. */
async function wikidataLabels(ids: string[]): Promise<Map<string, Labels>> {
  const out = new Map<string, Labels>();
  const get = (gn: string) => {
    if (!out.has(gn)) out.set(gn, { native: [], official: [], officialLangs: new Set() });
    return out.get(gn)!;
  };
  const BATCH = 200;
  for (let i = 0; i < ids.length; i += BATCH) {
    const values = ids.slice(i, i + BATCH).map((id) => `"${id}"`).join(" ");
    const rows = await sparql(`
      SELECT ?gn ?native ?code ?label WHERE {
        VALUES ?gn { ${values} }
        ?item wdt:P1566 ?gn .
        { ?item wdt:P1705 ?native . }
        UNION
        { ?item wdt:P17 ?country . ?country wdt:P37 ?lang . ?lang wdt:P424 ?code .
          OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = ?code || LANG(?label) = STRBEFORE(?code, "-")) } }
      }`);
    for (const r of rows) {
      const l = get(r.gn.value);
      if (r.native) l.native.push({ text: r.native.value, lang: r.native["xml:lang"] ?? "" });
      if (r.code) l.officialLangs.add(r.code.value);
      if (r.label) l.official.push({ text: r.label.value, lang: r.code!.value });
    }
    process.stdout.write(`\rwikidata ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  process.stdout.write("\n");
  return out;
}

/**
 * Second pass for cities the GeoNames link left without a name (some GeoNames ids point at a
 * bare "populated place" item instead of the city): find items by English label, keep the one
 * nearest the city (within 30 km), and read the same labels.
 */
async function labelsByName(cities: { id: string; name: string; lat: number; lng: number }[]): Promise<Map<string, Labels>> {
  const out = new Map<string, Labels>();
  const BATCH = 120;
  for (let i = 0; i < cities.length; i += BATCH) {
    const batch = cities.slice(i, i + BATCH);
    const values = [...new Set(batch.map((c) => JSON.stringify(c.name) + "@en"))].join(" ");
    const rows = await sparql(`
      SELECT ?en ?item ?coord ?native ?code ?label WHERE {
        VALUES ?en { ${values} }
        ?item rdfs:label ?en ; wdt:P625 ?coord .
        { ?item wdt:P1705 ?native . }
        UNION
        { ?item wdt:P17 ?country . ?country wdt:P37 ?lang . ?lang wdt:P424 ?code .
          OPTIONAL { ?item rdfs:label ?label . FILTER(LANG(?label) = ?code || LANG(?label) = STRBEFORE(?code, "-")) } }
      }`);
    const items = new Map<string, { en: string; lat: number; lng: number; l: Labels }>();
    for (const r of rows) {
      const m = /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(r.coord.value);
      if (!m) continue;
      const id = r.item.value;
      if (!items.has(id)) items.set(id, { en: r.en.value, lng: +m[1], lat: +m[2], l: { native: [], official: [], officialLangs: new Set() } });
      const it = items.get(id)!;
      if (r.native) it.l.native.push({ text: r.native.value, lang: r.native["xml:lang"] ?? "" });
      if (r.code) it.l.officialLangs.add(r.code.value);
      if (r.label) it.l.official.push({ text: r.label.value, lang: r.code!.value });
    }
    for (const c of batch) {
      const best = [...items.values()]
        .filter((it) => it.en === c.name)
        .map((it) => ({ it, d: km(c.lat, c.lng, it.lat, it.lng) }))
        .filter((x) => x.d < 30)
        .sort((a, b) => a.d - b.d)[0];
      if (best) out.set(c.id, best.it.l);
    }
    process.stdout.write(`\rwikidata by name ${Math.min(i + BATCH, cities.length)}/${cities.length}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  process.stdout.write("\n");
  return out;
}

/** Scripts MapLibre can lay out (plus its RTL plugin for Arabic and Hebrew). */
const DRAWABLE =
  /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Ethiopic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Common}\p{Script=Inherited}‌‍]+$/u;

/** Wikidata language codes for the same written language. */
const SAME_LANG: Record<string, string> = { cmn: "zh", yue: "zh", nb: "no", nn: "no" };
const base = (lang: string) => SAME_LANG[lang.toLowerCase()] ?? lang.toLowerCase().split("-")[0];

const HAN = /\p{Script=Han}/u;
const LATIN_ONLY = /^[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]+$/u;

function preferredScript<T extends { text: string }>(labels: T[]): T[] {
  const han = labels.filter((n) => HAN.test(n.text));
  if (han.length) return han;
  const nonLatin = labels.filter((n) => !LATIN_ONLY.test(n.text));
  return nonLatin.length ? nonLatin : labels;
}

function pick(l: Labels): string | null {
  const drawable = (s: string) => DRAWABLE.test(s);
  const official = new Set([...l.officialLangs].map(base));
  // 1. A native label in an official language ("Milano", not the Lombard "Milan"). When the
  //    official languages give different ones (Helsinki/Helsingfors, Lefkoşa/Λευκωσία),
  //    don't pick a side: keep the English name.
  // Within one language, prefer the usual script: kanji over a kana reading, anything over a
  // Latin transliteration (Tokyo lists 東京都, とうきょうと and Tōkyō-to, all tagged "ja").
  // Compared after cleanup, so 東京都 and 東京 count as the same name.
  const inOfficial = preferredScript(l.native.filter((n) => official.has(base(n.lang)) && drawable(n.text)));
  const nativeOfficial = [...new Set(inOfficial.map((n) => mapName(n.text)))];
  if (nativeOfficial.length > 1) return null;
  if (nativeOfficial.length === 1) return nativeOfficial[0];
  // 2. The official-language label, when the official languages that have one agree. English
  //    only counts when it's the sole official language with a label (so Hong Kong gets 香港).
  const labelled = l.official.filter((o) => drawable(o.text));
  const local = labelled.filter((o) => base(o.lang) !== "en");
  const texts = [...new Set((local.length ? local : labelled).map((o) => mapName(o.text)))];
  if (texts.length === 1) return texts[0];
  // 3. Any native label, when they all agree.
  const nat = [...new Set(l.native.filter((n) => drawable(n.text)).map((n) => mapName(n.text)))];
  return nat.length === 1 ? nat[0] : null;
}

/**
 * Map-style names: drop administrative suffixes and prefixes (東京都 → 東京, いわき市 → いわき,
 * 서울특별시 → 서울, مدينة الجيزة → الجيزة, Thành phố Hồ Chí Minh → Hồ Chí Minh; 京都 stays), and
 * the vowel points and harakat MapLibre can't position (everyday signage omits them).
 */
export function mapName(name: string): string {
  let n = name
    .replace(/[\u0591-\u05c7\u064b-\u065f\u0670]/g, "")
    .replace(/^Thành phố /u, "")
    .replace(/^(مدينة|محافظة) /u, "");
  if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{3,}$/u.test(n)) n = n.replace(/[市都府県縣]$/u, "");
  if (/^[\p{Script=Hangul}]+$/u.test(n)) {
    const stripped = n.replace(/(특별자치시|특별시|광역시|직할시|시)$/u, "");
    if (stripped.length >= 2) n = stripped;
  }
  return n;
}

async function main() {
  loadCities();
  const file = await geonamesFile();
  const geo = matchGeonames(file);
  console.log(`matched ${geo.size}/${getCities().length} cities to GeoNames`);
  const labels = await wikidataLabels([...new Set(geo.values())]);
  const out: Record<string, string> = {};
  const unresolved: ReturnType<typeof getCities> = [];
  const resolve = (c: (typeof unresolved)[number], l: Labels | undefined) => {
    const picked = l ? pick(l) : null;
    const name = picked ? mapName(picked) : null;
    if (name && name !== c.name) out[c.id] = name;
    return picked !== null;
  };
  for (const c of getCities()) {
    const gn = geo.get(c.id);
    if (!resolve(c, gn ? labels.get(gn) : undefined)) unresolved.push(c);
  }
  console.log(`by GeoNames id: ${Object.keys(out).length}; looking up ${unresolved.length} by name`);
  const byName = await labelsByName(unresolved);
  for (const c of unresolved) resolve(c, byName.get(c.id));
  const sorted = Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(
    join(process.cwd(), "data/native-names.json"),
    JSON.stringify({ version: 1, source: "Wikidata (CC0) via GeoNames ids (CC BY 4.0)", names: sorted }, null, 1) + "\n"
  );
  console.log(`native names: ${Object.keys(sorted).length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

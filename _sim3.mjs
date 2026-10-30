const _el={addEventListener(){},classList:{add(){},remove(){}},dataset:{},style:{},appendChild(){},innerHTML:"",textContent:""};
global.document={querySelectorAll:()=>[],querySelector:()=>_el,getElementById:()=>_el,createElement:()=>_el,addEventListener(){},body:_el};
global.window={addEventListener(){}};
global.location={hash:""};
/* farm-media-site — 3-view browser over the TrueSight DAO media archive.
 * No backend, no build step. Data: public manifests + public S3.
 */

const MANIFEST_BASE = "https://raw.githubusercontent.com/TrueSightDAO/farm_media_manifests/main/";
const S3 = "https://s3.amazonaws.com/media.agroverse.shop";
const ytThumb = (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`;

const PREVIEWS_INDEX = `${S3}/previews.json`;
const PREVIEW_STEMS = new Map(); // ns -> Set(stem) of previews that actually exist
const RAW_FILES = new Map(); // ns -> { filename: ext } straight from S3
const PROVENANCE = new Map(); // ns -> Set(zip basenames) the manifest says it came from

const TYPE_ORDER = ["farm", "facility", "event", "partner", "program", "unsorted"];
const ITEMS = [];
const FILTER = { types: new Set(), nss: new Set(), q: "" };
let VIEW = "map";

/* ---------- helpers ---------- */

const titleize = (s) =>
  String(s || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

function entityType(ns) {
  if (ns.startsWith("facility-")) return "facility";
  if (ns.startsWith("event-") || ns.startsWith("medicilandia")) return "event";
  if (ns.startsWith("crf-")) return "program";
  if (ns === "founderhaus") return "partner";
  if (ns === "sorting" || ns.startsWith("to-analyze")) return "unsorted";
  return "farm";
}

function dateOf(it) {
  const raw = it.captured_at || it.creation_date || it.date || null;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/* A preview may legitimately be absent (manifest filename != S3 key). Trust the
 * index when we have it; only fall back to optimistic derivation if it failed. */
function hasPreview(ns, stem) {
  const set = PREVIEW_STEMS.get(ns);
  if (!set) return true;
  return set.has(stem);
}

/* Manifest `file` values are sometimes full paths ("santa_anna_fazenda/IMG_7702.HEIC")
 * while S3 keys are flat within a namespace. Compare on basename, or every preview
 * 404s and the raw-index pass re-adds the same file as a duplicate clone. */
const basename = (p) => String(p || "").split("/").pop();

/* A genuine GPS fix always carries decimals. The exporter emitted an exact
 * whole-degree placeholder ("3.0, 52.0") for all 44 santa-anna photos, which
 * plotted them in the Indian Ocean off Somalia. Whole-degree pairs are never a
 * real fix, so treat them as absent rather than drawing a wrong pin. */
function gpsOf(it) {
  const lat = Number(it.latitude);
  const lng = Number(it.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { lat: null, lng: null };
  if (Number.isInteger(lat) && Number.isInteger(lng)) {
    return { lat: null, lng: null, suspect: `${lat}, ${lng}` };
  }
  return { lat, lng };
}

/* Kept separate from normalize() because it.ns can be re-pointed after load by
 * resolveNamespaces(), which changes both the preview and raw paths. */
function applyPreview(it) {
  it.preview =
    it.file && hasPreview(it.ns, it.stem) ? `${S3}/previews/${it.ns}/${it.stem}.jpg` : null;
  it.rawUrl = it.file && it.isVideo ? `${S3}/raw/${it.ns}/${encodeURIComponent(it.file)}` : null;
  return it;
}

/* Extensions are not reliable identifiers: the manifest records `IMG_8501.mp4`
 * while S3 holds `IMG_8501.MOV` \u2014 same clip, different container name and case.
 * Matching on the exact filename left all 19 fazenda-dona-rosa videos unplayable. */
const extOf = (f) => {
  const m = String(f || "").match(/\.([^.]+)$/);
  return m ? m[1].toUpperCase() : "";
};
const stemOf = (f) => String(f || "").replace(/\.[^.]+$/, "");
const VIDEO_EXTS = new Set(["MP4", "MOV", "M4V", "AVI"]);
const sameKind = (a, b) => {
  if (a === b) return true;
  if (!a || !b) return true; // manifest omitted the extension entirely
  return VIDEO_EXTS.has(a) && VIDEO_EXTS.has(b);
};

/* Every zip any item in this manifest claims to have been extracted from.
 * Provenance outranks name similarity: `fazenda-clara-bahia` records
 * source.zip=fernando_carla.zip and matches raw/fernando-carla 58/58, yet the
 * two names share no token \u2014 a lexical-only rule rejects a provable link. */
function sourceZips(d) {
  const out = new Set();
  const walk = (v, depth) => {
    if (depth > 4 || v == null) return;
    if (typeof v === "string") {
      const m = v.match(/([^\/\\]+\.zip)\b/i);
      if (m) out.add(m[1]);
      return;
    }
    if (Array.isArray(v)) return v.slice(0, 40).forEach((x) => walk(x, depth + 1));
    if (typeof v === "object") {
      Object.keys(v).forEach((k) => walk(v[k], depth + 1));
    }
  };
  walk(d, 0);
  return out;
}

/* Resolve one manifest filename against one namespace's real S3 keys. */
function matchIn(ns, file) {
  const s3 = RAW_FILES.get(ns);
  if (!s3) return null;
  if (file in s3) return { ns, file };
  const st = stemOf(file);
  const e = extOf(file);
  const cands = Object.keys(s3).filter((k) => stemOf(k) === st);
  if (!cands.length) return null;
  const kind = cands.filter((k) => sameKind(extOf(k), e));
  if (kind.length === 1) return { ns, file: kind[0] };
  const exact = kind.filter((k) => extOf(k) === e);
  if (exact.length === 1) return { ns, file: exact[0] };
  if (!e && cands.length === 1) return { ns, file: cands[0] };
  return null;
}

function normalize(it, ns, id) {
  const file = basename(it.file || it.basename || "");
  const stem = file.replace(/\.[^.]+$/, "");
  const ext = (file.split(".").pop() || "").toLowerCase();
  const g = gpsOf(it);
  return applyPreview({
    id,
    ns,
    type: entityType(ns),
    file,
    stem,
    isVideo: ["mov", "mp4", "m4v", "avi"].includes(ext),
    yt: it.yt_id || null,
    lat: g.lat,
    lng: g.lng,
    gpsSuspect: g.suspect || null,
    date: dateOf(it),
    transcript: it.transcription || "",
    duration: it.duration_s || null,
  });
}

const fmtDate = (d) =>
  d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "undated";

const thumbFor = (it) => (it.yt ? ytThumb(it.yt) : it.preview);

/* ---------- load ---------- */

async function loadAll() {
  let files = [];
  try {
    const r = await fetch(MANIFEST_BASE + "index.json", { cache: "no-store" });
    if (r.ok) {
      const idx = await r.json();
      /* The published index nests its rows under `index` (array of
       * {farm_id, manifest, updated}). Older/other shapes are kept as fallbacks. */
      const list = Array.isArray(idx) ? idx : idx.index || idx.manifests || idx.farms || [];
      files = list
        .map((m) => (typeof m === "string" ? m : m.manifest || m.file || m.farm_id))
        .filter(Boolean)
        .map((n) => (n.endsWith(".json") ? n : n + ".json"));
    }
  } catch (e) {
    console.warn("index.json unavailable, falling back to a seed list", e);
  }
  await loadPreviewIndex();

  /* If the manifest index is unreachable, seed with every raw namespace that has
   * one and let the S3 index fill in the rest — better than a hardcoded trio that
   * silently drops most of the archive. */
  if (!files.length) {
    files = [...RAW_FILES.keys()].map((ns) => ns + ".json");
    console.warn("using raw-index namespaces as manifest seeds:", files.length);
  }
  files = [...new Set(files)];

  await Promise.all(
    files.map(async (f) => {
      try {
        const r = await fetch(MANIFEST_BASE + f);
        if (!r.ok) return;
        const d = await r.json();
        const ns = f.replace(/\.json$/, "");
        const zips = sourceZips(d);
        if (zips.size) PROVENANCE.set(ns, zips);
        (d.items || []).forEach((it) => ITEMS.push(normalize(it, ns, ITEMS.length)));
      } catch (e) {
        console.warn("manifest failed:", f, e);
      }
    })
  );

  resolveNamespaces();
  expandFromRawIndex();
  pruneUnservable();
  sortItems();
}

/* Some manifests name a namespace that S3 does not have — `santa-anna-fazenda-para`
 * vs the real `santa-anna-fazenda`. Without this, previews 404 AND the raw-index
 * pass fails to recognise the files, so all 44 appear twice (once with the bogus
 * coords, once with none).
 *
 * Filename overlap alone is NOT sufficient evidence: phone cameras all emit
 * IMG_1234.HEIC, so unrelated namespaces collide (founderhaus matched event-media
 * 10/10; fazenda-clara-bahia matched fernando-carla 58/58). Relabelling those
 * would mis-attribute one farm's photos to another. Require the namespace names
 * to be lexically related AND a high filename match rate. */
/* Tokens too generic to prove two namespaces are the same place. `fazenda`
 * appears in a dozen unrelated farms, so treating it as evidence made every
 * `fazenda-*` namespace a candidate and stalled otherwise-correct matches. */
const NS_STOP = new Set([
  "fazenda", "farm", "farms", "para", "paca", "pacaje", "bahia", "plot",
  "office", "the", "and", "site", "field",
]);
const nsTokens = (s) =>
  new Set(
    String(s || "")
      .toLowerCase()
      .replace(/^farms\//, "")
      .split(/[-_/. ]+/)
      .filter((t) => t && t.length > 2 && !NS_STOP.has(t))
  );
const nsKey = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/^farms\//, "")
    .replace(/[^a-z0-9]/g, "");
function resolveNamespaces() {
  if (!RAW_FILES.size) return;
  const byNs = new Map();
  ITEMS.forEach((it) => {
    if (!byNs.has(it.ns)) byNs.set(it.ns, []);
    byNs.get(it.ns).push(it);
  });
  const adopt = (it, m) => {
    it.ns = m.ns;
    it.file = m.file;
    it.stem = stemOf(m.file);
    it.isVideo = VIDEO_EXTS.has(extOf(m.file));
  };
  let moved = 0;
  byNs.forEach((items, ns) => {
    /* 1. Same namespace, tolerant of extension case and video container naming. */
    const unresolved = [];
    items.forEach((it) => {
      const m = matchIn(ns, it.file);
      if (m) {
        if (m.file !== it.file) adopt(it, m);
      } else unresolved.push(it);
    });
    if (!unresolved.length) return;

    /* 2. Candidates: lexically related, OR proven by the manifest's source zip. */
    const linked = new Set();
    const nk = nsKey(ns);
    const nt = nsTokens(ns);
    RAW_FILES.forEach((_, c) => {
      if (c === ns) return;
      const ck = nsKey(c);
      if (ck && nk && (nk.includes(ck) || ck.includes(nk))) return linked.add(c);
      /* Substring containment misses `rancho-maranta-para` vs
       * `rancho-maranta-plot-1`/`plot-2`, which share two real tokens but
       * neither contains the other. Token overlap catches the split. */
      const ct = nsTokens(c);
      for (const t of nt) if (ct.has(t)) return linked.add(c);
    });
    (PROVENANCE.get(ns) || new Set()).forEach((z) => {
      const zk = nsKey(z.replace(/\.zip$/i, ""));
      if (!zk) return;
      RAW_FILES.forEach((_, c) => {
        if (nsKey(c) === zk) linked.add(c);
      });
    });
    if (!linked.size) {
      console.info(`unlinked: ${ns} (${unresolved.length}) \u2014 no related or provenance-linked namespace`);
      return;
    }

    /* 3. Per ITEM, and only when exactly one namespace can serve it. A stem like
     * IMG_7833 exists in several namespaces, so a namespace-wide relabel would
     * silently mis-attribute one farm's photos to another. */
    unresolved.forEach((it) => {
      const hits = [];
      linked.forEach((c) => {
        const m = matchIn(c, it.file);
        if (m) hits.push(m);
      });
      if (hits.length === 1) {
        adopt(it, hits[0]);
        moved++;
      } else if (hits.length > 1) {
        console.info(`ambiguous, left unlinked: ${ns}/${it.file}`);
      }
    });
  });
  ITEMS.forEach(applyPreview);
  if (moved) console.info(`resolved ${moved} manifest row(s) into a real S3 namespace`);
}

/* Drop manifest rows whose file does not exist in S3 at all: they can never render,
 * and they inflate every facet, the timeline, and the "N of M" map denominator. */
function pruneUnservable() {
  if (!RAW_FILES.size) return;
  let dropped = 0;
  for (let i = ITEMS.length - 1; i >= 0; i--) {
    const it = ITEMS[i];
    if (it.yt) continue;
    const s3 = RAW_FILES.get(it.ns);
    if (!s3 || !(it.file in s3)) {
      ITEMS.splice(i, 1);
      dropped++;
    }
  }
  if (dropped) console.info(`pruned ${dropped} manifest row(s) with no S3 source`);
}

/* Stable, view-agnostic order: newest first, undated last, then by ns/file.
 * Keeps ids meaningful (ids are array indices) and the grid deterministic. */
function sortItems() {
  ITEMS.sort((a, b) => {
    if (a.date && b.date) return b.date - a.date;
    if (a.date) return -1;
    if (b.date) return 1;
    return a.ns.localeCompare(b.ns) || a.file.localeCompare(b.file);
  });
  ITEMS.forEach((it, i) => (it.id = i));
}

/* Pull the authoritative preview/raw index: 31 namespaces, 2,374 stems.
 * This is what makes a preview URL honest rather than a guess. */
async function loadPreviewIndex() {
  try {
    const r = await fetch(PREVIEWS_INDEX, { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    Object.entries(d.previews || {}).forEach(([ns, stems]) => {
      if (Array.isArray(stems)) PREVIEW_STEMS.set(ns, new Set(stems));
    });
    Object.entries(d.raw || {}).forEach(([ns, files]) => {
      if (files && typeof files === "object") RAW_FILES.set(ns, files);
    });
  } catch (e) {
    console.warn("previews.json unavailable; deriving preview URLs optimistically", e);
  }
}

/* Manifests describe only 22 of 31 namespaces. Surface every raw file that no
 * manifest mentions, so event/facility material is browsable instead of invisible.
 * These keep honest metadata: no GPS, no date -> shown as undated, not mis-mapped. */
function expandFromRawIndex() {
  const seen = new Set(ITEMS.map((it) => `${it.ns}/${it.file}`));
  RAW_FILES.forEach((files, ns) => {
    Object.keys(files).forEach((file) => {
      const key = `${ns}/${file}`;
      if (seen.has(key)) return;
      seen.add(key);
      ITEMS.push(normalize({ file }, ns, ITEMS.length));
    });
  });
}

/* ---------- filtering ---------- */

function visible() {
  const q = FILTER.q.trim().toLowerCase();
  return ITEMS.filter((it) => {
    if (FILTER.types.size && !FILTER.types.has(it.type)) return false;
    if (FILTER.nss.size && !FILTER.nss.has(it.ns)) return false;
    if (!q) return true;
    return (
      it.ns.toLowerCase().includes(q) ||
      it.file.toLowerCase().includes(q) ||
      (it.transcript && it.transcript.toLowerCase().includes(q))
    );
  });
}

/* ---------- facets ---------- */

function buildFacets() {
  const countBy = (key) => {
    const m = new Map();
    ITEMS.forEach((it) => m.set(it[key], (m.get(it[key]) || 0) + 1));
    return m;
  };
  const byType = countBy("type");
  const byNs = countBy("ns");

  const typeBox = document.getElementById("facet-type");
  typeBox.innerHTML = TYPE_ORDER.filter((t) => byType.has(t))
    .map(
      (t) => `<label><input type="checkbox" value="${t}" data-kind="type"><span>${titleize(t)}</span><span class="n">${byType.get(t)}</span></label>`
    )
    .join("");

  const nsBox = document.getElementById("facet-ns");
  nsBox.innerHTML = [...byNs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(
      ([n, c]) => `<label><input type="checkbox" value="${n}" data-kind="ns"><span>${titleize(n)}</span><span class="n">${c}</span></label>`
    )
    .join("");

  document.querySelectorAll("input[data-kind]").forEach((el) => {
    el.addEventListener("change", () => {
      const set = el.dataset.kind === "type" ? FILTER.types : FILTER.nss;
      el.checked ? set.add(el.value) : set.delete(el.value);
      render();
    });
  });

  document.getElementById("q").addEventListener("input", (e) => {
    FILTER.q = e.target.value;
    render();
  });

  document.getElementById("reset").addEventListener("click", () => {
    FILTER.types.clear();
    FILTER.nss.clear();
    FILTER.q = "";
    document.getElementById("q").value = "";
    document.querySelectorAll("input[data-kind]").forEach((el) => (el.checked = false));
    render();
  });
}

/* ---------- map ---------- */

let map = null;
let cluster = null;

function initMap() {
  if (map) return;
  map = L.map("map", { worldCopyJump: true }).setView([-12, -45], 3);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(map);
  cluster = L.markerClusterGroup({ maxClusterRadius: 45, chunkedLoading: true });
  map.addLayer(cluster);
}

function renderMap(items) {
  initMap();
  cluster.clearLayers();
  const pts = [];
  const markers = [];
  items.forEach((it) => {
    if (it.lat === null || it.lng === null) return;
    pts.push([it.lat, it.lng]);
    const m = L.marker([it.lat, it.lng]);
    const src = thumbFor(it);
    m.bindPopup(
      `<div class="pop">` +
        (src ? `<img src="${src}" loading="lazy" onerror="this.style.display='none'">` : "") +
        `<b>${titleize(it.ns)}</b><span>${fmtDate(it.date)} &middot; ${it.isVideo ? "video" : "photo"}</span>` +
        `<button onclick="openItem(${it.id})">View</button></div>`
    );
    markers.push(m);
  });
  cluster.addLayers(markers);
  if (pts.length) map.fitBounds(pts, { padding: [28, 28], maxZoom: 9 });
  const bad = items.filter((it) => it.gpsSuspect).length;
  document.getElementById("mapcount").textContent =
    `${pts.length} of ${items.length} shown have GPS coordinates` +
    (bad ? ` \u00b7 ${bad} placeholder coord${bad === 1 ? "" : "s"} ignored` : "");
}

/* ---------- timeline ---------- */

function renderTimeline(items) {
  const dated = items.filter((i) => i.date).sort((a, b) => b.date - a.date);
  const groups = new Map();
  dated.forEach((it) => {
    const k = `${it.date.getFullYear()}-${String(it.date.getMonth() + 1).padStart(2, "0")}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  });

  const undated = items.length - dated.length;
  let html = dated.length
    ? [...groups.entries()]
        .map(
          ([k, list]) =>
            `<section class="month"><h3>${monthLabel(k)} &middot; ${list.length}</h3><div class="grid">${list
              .map(card)
              .join("")}</div></section>`
        )
        .join("")
    : `<p class="empty">No dated items match these filters.</p>`;

  if (undated) html += `<p class="empty">${undated} item(s) have no capture date and are not on the timeline.</p>`;
  document.getElementById("timeline").innerHTML = html;
}

function monthLabel(k) {
  const [y, m] = k.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
  });
}

function card(it) {
  const src = thumbFor(it);
  const media = src
    ? `<img class="thumb" src="${src}" loading="lazy" alt="" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'no preview'}))">`
    : `<div class="ph">no preview</div>`;
  return `<div class="card" onclick="openItem(${it.id})">${media}<div class="meta"><b>${titleize(
    it.ns
  )}</b><span>${fmtDate(it.date)}${it.isVideo ? " &middot; video" : ""}</span></div></div>`;
}

/* ---------- names ---------- */

function renderNames(items) {
  const byNs = new Map();
  items.forEach((it) => {
    if (!byNs.has(it.ns)) byNs.set(it.ns, []);
    byNs.get(it.ns).push(it);
  });
  if (!byNs.size) {
    document.getElementById("names").innerHTML = `<p class="empty">No sources match these filters.</p>`;
    return;
  }
  const sections = TYPE_ORDER.filter((t) => [...byNs.keys()].some((n) => entityType(n) === t)).map((t) => {
    const rows = [...byNs.entries()]
      .filter(([n]) => entityType(n) === t)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([n, list]) => {
        const dated = list.filter((x) => x.date).length;
        const gps = list.filter((x) => x.lat !== null).length;
        return `<div class="card" onclick="filterTo('${n}')"><div class="meta"><b>${titleize(
          n
        )}</b><span>${list.length} items &middot; ${dated} dated &middot; ${gps} geo</span></div></div>`;
      })
      .join("");
    return `<section class="group"><h3>${titleize(t)}</h3><p>${rows ? "" : "none"}</p><div class="grid">${rows}</div></section>`;
  });
  document.getElementById("names").innerHTML = sections.join("");
}

function filterTo(ns) {
  FILTER.nss.clear();
  FILTER.nss.add(ns);
  document.querySelectorAll('input[data-kind="ns"]').forEach((el) => (el.checked = el.value === ns));
  setView("timeline");
  render();
}

/* ---------- lightbox ---------- */

function openItem(id) {
  const it = ITEMS[id];
  if (!it) return;
  let body = "";
  if (it.yt) {
    body = `<iframe src="https://www.youtube.com/embed/${it.yt}?autoplay=1" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`;
  } else if (it.isVideo && it.rawUrl) {
    body = `<video src="${it.rawUrl}" ${it.preview ? `poster="${it.preview}"` : ""} controls autoplay playsinline></video>`;
  } else if (it.preview) {
    body = `<img src="${it.preview}" alt="">`;
  } else {
    body = `<p class="empty">No playable or viewable file recorded for this item.</p>`;
  }
  document.getElementById("lb-body").innerHTML = body;
  document.getElementById("lb-title").textContent = `${titleize(it.ns)} — ${it.file || "(no filename)"}`;
  document.getElementById("lightbox").classList.add("on");
}

function closeLightbox() {
  document.getElementById("lightbox").classList.remove("on");
  document.getElementById("lb-body").innerHTML = "";
}

/* ---------- views ---------- */

function setView(v) {
  VIEW = v;
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  document.querySelectorAll(".view").forEach((s) => s.classList.toggle("on", s.id === `view-${v}`));
  if (v === "map") {
    initMap();
    setTimeout(() => map.invalidateSize(), 60);
  }
  render();
}

function render() {
  const items = visible();
  document.getElementById("stats").textContent =
    `${items.length} of ${ITEMS.length} items shown`;
  if (VIEW === "map") renderMap(items);
  else if (VIEW === "timeline") renderTimeline(items);
  else renderNames(items);
}


(async () => {
  await loadAll();
  console.log("=== INVARIANTS ===");
  const orphanRows=ITEMS.filter(i=>!i.yt && !RAW_FILES.get(i.ns));
  console.log("rows in a namespace absent from S3 :", orphanRows.length, orphanRows.length?"FAIL":"OK");
  const noPrev=ITEMS.filter(i=>!i.yt && i.preview==null && RAW_FILES.get(i.ns));
  console.log("linked rows with no preview        :", noPrev.length, noPrev.length?"note":"OK");
  const gps=ITEMS.filter(i=>i.lat!=null&&i.lng!=null);
  const out=gps.filter(i=>i.lat<-34||i.lat>6||i.lng<-74||i.lng>-33);
  console.log("GPS points / outside bbox          :", gps.length, "/", out.length, out.length?"FAIL":"OK");
  console.log("ITEMS / namespaces / previews      :", ITEMS.length, "/", new Set(ITEMS.map(i=>i.ns)).size, "/", ITEMS.filter(i=>i.preview).length);
  // spot-check the fixes
  const dr=ITEMS.filter(i=>i.ns==="fazenda-dona-rosa"&&i.isVideo);
  console.log("\nfazenda-dona-rosa videos playable :", dr.filter(i=>i.rawUrl).length, "/", dr.length);
  const cb=ITEMS.filter(i=>i.ns==="fernando-carla");
  console.log("fernando-carla (clara-bahia merged):", cb.length, "items,", cb.filter(i=>i.preview).length, "previews");
  for (const n of ["rancho-maranta-plot-1","rancho-maranta-plot-2","rancho-maranata","raimundo-geniza","sorting","bomsucesso"]) {
    const g=ITEMS.filter(i=>i.ns===n);
    console.log("  "+n.padEnd(22), g.length, "items |", g.filter(i=>i.preview).length, "previews");
  }
  // no namespace should have been created that is not real S3
  const bad=[...new Set(ITEMS.map(i=>i.ns))].filter(n=>!RAW_FILES.has(n));
  console.log("\nnamespaces not in S3:", bad.length, bad.length?bad:"OK");
})();

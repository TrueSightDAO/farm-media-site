/* farm-media-site — 3-view browser over the TrueSight DAO media archive.
 * No backend, no build step. Data: public manifests + public S3.
 */

const MANIFEST_BASE = "https://raw.githubusercontent.com/TrueSightDAO/farm_media_manifests/main/";
const S3 = "https://s3.amazonaws.com/media.agroverse.shop";
const ytThumb = (id) => `https://img.youtube.com/vi/${id}/hqdefault.jpg`;

const PREVIEWS_INDEX = `${S3}/previews.json`;
const PREVIEW_STEMS = new Map(); // ns -> Set(stem) of previews that actually exist
const RAW_FILES = new Map(); // ns -> { filename: ext } straight from S3

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

function normalize(it, ns, id) {
  const file = it.file || "";
  const stem = file.replace(/\.[^.]+$/, "");
  const ext = (file.split(".").pop() || "").toLowerCase();
  const isVideo = ["mov", "mp4", "m4v", "avi"].includes(ext);
  const hasFile = Boolean(file);
  return {
    id,
    ns,
    type: entityType(ns),
    file,
    stem,
    isVideo,
    preview: hasFile && hasPreview(ns, stem) ? `${S3}/previews/${ns}/${stem}.jpg` : null,
    rawUrl: hasFile && isVideo ? `${S3}/raw/${ns}/${encodeURIComponent(file)}` : null,
    yt: it.yt_id || null,
    lat: Number.isFinite(it.latitude) ? it.latitude : null,
    lng: Number.isFinite(it.longitude) ? it.longitude : null,
    date: dateOf(it),
    transcript: it.transcription || "",
    duration: it.duration_s || null,
  };
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
      const list = Array.isArray(idx) ? idx : idx.manifests || idx.farms || [];
      files = list
        .map((m) => (typeof m === "string" ? m : m.manifest || m.file || m.farm_id))
        .filter(Boolean)
        .map((n) => (n.endsWith(".json") ? n : n + ".json"));
    }
  } catch (e) {
    console.warn("index.json unavailable, falling back to a seed list", e);
  }
  if (!files.length) {
    files = ["oscar-bahia.json", "fazenda-santa-ana-bahia.json", "paulo-la-do-sitio.json"];
  }
  files = [...new Set(files)];

  await loadPreviewIndex();

  await Promise.all(
    files.map(async (f) => {
      try {
        const r = await fetch(MANIFEST_BASE + f);
        if (!r.ok) return;
        const d = await r.json();
        const ns = f.replace(/\.json$/, "");
        (d.items || []).forEach((it) => ITEMS.push(normalize(it, ns, ITEMS.length)));
      } catch (e) {
        console.warn("manifest failed:", f, e);
      }
    })
  );

  expandFromRawIndex();
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
  document.getElementById("mapcount").textContent =
    `${pts.length} of ${items.length} shown have GPS coordinates`;
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

/* ---------- boot ---------- */

(async function boot() {
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.addEventListener("click", () => setView(b.dataset.view))
  );
  document.getElementById("lb-close").addEventListener("click", closeLightbox);
  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox") closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeLightbox();
  });

  await loadAll();
  buildFacets();
  document.getElementById("loading").classList.add("off");
  initMap();
  render();
  window.__MEDIA_READY__ = true;
  window.__MEDIA_COUNT__ = ITEMS.length;
})();

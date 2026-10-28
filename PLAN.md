# Media browser + HEIC preview backfill — implementation plan

> Scope handed down by Gary Teh: convert `raw/<ns>/*.HEIC` → `previews/<ns>/<stem>.jpg`, ship the public
> 3-view browser at **media.truesight.me**, execute through to Visual UAT (Sophia first, then governor review).

## 1. Why

The archive has ~2,378 raw objects in S3 `media.agroverse.shop` (nelanco), but `previews/` only ever held
**video poster frames**. HEIC does not render in Chrome or Firefox (Safari only), so without conversion a
large share of the photo archive is unviewable on the web. Measured on a 70-item random sample before the
fix: **video previews 69% hit, photo previews 0% hit**.

## 2. Census (measured, not estimated)

| Metric | Value |
|---|---|
| `raw/` objects | 2,378 |
| — MOV | 1,683 |
| — **HEIC** | **691** (1.84 GB, 0.5–5.7 MB each) |
| — PNG / JPG | 4 |
| Existing `previews/` objects | 1,684 |
| HEIC targets already covered | 1 / 691 |
| **Needed conversions** | **690** |
| Namespaces affected | 17 |

Largest namespaces: `paulo-la-do-sitio` 242, `medicilandia-convention-2024` 114,
`fazenda-santa-ana-bahia` 92, `sitio-torres-pacaja-para` 38, `fazenda-dona-rosa` 35.

> **Reconciliation note:** the manifests under-report HEIC (337 found via manifest `file` fields vs 691
actual S3 keys). The **S3 inventory is authoritative**; the manifest gap is a separate follow-up.

## 3. Design

`/media/heic_preview/heic_to_preview.py` on the autopilot box:

- **Source of truth**: S3, not local disk (the local `/media` trees hold daemon MP4s, no HEIC).
- **Transform**: `pillow_heif` → `ImageOps.exif_transpose` (honour camera orientation) → RGB →
  downscale longest edge to **1600 px** (Lanczos) → progressive JPEG **q82**.
- **Target**: `previews/<ns>/<stem>.jpg` — identical naming to existing video poster frames, so the
  browser's URL derivation stays a one-liner.
- **Headers**: `Content-Type: image/jpeg`, `Cache-Control: public, max-age=31536000, immutable`.
- **Idempotent + resumable**: skips any target already in `previews/`; appends to `state.json` every 25.
- **Parallel**: 4 workers (t3.medium), no destructive writes — only new `put_object` on absent keys.

### Why S3 `previews/` and not GitHub `farm-media-raw`

`MEDIA_ARCHIVE_PIPELINE.md` puts *photo originals* in GitHub (`farm-media-raw`, Content-API only). This
job writes **derived previews**, which that same runbook assigns to S3 `previews/<farm-id>/<basename>.jpg`
as the **HOT** tier that "keeps timeline/map explorer fast". Originals stay untouched.

## 4. Execution roadmap

| # | Unit | Where | Gate |
|---|---|---|---|
| 1 | Converter + launch backfill | autopilot box | 690/691 converted, 0 failures |
| 2 | Plan doc + v1 site | farm-media-site PR | `node --check` clean, PR reviewed |
| 3 | Enable GitHub Pages + CNAME | repo settings | `media.truesight.me` resolves to `truesightdao.github.io` |
| 4 | Route 53 record | explorya zone `Z0032474227N6EQ3Z4QU` | DNS answers on public resolvers |
| 5 | Sophia visual UAT | `visual_uat` | DOM assertions pass, no console errors, no broken images |
| 6 | Governor visual UAT | Discord `1548902290344255600` | reviewer confirms |
| 7 | Link from truesight.me | `truesight_me_beta` | one card in the homepage grid |

**Stops:** everything through step 6 is reversible (new objects + new repo + new DNS record, no overwrites).
Step 7 touches the public site — beta first, prod only on explicit approval.

## 5. Checklist

### Backfill
- [ ] 690 conversions complete, failure list empty or triaged
- [ ] Spot-check 10 objects: HTTP 200, `Content-Type: image/jpeg`, JPEG magic `ffd8ff`
- [ ] Orientation correct on portrait shots (exif_transpose)
- [ ] No raw HEIC deleted or modified
- [ ] Coverage re-sample hits ≥95%

### Site
- [ ] `node --check app.js`
- [ ] All manifests load; item count matches manifest total
- [ ] Map renders clusters; popups show thumbnails
- [ ] Timeline groups by month, newest first
- [ ] Name facets filter all three views
- [ ] Missing previews degrade to a placeholder, never a broken-image icon
- [ ] Mobile viewport usable

### DNS / pages
- [ ] Pages enabled on `main`
- [ ] CNAME honoured, HTTPS certificate issued
- [ ] Apex site unaffected

### UAT
- [ ] Sophia `visual_uat` pass
- [ ] Governor visual sign-off

## 6. Risks

| Risk | Mitigation |
|---|---|
| t3.medium memory pressure on 5.7 MB HEIC | 4 workers, downsample on decode; watch `free -m` |
| Cost | 690 reads + 690 writes; near-zero at this volume (~150 MB out total) |
| Duplicate previews | Idempotent skip on existing key |
| S3 path-style endpoint reliance | `s3.amazonaws.com/<bucket>` has a valid cert; the `media.agroverse.shop` vanity domain currently serves a cert for `s3.amazonaws.com` and does not verify, so it is avoided |
| Dirty data (0-item manifests) | `la-do-sitio.json` and `sitio-catarinense-para.json` hold 0 items despite files on disk — follow-up, not blocking |

## 7. Follow-ups

1. Fix `Content-Type` on the **1,684 existing** poster frames (`binary/octet-stream` → `image/jpeg`).
2. Backfill the manifest gap (337 vs 691 HEIC).
3. Add `entity_type` to `index.json` (currently derived client-side).
4. Recover ~356 missing capture dates from source mtimes.
5. Repair the two 0-item manifests.
6. Add manifests for un-manifested S3 namespaces (`event-media`, `medicilandia-convention-2024`,
   `paulo-interview`, `cacao-variety-parap`, `bomsucesso`, `sorting`, `to-analyze`,
   `facility-cic-cacao-innovation-center`, `fazenda-analuana-bahia`, `vivi-jesus-do-deus-itacare`).

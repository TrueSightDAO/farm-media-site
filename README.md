# farm-media-site

Public 3-view browser over the TrueSight DAO media archive — served at **media.truesight.me**.

| View | Source fields |
|---|---|
| Map | `latitude` / `longitude` |
| Timeline | `captured_at` / `creation_date` |
| Names | namespace prefix → farm / facility / event / partner / program + transcript text |

No backend, no build step. Static HTML + CSS + JS, data fetched live from:

- manifests — `raw.githubusercontent.com/TrueSightDAO/farm_media_manifests/main/`
- previews / raw video — `s3.amazonaws.com/media.agroverse.shop/`

See `PLAN.md` for the implementation plan and the HEIC→JPEG preview backfill.

# Vendored from `pantry-db`

These modules are copied verbatim from the [`pantry-db`](https://github.com/jaycer/pantry-db)
repo so the static portfolio build and the source app render identical PDFs and
share the eligibility formatting:

- `pdf/model.ts`, `pdf/layout.ts`, `pdf/full-pager.ts`, `pdf/booklet.ts`
- `eligibility-format.ts`

They depend only on `pdf-lib` (and each other), no app/DB code. If you change the
PDF layout, change it in `pantry-db/lib/pdf` and re-copy here. `data.json` is the
output of `pantry-db`'s `npm run export:portfolio`.

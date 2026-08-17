# Demo data

The local data store is initialized deterministically by `src/seeds.js` with six projects,
30 members and 25 subscription-interest records. Every person, company and amount is
fictional and marked `demo: true`. Runtime mutations are written to `runtime/data.json`,
which is intentionally ignored by Git.

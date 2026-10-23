# Contributing

Issues and pull requests are welcome, especially from people who build or use
AAC apps.

- Protocol changes start as an issue describing the need. Additive fields are
  fine in v1; anything that changes meaning goes to v2.
- Keep the library dependency-free and small. It must run in any browser and
  in Node 20 and up.
- Every change comes with a test (`npm test`; relay changes: `cd relay && npm test`).
- Privacy rules in `PRIVACY.md` are not negotiable in a pull request.
- No em dashes in docs.

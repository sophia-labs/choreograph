# `@sophia-labs/canonical-json`

This package is the single TypeScript authority for JSON bytes used in Sophia
identity and admission digests. Object keys are ordered by JavaScript UTF-16
code units, arrays retain their order, and scalar encoding follows
`JSON.stringify`.

`golden-vectors.json` is the language-neutral compatibility contract. TypeScript,
Rust, and Python implementations must reproduce both its canonical bytes and its
SHA-256 values.

Releases are private and immutable in the dedicated AWS CodeArtifact repository
`sophia/canonical-json` in `us-west-2`.

# tlsnotary

Rust notary and prover binaries built on the TLSNotary library. The notary co-signs a TLS session, and the prover produces a cryptographic attestation of the session transcript.

## Dependency

The `tlsn` and `tlsn-formats` crates are sourced from the git submodule at `vendor/tlsn` (pinned commit `c55853b3`, based on `v0.1.0-alpha.14`). Initialize it before building:

```bash
git submodule update --init --recursive
```

## Binaries

- `src/bin/notary.rs` -- notary server that listens for prover connections
- `src/bin/prover.rs` -- TLS prover that connects to the mock employer server and writes an attestation

## Tasks

```bash
moon run tlsnotary:notary   # start the notary server
moon run tlsnotary:prover   # run the TLS prover
moon run tlsnotary:build    # compile both binaries
moon run tlsnotary:test     # run Rust tests
```

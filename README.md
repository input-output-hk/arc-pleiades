# Pleiades

[![CI](https://github.com/input-output-hk/arc-pleiades/actions/workflows/ci.yml/badge.svg)](https://github.com/input-output-hk/arc-pleiades/actions/workflows/ci.yml)

> **⚠ Work in progress — not audited, not production-ready.**
> This library implements novel cryptographic schemes that have not undergone a
> formal security audit. Do not use it to protect real keys or assets.

Pleiades is a Rust library for **decentralised key recovery** over elliptic curves.
It lets a key-owner distribute a secret across a set of guardians so that any
threshold subset can reconstruct it — without any single guardian learning the
secret on their own.

[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> WARNING: **Important Disclaimer & Acceptance of Risk**  
> This is a proof-of-concept implementation that has not undergone security auditing. This code is provided "as is" for research and educational purposes only. It may contain vulnerabilities. **Do not use this code in production systems or any environment where security is critical without conducting your own thorough security assessment.** By using this code, you acknowledge and accept all associated risks, and our company disclaims any liability for damages or losses.

Three families of scheme are provided, ranging from classic information-theoretic
sharing to traceable constructions that can identify which guardian leaked:

| Scheme           | Threshold      | Traceability           | Non-imputability    |
|------------------|----------------|------------------------|---------------------|
| Shamir SSS       | (t+1)-of-(n−1) | —                      | —                   |
| Feldman VSS      | (t+1)-of-(n−1) | —                      | Verifiable shares   |
| Traceable Shamir | t-of-n         | ✓ (up to f < t)        | —                   |
| BUSS (ANARKey)   | (t+1)-of-(n−1) | —                      | Stateless guardians |
| Traceable BUSS   | (t+1)-of-(n−1) | ✓ (up to f ≤ t)        | ✓ OWF witness       |

All field arithmetic is over the BLS12-381 scalar field (`Fq`) using the
[`midnight-curves`](https://crates.io/crates/midnight-curves) crate.
Feldman VSS also uses the `G1` group for polynomial commitments.

---

## Repository layout

```
src/
  secret_sharing/
    shamir.rs            — Shamir SSS and Share type
    feldman.rs           — Feldman VSS with G1 commitments
    traceable_shamir.rs  — Traceable Shamir (EPRINT 2024/405)
  bottom_up/
    buss.rs              — Bottom-Up SSS / ANARKey (EPRINT 2025/551)
    traceable_buss.rs    — Traceable, non-imputable BUSS (EPRINT 2025/2089)
  math/
    polynomial.rs        — Polynomial<F>: eval, interpolate, div_rem, roots, …
    fft.rs               — Cooley-Tukey FFT / iFFT over PrimeField
    list_decoding.rs     — Guruswami-Sudan list decoder for Reed-Solomon codes
  lib.rs                 — Public re-exports

arc-pleiades-wasm/       — wasm-bindgen bindings (compiled to docs/pkg/)
examples/
  shamir.rs              — Shamir SSS + Feldman VSS walkthrough
  buss.rs                — BUSS full protocol walkthrough
benches/
  poly.rs                — Polynomial eval/interpolate: Horner/Lagrange vs FFT
  shamir.rs              — Shamir SSS: split, split_fft, reconstruct
  feldman.rs             — Feldman VSS: split, compute_verification_key, verify_share, reconstruct
  traceable_shamir.rs    — Traceable Shamir: split, compute_tracing_keys, reconstruct, trace, verify_trace
  buss.rs                — BUSS: split, reconstruct, update_public_shares
  traceable_buss.rs      — Traceable BUSS: split, compute_tracing_keys, reconstruct, update_public_shares, trace, verify_trace
docs/                    — Static website with interactive WASM demo
```

---

## Quick start

```rust
use arc_pleiades::ShamirSecretSharing;
use arc_pleiades::secret_sharing::SecretSharing;
use midnight_curves::Fq;
use rand::thread_rng;

// 3-out-of-4: degree-2 polynomial, 4 shares, any 3 reconstruct
let sss = ShamirSecretSharing::new(2, 5)?;
let secret = Fq::from(42u64);
let mut rng = thread_rng();

let poly = sss.polynomial(secret, &mut rng);
let shares = sss.split(&poly)?;
let recovered = sss.reconstruct(&shares[..3])?;
assert_eq!(secret, recovered);
```

See [`examples/shamir.rs`](examples/shamir.rs) for Shamir + Feldman VSS and
[`examples/buss.rs`](examples/buss.rs) for the full BUSS protocol with
key-update deltas.

---

## Running

```sh
# Unit and integration tests
cargo test

# Shamir SSS + Feldman VSS example
cargo run --example shamir

# BUSS (Bottom-Up SSS) example
cargo run --example buss

# Benchmarks — all schemes' split/reconstruct/trace/verify, plus polynomial FFT
cargo bench
```

See [`BENCHMARK.md`](BENCHMARK.md) for what's benchmarked and results on a reference machine.

---

## Interactive website

The `docs/` folder is a static website with an interactive demo that runs the
library compiled to WebAssembly — real BLS12-381 arithmetic, real Lagrange
interpolation, real Guruswami-Sudan tracing.

### Build the WASM module

```sh
# Install wasm-pack once
cargo install wasm-pack

# Compile to docs/pkg/
cd arc-pleiades-wasm
wasm-pack build --target web --out-dir ../docs/pkg
```

### Serve locally

ES modules and `.wasm` fetches require HTTP (browsers block them on `file://`).

```sh
cd docs
python3 -m http.server 8080
# open http://localhost:8080
```

---

## Academic references

- **Shamir SSS** — Adi Shamir.
  *How to Share a Secret.*
  Communications of the ACM, 22(11):612–613, 1979.

- **Feldman VSS** — Paul Feldman.
  *A Practical Scheme for Non-Interactive Verifiable Secret Sharing.*
  FOCS 1987, pp. 427–438.

- **Traceable Secret Sharing** — Boneh, Partap, Rotem.
  *Traceable Secret Sharing: Strong Security and Efficient Constructions.*
  [EPRINT 2024/405](https://eprint.iacr.org/2024/405.pdf)

- **BUSS / ANARKey** — Kate, Mukherjee, Saleem, Sarkar, Roberts.
  *ANARKey: A New Approach to (Socially) Recover Keys.*
  [EPRINT 2025/551](https://eprint.iacr.org/2025/551.pdf)

- **Traceable BUSS** — Hajra, Kar, Mukherjee, Pal.
  *Traceable Bottom-Up Secret Sharing and Law & Order on Community Social Key Recovery.*
  [EPRINT 2025/2089](https://eprint.iacr.org/2025/2089.pdf)

---

## Minimum supported Rust version

**1.87** (required by `is_multiple_of` stabilisation in `midnight-curves v0.3.1`; also requires `edition = "2024"` support and `Cargo.lock` format v4).
Enforced by the `msrv` CI job.

---

## License

MIT — see [`LICENSE`](LICENSE).

---

## What this library does not provide

- Network transport or share distribution protocol
- Key serialisation / interchange format
- Authenticated channels between parties
- Threshold signature schemes (see [`threshold-bls`](https://github.com/input-output-hk/threshold-bls) for that)
- A formal specification or proof artefacts beyond the referenced papers

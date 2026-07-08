# Benchmarks

Criterion benchmarks for every scheme in this crate, plus the underlying
polynomial arithmetic. Each scheme gets its own file under [`benches/`](benches/),
covering share creation, reconstruction, and — where applicable — tracing and
trace verification.

## Available benchmarks

| File | Scheme | Functions benchmarked |
|------|--------|------------------------|
| [`benches/poly.rs`](benches/poly.rs) | `Polynomial<F>` | `eval` (Horner vs FFT), `interpolate` (Lagrange vs iFFT) |
| [`benches/shamir.rs`](benches/shamir.rs) | Shamir SSS | `split`, `split_fft`, `reconstruct` |
| [`benches/feldman.rs`](benches/feldman.rs) | Feldman VSS | `split`, `compute_verification_key`, `verify_share`, `reconstruct` |
| [`benches/traceable_shamir.rs`](benches/traceable_shamir.rs) | Traceable Shamir | `split`, `compute_tracing_keys`, `reconstruct`, `trace`, `verify_trace` |
| [`benches/buss.rs`](benches/buss.rs) | BUSS (ANARKey) | `split`, `reconstruct`, `update_public_shares` |
| [`benches/traceable_buss.rs`](benches/traceable_buss.rs) | Traceable BUSS | `split`, `compute_tracing_keys`, `reconstruct`, `update_public_shares`, `trace`, `verify_trace` |

Each scheme benchmark (except `trace`/`verify_trace`) runs at community sizes
`n ∈ {10, 50, 100}` with threshold `t ≈ n/2`. `trace`/`verify_trace` run at
`(t, n) ∈ {(5, 10), (10, 20)}` with one corrupted party and security parameter
4 (matching this crate's own test suite) — `trace` issues a batch of synthetic
reconstruction queries plus a Guruswami-Sudan decode per call, so it's
considerably more expensive than the other operations and is benchmarked at
fewer, smaller sizes with a reduced sample count.

For the dealer-driven schemes (Shamir, Feldman, Traceable Shamir), `split`
measures `polynomial()` *and* `split()` together, not `split()` alone. BUSS's
`split()` has no separate polynomial-construction step to exclude — it
interpolates the polynomial from guardian shares and evaluates it in one call
— so timing only the dealer-driven schemes' evaluation step would understate
their true "secret → shares" cost relative to BUSS's and make the comparison
unfair.

## Running

```sh
# Everything
cargo bench

# One scheme
cargo bench --bench shamir
cargo bench --bench traceable_buss

# Filter to a specific function within a bench file (Criterion substring match)
cargo bench --bench traceable_shamir -- trace
```

Each run writes an HTML report to `target/criterion/<group>/<function>/report/index.html`
with plots and full statistics; the tables below are just the point estimates.

## Results

**Test machine:** Intel Core i9-14900HX (24 cores / 32 threads, up to 5.8 GHz),
62 GiB RAM, Ubuntu 24.04.4 LTS, `rustc 1.93.1`, release profile. All benchmarks
are single-threaded (Criterion doesn't parallelize within a benchmark), so core
count doesn't affect these numbers — it's reported for completeness.

Measured via `cargo bench --bench <name> -- --warm-up-time 1 --measurement-time 2`
(Criterion's defaults of 3s/5s give tighter confidence intervals but take much
longer to run; timings below are consistent with the default settings within
noise, this repo just
regenerated them faster for documentation purposes). Numbers are the median of
Criterion's reported `[low, median, high]` interval. Your numbers will vary with CPU,
governor settings, and load — re-run `cargo bench` for figures specific to your machine.

### Polynomial arithmetic (`poly.rs`)

Horner evaluates each point independently in O(degree); FFT evaluates the whole
root-of-unity domain in one O(k log k) pass — the crossover is visible almost
immediately. Lagrange interpolation (`Polynomial::interpolate`) builds the
node polynomial `M(x) = Π(x−xᵢ)` once (O(k²)) and recovers each point's basis
polynomial via O(k) synthetic division, for O(k²) overall against arbitrary
x-coordinates; iFFT-based interpolation is O(k log k) but only works for
evaluations at roots of unity.

| k (points) | `eval`: horner | `eval`: fft | `interpolate`: lagrange | `interpolate`: from_fft |
|-----:|--------------:|------------:|----------------------:|------------------------:|
| 4    | 397 ns   | 680 ns   | 5.98 µs   | 2.99 µs |
| 8    | 1.63 µs  | 809 ns   | 14.3 µs   | 3.10 µs |
| 16   | 6.41 µs  | 1.08 µs  | 39.6 µs   | 3.52 µs |
| 32   | 25.3 µs  | 1.83 µs  | 122 µs    | 4.39 µs |
| 64   | 102 µs   | 26.8 µs  | 413 µs    | 40.2 µs |
| 128  | 417 µs   | 31.9 µs  | 1.51 ms   | 55.9 µs |
| 256  | 1.68 ms  | 46.2 µs  | 5.88 ms   | 99.9 µs |
| 512  | 6.77 ms  | 83.1 µs  | —         | —       |
| 1024 | 27.3 ms  | 145 µs   | —         | —       |

> `interpolate`'s numbers used to be dramatically worse (265 ms at k=256,
> growing at ~8× per doubling — cubic, not quadratic) due to an
> implementation bug: it rebuilt each point's Lagrange basis polynomial from
> scratch via k−1 sequential polynomial multiplications, which is O(k²) per
> point on top of an O(k) accumulation, for O(k³) overall. Fixed by building
> the node polynomial once and dividing it down per point instead — same
> algorithm the doc comment always claimed, now actually implemented that way.

### Shamir SSS (`shamir.rs`)

`split_fft` overtakes plain Horner `split` once `n` is large enough to pay for
the FFT setup; below that it's roughly a wash.

| n   | `split` (incl. `polynomial()`) | `split_fft` (incl. `polynomial()`) | `reconstruct` |
|----:|--------:|------------:|---------------:|
| 10  | 1.58 µs  | 2.01 µs | 7.74 µs  |
| 50  | 32.7 µs  | 37.5 µs | 54.3 µs  |
| 100 | 128 µs   | 46.9 µs | 156 µs   |

### Feldman VSS (`feldman.rs`)

`split` and `reconstruct` match plain Shamir almost exactly (same underlying
math); `compute_verification_key` and `verify_share` add the G1
multi-scalar-multiplication overhead, scaling with the polynomial degree
(`t + 1` group operations each).

| n   | `split` (incl. `polynomial()`) | `compute_verification_key` | `verify_share` | `reconstruct` |
|----:|--------:|----------------------------:|----------------:|---------------:|
| 10  | 1.62 µs  | 341 µs   | 400 µs   | 7.78 µs |
| 50  | 33.8 µs  | 1.85 ms  | 1.57 ms  | 54.0 µs |
| 100 | 130 µs   | 2.88 ms  | 2.96 ms  | 157 µs  |

### Traceable Shamir (`traceable_shamir.rs`)

`split`/`compute_tracing_keys`/`reconstruct` cost a small constant factor over
plain Shamir (hash-chain x-coordinate derivation instead of sequential
integers). `trace` dominates — one Guruswami-Sudan decode over the
query-derived evaluations — and `verify_trace` is cheap (`O(f)` hash checks).

| n (t=n/2) | `split` (incl. `polynomial()`) | `compute_tracing_keys` | `reconstruct` |
|----:|--------:|-------------------------:|---------------:|
| 10  | 4.12 µs  | 5.39 µs | 6.28 µs |
| 50  | 45.7 µs  | 26.1 µs | 51.4 µs |
| 100 | 156 µs   | 52.9 µs | 152 µs  |

| (t, n), f=1 | `trace` | `verify_trace` |
|---|--------:|----------------:|
| (5, 10)  | 1.72 ms | 239 ns |
| (10, 20) | 2.07 ms | 240 ns |

### BUSS / ANARKey (`buss.rs`)

`split` interpolates the degree-(n−1) polynomial through all n points (the
bottom-up structure means every guardian's share participates, unlike Shamir's
degree-t poly) via `Polynomial::interpolate` — an O(n²) Lagrange interpolation,
so it scales noticeably worse with `n` than Shamir's split even after the
`interpolate` fix above. `update_public_shares` (key rotation) recomputes a
Lagrange basis value per φ entry.

| n (t=n/2) | `split` | `reconstruct` | `update_public_shares` |
|----:|--------:|---------------:|-------------------------:|
| 10  | 21.3 µs  | 15.1 µs | 40.9 µs |
| 50  | 304 µs   | 158 µs  | 1.34 ms |
| 100 | 1.10 ms  | 513 µs  | 5.52 ms |

> Before the `Polynomial::interpolate` fix, `split` measured 31.5 µs / 2.14 ms
> / 16.1 ms at the same sizes — up to **14.6× slower** at n=100. `reconstruct`
> and `update_public_shares` were unaffected (neither calls `interpolate`).

### Traceable BUSS (`traceable_buss.rs`)

`split`/`reconstruct`/`update_public_shares` inherit BUSS's O(n²)
interpolation cost almost exactly (the random evaluation points don't change
the asymptotics). `trace` is somewhat more expensive than Traceable Shamir's
at the same size — each query also evaluates the `h_φ` correction factor over
φ. `verify_trace` is unaffected by `n`, as expected for an `O(f)` check.

| n (t=n/2) | `split` | `compute_tracing_keys` | `reconstruct` | `update_public_shares` |
|----:|--------:|-------------------------:|---------------:|-------------------------:|
| 10  | 21.4 µs  | 2.08 µs | 14.4 µs | 39.3 µs |
| 50  | 292 µs   | 11.2 µs | 151 µs  | 1.29 ms |
| 100 | 1.06 ms  | 22.5 µs | 492 µs  | 5.33 ms |

| (t, n), f=1 | `trace` | `verify_trace` |
|---|--------:|----------------:|
| (5, 10)  | 2.02 ms | 233 ns |
| (10, 20) | 2.94 ms | 234 ns |

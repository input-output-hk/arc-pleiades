//! Benchmarks for Traceable Shamir Secret Sharing (`TraceableShamir`).

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use ff::Field;
use midnight_curves::Fq;
use rand::rngs::StdRng;
use rand::SeedableRng;
use sha2::Sha512;

use arc_pleiades::secret_sharing::traceable_shamir::Share;
use arc_pleiades::secret_sharing::{SecretSharing, TraceableSS};
use arc_pleiades::TraceableShamir;

const SIZES: [usize; 3] = [10, 50, 100];

// Fixed for all tracing-related benchmarks: one corrupted party, a small
// security parameter (matches this crate's own test suite) to keep the
// number of oracle queries — and hence bench runtime — small.
const F: usize = 1;
const SEC_PARAM: usize = 4;

// Includes `polynomial()` in the timed region — see benches/shamir.rs for why.
fn bench_split(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_shamir_split");
    let mut rng = StdRng::seed_from_u64(0);

    for n in SIZES {
        let t = n / 2;
        let ts = TraceableShamir::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);

        group.bench_with_input(BenchmarkId::new("split", n), &secret, |b, &secret| {
            b.iter(|| {
                let poly = ts.polynomial(secret, &mut rng);
                ts.split(&poly).unwrap()
            })
        });
    }

    group.finish();
}

fn bench_compute_tracing_keys(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_shamir_compute_tracing_keys");
    let mut rng = StdRng::seed_from_u64(1);

    for n in SIZES {
        let t = n / 2;
        let ts = TraceableShamir::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);

        group.bench_with_input(
            BenchmarkId::new("compute_tracing_keys", n),
            &poly,
            |b, poly| b.iter(|| ts.compute_tracing_keys(poly).unwrap()),
        );
    }

    group.finish();
}

fn bench_reconstruct(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_shamir_reconstruct");
    let mut rng = StdRng::seed_from_u64(2);

    for n in SIZES {
        let t = n / 2;
        let ts = TraceableShamir::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();

        group.bench_with_input(BenchmarkId::new("reconstruct", n), &shares, |b, shares| {
            b.iter(|| ts.reconstruct(&shares[..ts.threshold()]).unwrap())
        });
    }

    group.finish();
}

// Trace / verify_trace: benchmarked at a couple of (t, n) sizes only — each
// call issues ~16*F*SEC_PARAM/4 synthetic reconstruction queries plus a
// Guruswami-Sudan decode, so this is considerably more expensive than the
// other operations above.
const TRACE_SIZES: [(usize, usize); 2] = [(5, 10), (10, 20)];

fn bench_trace(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_shamir_trace");
    group.sample_size(20);
    let mut rng = StdRng::seed_from_u64(3);

    for (t, n) in TRACE_SIZES {
        let ts = TraceableShamir::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();
        let (tk, _vk) = ts.compute_tracing_keys(&poly).unwrap();
        let corrupted = [Share {
            x: shares[0].x,
            y: shares[0].y,
        }];

        group.bench_with_input(BenchmarkId::new("trace", n), &corrupted, |b, corrupted| {
            b.iter(|| {
                let mut rng = StdRng::seed_from_u64(42);
                ts.trace(&tk, corrupted, &mut rng).unwrap()
            })
        });
    }

    group.finish();
}

fn bench_verify_trace(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_shamir_verify_trace");
    let mut rng = StdRng::seed_from_u64(4);

    for (t, n) in TRACE_SIZES {
        let ts = TraceableShamir::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = ts.polynomial(secret, &mut rng);
        let shares = ts.split(&poly).unwrap();
        let (tk, vk) = ts.compute_tracing_keys(&poly).unwrap();
        let corrupted = [Share {
            x: shares[0].x,
            y: shares[0].y,
        }];
        let (accused, proofs) = ts.trace(&tk, &corrupted, &mut rng).unwrap().unwrap();

        group.bench_with_input(
            BenchmarkId::new("verify_trace", n),
            &(accused, proofs),
            |b, (accused, proofs)| b.iter(|| ts.verify_trace(accused, proofs, &vk).unwrap()),
        );
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_split,
    bench_compute_tracing_keys,
    bench_reconstruct,
    bench_trace,
    bench_verify_trace
);
criterion_main!(benches);

//! Benchmarks for Traceable Bottom-Up Secret Sharing (`TraceableBuss`).

use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion};
use ff::Field;
use midnight_curves::Fq;
use rand::rngs::StdRng;
use rand::SeedableRng;
use sha2::Sha512;

use arc_pleiades::bottom_up::buss::Share;
use arc_pleiades::bottom_up::{BottumUpSS, TraceableBSS};
use arc_pleiades::TraceableBuss;

const SIZES: [usize; 3] = [10, 50, 100];

// Fixed for all tracing-related benchmarks: see benches/traceable_shamir.rs.
const F: usize = 1;
const SEC_PARAM: usize = 4;

fn guardian_shares(n: usize, rng: &mut StdRng) -> Vec<Share<Fq>> {
    let mut xs: Vec<Fq> = Vec::with_capacity(n - 1);
    while xs.len() < n - 1 {
        let x = Fq::random(&mut *rng);
        if x != Fq::ZERO && !xs.contains(&x) {
            xs.push(x);
        }
    }
    xs.into_iter().map(|x| Share { x, y: Fq::random(&mut *rng) }).collect()
}

fn bench_split(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_buss_split");
    let mut rng = StdRng::seed_from_u64(0);

    for n in SIZES {
        let t = n / 2;
        let tbuss = TraceableBuss::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(n, &mut rng);

        group.bench_with_input(BenchmarkId::new("split", n), &shares, |b, shares| {
            b.iter(|| tbuss.split(secret, shares).unwrap())
        });
    }

    group.finish();
}

fn bench_compute_tracing_keys(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_buss_compute_tracing_keys");
    let mut rng = StdRng::seed_from_u64(1);

    for n in SIZES {
        let t = n / 2;
        let tbuss = TraceableBuss::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let shares = guardian_shares(n, &mut rng);

        group.bench_with_input(BenchmarkId::new("compute_tracing_keys", n), &shares, |b, shares| {
            b.iter(|| tbuss.compute_tracing_keys(shares).unwrap())
        });
    }

    group.finish();
}

fn bench_reconstruct(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_buss_reconstruct");
    let mut rng = StdRng::seed_from_u64(2);

    for n in SIZES {
        let t = n / 2;
        let tbuss = TraceableBuss::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(n, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();

        group.bench_with_input(BenchmarkId::new("reconstruct", n), &(phi, shares), |b, (phi, shares)| {
            b.iter(|| tbuss.reconstruct(phi, &shares[..tbuss.threshold()]).unwrap())
        });
    }

    group.finish();
}

fn bench_update_public_shares(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_buss_update_public_shares");
    let mut rng = StdRng::seed_from_u64(5);

    for n in SIZES {
        let t = n / 2;
        let tbuss = TraceableBuss::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(n, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let all_indices: Vec<Fq> = shares.iter().map(|s| s.x).collect();
        let guardian_index = all_indices[0];
        let delta = Fq::random(&mut rng);

        group.bench_with_input(BenchmarkId::new("update_public_shares", n), &phi, |b, phi| {
            b.iter_batched(
                || phi.clone(),
                |mut phi| tbuss.update_public_shares(guardian_index, &all_indices, delta, &mut phi).unwrap(),
                BatchSize::SmallInput,
            )
        });
    }

    group.finish();
}

// Trace / verify_trace: see benches/traceable_shamir.rs for why these are
// benchmarked separately, at fewer sizes, with a reduced sample count.
const TRACE_SIZES: [(usize, usize); 2] = [(5, 10), (10, 20)];

fn bench_trace(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_buss_trace");
    group.sample_size(20);
    let mut rng = StdRng::seed_from_u64(3);

    for (t, n) in TRACE_SIZES {
        let tbuss = TraceableBuss::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(n, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let (tk, _vk) = tbuss.compute_tracing_keys(&shares).unwrap();
        let corrupted = [Share { x: shares[0].x, y: shares[0].y }];

        group.bench_with_input(BenchmarkId::new("trace", n), &(phi, corrupted), |b, (phi, corrupted)| {
            b.iter(|| {
                let mut rng = StdRng::seed_from_u64(42);
                tbuss.trace(&tk, phi, corrupted, &mut rng).unwrap()
            })
        });
    }

    group.finish();
}

fn bench_verify_trace(c: &mut Criterion) {
    let mut group = c.benchmark_group("traceable_buss_verify_trace");
    let mut rng = StdRng::seed_from_u64(4);

    for (t, n) in TRACE_SIZES {
        let tbuss = TraceableBuss::<Sha512>::new(t, n, F, SEC_PARAM).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(n, &mut rng);
        let phi = tbuss.split(secret, &shares).unwrap();
        let (tk, vk) = tbuss.compute_tracing_keys(&shares).unwrap();
        let corrupted = [Share { x: shares[0].x, y: shares[0].y }];
        let (accused, proofs) = tbuss.trace(&tk, &phi, &corrupted, &mut rng).unwrap().unwrap();

        group.bench_with_input(BenchmarkId::new("verify_trace", n), &(accused, proofs), |b, (accused, proofs)| {
            b.iter(|| tbuss.verify_trace(accused, proofs, &vk).unwrap())
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_split,
    bench_compute_tracing_keys,
    bench_reconstruct,
    bench_update_public_shares,
    bench_trace,
    bench_verify_trace
);
criterion_main!(benches);

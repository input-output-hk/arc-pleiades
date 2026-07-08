//! Benchmarks for Shamir Secret Sharing (`ShamirSecretSharing`).

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use ff::Field;
use midnight_curves::Fq;
use rand::rngs::StdRng;
use rand::SeedableRng;

use arc_pleiades::secret_sharing::SecretSharing;
use arc_pleiades::ShamirSecretSharing;

const SIZES: [usize; 3] = [10, 50, 100];

// Includes `polynomial()` in the timed region, not just `split()`. BUSS's
// `split()` has no separate polynomial-construction step to exclude — it
// interpolates the polynomial from guardian shares *and* evaluates it in one
// call — so excluding polynomial generation here would understate Shamir's
// true "secret → shares" cost relative to BUSS's.
fn bench_split(c: &mut Criterion) {
    let mut group = c.benchmark_group("shamir_split");
    let mut rng = StdRng::seed_from_u64(0);

    for n in SIZES {
        let t = n / 2;
        let sss = ShamirSecretSharing::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);

        group.bench_with_input(BenchmarkId::new("split", n), &secret, |b, &secret| {
            b.iter(|| {
                let poly = sss.polynomial(secret, &mut rng);
                sss.split(&poly).unwrap()
            })
        });

        group.bench_with_input(BenchmarkId::new("split_fft", n), &secret, |b, &secret| {
            b.iter(|| {
                let poly = sss.polynomial(secret, &mut rng);
                sss.split_fft(&poly).unwrap()
            })
        });
    }

    group.finish();
}

fn bench_reconstruct(c: &mut Criterion) {
    let mut group = c.benchmark_group("shamir_reconstruct");
    let mut rng = StdRng::seed_from_u64(1);

    for n in SIZES {
        let t = n / 2;
        let sss = ShamirSecretSharing::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = sss.polynomial(secret, &mut rng);
        let shares = sss.split(&poly).unwrap();

        group.bench_with_input(BenchmarkId::new("reconstruct", n), &shares, |b, shares| {
            b.iter(|| sss.reconstruct(&shares[..sss.threshold()]).unwrap())
        });
    }

    group.finish();
}

criterion_group!(benches, bench_split, bench_reconstruct);
criterion_main!(benches);

//! Benchmarks for Feldman Verifiable Secret Sharing (`FeldmanVSS`).

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use ff::Field;
use midnight_curves::{Fq, G1Projective};
use rand::rngs::StdRng;
use rand::SeedableRng;

use arc_pleiades::secret_sharing::{SecretSharing, VerifiableSS};
use arc_pleiades::FeldmanVSS;

const SIZES: [usize; 3] = [10, 50, 100];

// Includes `polynomial()` in the timed region — see benches/shamir.rs for why.
fn bench_split(c: &mut Criterion) {
    let mut group = c.benchmark_group("feldman_split");
    let mut rng = StdRng::seed_from_u64(0);

    for n in SIZES {
        let t = n / 2;
        let vss = FeldmanVSS::<G1Projective>::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);

        group.bench_with_input(BenchmarkId::new("split", n), &secret, |b, &secret| {
            b.iter(|| {
                let poly = vss.polynomial(secret, &mut rng);
                vss.split(&poly).unwrap()
            })
        });
    }

    group.finish();
}

fn bench_compute_verification_key(c: &mut Criterion) {
    let mut group = c.benchmark_group("feldman_compute_verification_key");
    let mut rng = StdRng::seed_from_u64(1);

    for n in SIZES {
        let t = n / 2;
        let vss = FeldmanVSS::<G1Projective>::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = vss.polynomial(secret, &mut rng);

        group.bench_with_input(BenchmarkId::new("compute_verification_key", n), &poly, |b, poly| {
            b.iter(|| vss.compute_verification_key(poly).unwrap())
        });
    }

    group.finish();
}

fn bench_verify_share(c: &mut Criterion) {
    let mut group = c.benchmark_group("feldman_verify_share");
    let mut rng = StdRng::seed_from_u64(2);

    for n in SIZES {
        let t = n / 2;
        let vss = FeldmanVSS::<G1Projective>::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = vss.polynomial(secret, &mut rng);
        let shares = vss.split(&poly).unwrap();
        let vk = vss.compute_verification_key(&poly).unwrap();

        group.bench_with_input(BenchmarkId::new("verify_share", n), &shares[0], |b, share| {
            b.iter(|| vss.verify_share(share, &vk).unwrap())
        });
    }

    group.finish();
}

fn bench_reconstruct(c: &mut Criterion) {
    let mut group = c.benchmark_group("feldman_reconstruct");
    let mut rng = StdRng::seed_from_u64(3);

    for n in SIZES {
        let t = n / 2;
        let vss = FeldmanVSS::<G1Projective>::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);
        let poly = vss.polynomial(secret, &mut rng);
        let shares = vss.split(&poly).unwrap();

        group.bench_with_input(BenchmarkId::new("reconstruct", n), &shares, |b, shares| {
            b.iter(|| vss.reconstruct(&shares[..vss.threshold()]).unwrap())
        });
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_split,
    bench_compute_verification_key,
    bench_verify_share,
    bench_reconstruct
);
criterion_main!(benches);

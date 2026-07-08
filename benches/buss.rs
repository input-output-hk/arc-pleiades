//! Benchmarks for Bottom-Up Secret Sharing (`BottomUpSSS` / ANARKey).

use criterion::{criterion_group, criterion_main, BatchSize, BenchmarkId, Criterion};
use ff::Field;
use midnight_curves::Fq;
use rand::rngs::StdRng;
use rand::SeedableRng;

use arc_pleiades::bottom_up::buss::Share;
use arc_pleiades::bottom_up::BottumUpSS;
use arc_pleiades::BottomUpSSS;

const SIZES: [usize; 3] = [10, 50, 100];

fn guardian_shares(n: usize, rng: &mut StdRng) -> Vec<Share<Fq>> {
    (1..n)
        .map(|j| Share {
            x: Fq::from(j as u64),
            y: Fq::random(&mut *rng),
        })
        .collect()
}

fn bench_split(c: &mut Criterion) {
    let mut group = c.benchmark_group("buss_split");
    let mut rng = StdRng::seed_from_u64(0);

    for n in SIZES {
        let t = n / 2;
        let buss = BottomUpSSS::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(n, &mut rng);

        group.bench_with_input(BenchmarkId::new("split", n), &shares, |b, shares| {
            b.iter(|| buss.split(secret, shares).unwrap())
        });
    }

    group.finish();
}

fn bench_reconstruct(c: &mut Criterion) {
    let mut group = c.benchmark_group("buss_reconstruct");
    let mut rng = StdRng::seed_from_u64(1);

    for n in SIZES {
        let t = n / 2;
        let buss = BottomUpSSS::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(n, &mut rng);
        let phi = buss.split(secret, &shares).unwrap();

        group.bench_with_input(
            BenchmarkId::new("reconstruct", n),
            &(phi, shares),
            |b, (phi, shares)| {
                b.iter(|| buss.reconstruct(phi, &shares[..buss.threshold()]).unwrap())
            },
        );
    }

    group.finish();
}

fn bench_update_public_shares(c: &mut Criterion) {
    let mut group = c.benchmark_group("buss_update_public_shares");
    let mut rng = StdRng::seed_from_u64(2);

    for n in SIZES {
        let t = n / 2;
        let buss = BottomUpSSS::new(t, n).unwrap();
        let secret = Fq::random(&mut rng);
        let shares = guardian_shares(n, &mut rng);
        let phi = buss.split(secret, &shares).unwrap();
        let all_indices: Vec<Fq> = shares.iter().map(|s| s.x).collect();
        let guardian_index = all_indices[0];
        let delta = Fq::random(&mut rng);

        group.bench_with_input(
            BenchmarkId::new("update_public_shares", n),
            &phi,
            |b, phi| {
                b.iter_batched(
                    || phi.clone(),
                    |mut phi| {
                        buss.update_public_shares(guardian_index, &all_indices, delta, &mut phi)
                            .unwrap()
                    },
                    BatchSize::SmallInput,
                )
            },
        );
    }

    group.finish();
}

criterion_group!(
    benches,
    bench_split,
    bench_reconstruct,
    bench_update_public_shares
);
criterion_main!(benches);

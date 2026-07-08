use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use midnight_curves::Fq;
use rand::rngs::StdRng;
use rand::SeedableRng;

use arc_pleiades::Polynomial;

// ── Evaluation: Horner (O(k · degree)) vs FFT (O(k log k)) ──────────────────
//
// For a degree-(k−1) polynomial (k coefficients), evaluate at k points.
//   - horner: k sequential calls to poly.eval(x_i) at integer x-coords
//   - fft:    one poly.eval_fft() call over the entire k-th root-of-unity domain
//
// k is kept to powers of two so eval_fft uses domain size exactly k.

fn bench_eval(c: &mut Criterion) {
    let mut group = c.benchmark_group("poly_eval");
    let mut rng = StdRng::seed_from_u64(0);

    for k in [4usize, 8, 16, 32, 64, 128, 256, 512, 1024] {
        let poly: Polynomial<Fq> =
            Polynomial::random_with_secret(Fq::from(42_u64), k - 1, &mut rng);

        // Horner: evaluate at x = 1, 2, …, k  (k evaluations, each O(degree))
        group.bench_with_input(BenchmarkId::new("horner", k), &poly, |b, p| {
            b.iter(|| {
                (1..=k)
                    .map(|i| p.eval(Fq::from(i as u64)))
                    .collect::<Vec<_>>()
            })
        });

        // FFT: evaluate at ω^0, …, ω^{k−1} in one O(k log k) pass
        group.bench_with_input(BenchmarkId::new("fft", k), &poly, |b, p| {
            b.iter(|| p.eval_fft())
        });
    }

    group.finish();
}

// ── Interpolation: Lagrange (O(k²)) vs iFFT (O(k log k)) ────────────────────
//
// Given k evaluation points, recover the full polynomial.
//   - lagrange:  Polynomial::interpolate with arbitrary (integer) x-coords
//   - from_fft:  Polynomial::from_evals_fft, which runs an iFFT on evaluations
//                at roots of unity (produced by eval_fft in setup)
//
// k is kept to powers of two so eval_fft / from_evals_fft use domain size k.

fn bench_interpolate(c: &mut Criterion) {
    let mut group = c.benchmark_group("poly_interpolate");
    let mut rng = StdRng::seed_from_u64(1);

    for k in [4usize, 8, 16, 32, 64, 128, 256] {
        let poly: Polynomial<Fq> =
            Polynomial::random_with_secret(Fq::from(99_u64), k - 1, &mut rng);

        // Lagrange: evaluate at integer x-coords, then interpolate.
        let lagrange_pts: Vec<(Fq, Fq)> = (1..=k)
            .map(|i| {
                let x = Fq::from(i as u64);
                (x, poly.eval(x))
            })
            .collect();

        group.bench_with_input(BenchmarkId::new("lagrange", k), &lagrange_pts, |b, pts| {
            b.iter(|| Polynomial::<Fq>::interpolate(pts).unwrap())
        });

        // iFFT: evaluate at roots of unity (eval_fft), then invert with from_evals_fft.
        // eval_fft uses domain size k (next power of two ≥ k coefficients = k).
        let (evals, _) = poly.eval_fft();

        group.bench_with_input(BenchmarkId::new("from_fft", k), &evals, |b, evs| {
            b.iter(|| Polynomial::<Fq>::from_evals_fft(evs))
        });
    }

    group.finish();
}

criterion_group!(benches, bench_eval, bench_interpolate);
criterion_main!(benches);

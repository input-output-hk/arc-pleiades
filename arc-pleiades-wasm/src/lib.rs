use arc_pleiades::bottom_up::buss::{guardian_share, key_update_delta, Share as BussShare};
use arc_pleiades::bottom_up::traceable_buss::TracingKey as TBussTracingKey;
use arc_pleiades::bottom_up::{BottumUpSS, TraceableBSS};
use arc_pleiades::secret_sharing::feldman::Share as FeldmanShare;
use arc_pleiades::secret_sharing::shamir::Share as ShamirShare;
use arc_pleiades::secret_sharing::traceable_shamir::{
    Share as TsShare, TracingKey as TsTracingKey,
};
use arc_pleiades::secret_sharing::{SecretSharing, TraceableSS, VerifiableSS};
use arc_pleiades::{BottomUpSSS, FeldmanVSS, ShamirSecretSharing, TraceableBuss, TraceableShamir};
use ff::{Field, PrimeField};
use group::GroupEncoding;
use midnight_curves::{Fq, G1Projective};
use rand_chacha::ChaCha20Rng;
use rand_core::SeedableRng;
use serde::{Deserialize, Serialize};
use sha2::Sha512;
use wasm_bindgen::prelude::*;

// ── Field element helpers ──────────────────────────────────────────────────────

fn rng(seed: &[u8]) -> ChaCha20Rng {
    let mut arr = [0u8; 32];
    let n = seed.len().min(32);
    arr[..n].copy_from_slice(&seed[..n]);
    ChaCha20Rng::from_seed(arr)
}

fn to_hex<F: PrimeField>(f: F) -> String {
    hex::encode(f.to_repr().as_ref())
}

fn from_hex<F: PrimeField>(s: &str) -> Option<F> {
    let bytes = hex::decode(s).ok()?;
    let mut repr = F::Repr::default();
    let dst = repr.as_mut();
    if bytes.len() != dst.len() {
        return None;
    }
    dst.copy_from_slice(&bytes);
    Option::<F>::from(F::from_repr(repr))
}

fn parse_hex<F: PrimeField>(s: &str, what: &str) -> Result<F, JsError> {
    from_hex(s).ok_or_else(|| JsError::new(&format!("bad {what}")))
}

fn to_hex_point<G: GroupEncoding>(p: G) -> String {
    hex::encode(p.to_bytes().as_ref())
}

fn parse_hex_point<G: GroupEncoding>(s: &str, what: &str) -> Result<G, JsError> {
    let bytes = hex::decode(s).map_err(|_| JsError::new(&format!("bad {what}")))?;
    let mut repr = G::Repr::default();
    if bytes.len() != repr.as_ref().len() {
        return Err(JsError::new(&format!("bad {what}")));
    }
    repr.as_mut().copy_from_slice(&bytes);
    Option::<G>::from(G::from_bytes(&repr)).ok_or_else(|| JsError::new(&format!("bad {what}")))
}

/// Recover the u64 value from a small field element (little-endian first 8 bytes).
fn to_u64<F: PrimeField>(f: F) -> u64 {
    let repr = f.to_repr();
    let bytes = repr.as_ref();
    let mut arr = [0u8; 8];
    arr.copy_from_slice(&bytes[..8]);
    u64::from_le_bytes(arr)
}

/// Fixed security parameter for demo purposes — `TraceableShamir`/`TraceableBuss`
/// only use this (together with `f`) to size the number of oracle queries
/// inside `trace()`; it isn't exposed as a UI control.
const DEMO_SEC_PARAM: usize = 4;

// ── Serialisable share type ───────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct WasmShare {
    pub x: String, // hex-encoded Fq
    pub y: String, // hex-encoded Fq
}

// ── Shamir ────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
struct ShamirSplitResult {
    shares: Vec<WasmShare>,
    coefficients: Vec<String>, // hex of a_1, …, a_t (constant term a_0 = secret excluded)
}

/// Split `secret` (a small integer ≤ 2^53) into n−1 shares with threshold t+1.
/// Builds f(x) = secret + a₁x + … + aₜxᵗ with random aᵢ, evaluates at x=1…n-1.
/// Returns `{ shares: [{x,y}], coefficients: [hex] }`.
/// `seed` must be 32 bytes from `crypto.getRandomValues`.
#[wasm_bindgen]
pub fn shamir_split(secret: u64, t: usize, n: usize, seed: &[u8]) -> Result<JsValue, JsError> {
    if n < t + 2 {
        return Err(JsError::new("n must be >= t+2"));
    }
    let mut rng = rng(seed);
    let s = Fq::from(secret);

    // f(x) = s + a_1*x + ... + a_t*x^t
    let coeffs: Vec<Fq> = std::iter::once(s)
        .chain((0..t).map(|_| Fq::random(&mut rng)))
        .collect();

    // Evaluate at x = 1, 2, ..., n-1 via Horner's method
    let shares: Vec<WasmShare> = (1..n)
        .map(|i| {
            let x = Fq::from(i as u64);
            let y = coeffs
                .iter()
                .rev()
                .fold(Fq::from(0u64), |acc, &c| acc * x + c);
            WasmShare {
                x: to_hex(x),
                y: to_hex(y),
            }
        })
        .collect();

    let result = ShamirSplitResult {
        shares,
        coefficients: coeffs[1..].iter().map(|c| to_hex(*c)).collect(),
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

/// Reconstruct the secret from `t+1` or more shares (JSON array of `{x,y}`).
/// Returns the secret as a `u64` (works for secrets ≤ 2^53).
#[wasm_bindgen]
pub fn shamir_reconstruct(shares_json: &str, t: usize, n: usize) -> Result<u64, JsError> {
    let raw: Vec<WasmShare> =
        serde_json::from_str(shares_json).map_err(|e| JsError::new(&e.to_string()))?;
    let shares: Vec<ShamirShare<Fq>> = raw
        .iter()
        .map(|s| -> Result<ShamirShare<Fq>, JsError> {
            Ok(ShamirShare {
                x: parse_hex(&s.x, "share x")?,
                y: parse_hex(&s.y, "share y")?,
            })
        })
        .collect::<Result<_, _>>()?;
    let sss = ShamirSecretSharing::new(t, n).map_err(|e| JsError::new(&e.to_string()))?;
    let secret = sss
        .reconstruct(&shares)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(to_u64(secret))
}

// ── Feldman VSS ───────────────────────────────────────────────────────────────
//
// Same (t+1)-of-(n−1), x=1..n−1 convention as plain Shamir — only the
// commitment/verification layer is new. `vk` is the list of G1 commitments
// C_j = a_j·G to the secret polynomial's coefficients (degree t, so t+1
// entries); `verify_share` checks g^{f(x)} = Π C_j·x^j without learning f(x).

#[derive(Serialize)]
struct FeldmanSplitResult {
    shares: Vec<WasmShare>,
    vk: Vec<String>, // hex-encoded G1 commitments C_0, …, C_t
}

/// Split into Feldman-verifiable shares.  Returns `{ shares, vk }`.
#[wasm_bindgen]
pub fn feldman_split(secret: u64, t: usize, n: usize, seed: &[u8]) -> Result<JsValue, JsError> {
    let mut rng = rng(seed);
    let s = Fq::from(secret);
    let vss = FeldmanVSS::<G1Projective>::new(t, n).map_err(|e| JsError::new(&e.to_string()))?;
    let poly = vss.polynomial(s, &mut rng);
    let shares = vss.split(&poly).map_err(|e| JsError::new(&e.to_string()))?;
    let vk = vss
        .compute_verification_key(&poly)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let result = FeldmanSplitResult {
        shares: shares
            .iter()
            .map(|s| WasmShare {
                x: to_hex(s.x),
                y: to_hex(s.y),
            })
            .collect(),
        vk: vk.into_iter().map(to_hex_point).collect(),
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

/// Check a single share against the public commitments `vk`.
/// Returns `true`/`false` rather than throwing — a failed check is an
/// expected outcome, not an error.
#[wasm_bindgen]
pub fn feldman_verify_share(
    share_json: &str,
    vk_json: &str,
    t: usize,
    n: usize,
) -> Result<bool, JsError> {
    let s: WasmShare =
        serde_json::from_str(share_json).map_err(|e| JsError::new(&e.to_string()))?;
    let share = FeldmanShare {
        x: parse_hex(&s.x, "share x")?,
        y: parse_hex(&s.y, "share y")?,
    };

    let vk_raw: Vec<String> =
        serde_json::from_str(vk_json).map_err(|e| JsError::new(&e.to_string()))?;
    let vk: Vec<G1Projective> = vk_raw
        .iter()
        .map(|h| parse_hex_point(h, "vk entry"))
        .collect::<Result<_, _>>()?;

    let vss = FeldmanVSS::<G1Projective>::new(t, n).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(vss.verify_share(&share, &vk).is_ok())
}

/// Reconstruct the secret from `t+1` or more Feldman shares.
#[wasm_bindgen]
pub fn feldman_reconstruct(shares_json: &str, t: usize, n: usize) -> Result<u64, JsError> {
    let raw: Vec<WasmShare> =
        serde_json::from_str(shares_json).map_err(|e| JsError::new(&e.to_string()))?;
    let shares: Vec<FeldmanShare<Fq>> = raw
        .iter()
        .map(|s| -> Result<FeldmanShare<Fq>, JsError> {
            Ok(FeldmanShare {
                x: parse_hex(&s.x, "share x")?,
                y: parse_hex(&s.y, "share y")?,
            })
        })
        .collect::<Result<_, _>>()?;
    let vss = FeldmanVSS::<G1Projective>::new(t, n).map_err(|e| JsError::new(&e.to_string()))?;
    let secret = vss
        .reconstruct(&shares)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(to_u64(secret))
}

// ── Traceable Shamir ──────────────────────────────────────────────────────────
//
// The demo's (t, n) sliders follow the same "t+1-of-(n−1)" convention as plain
// Shamir (§ shamir_split above): `n − 1` guardians receive shares, `t + 1` of
// them are needed to reconstruct. `TraceableShamir` itself is a genuine
// t-out-of-n scheme (no reserved owner slot — all n parties get real shares),
// so every call here maps `threshold = t + 1`, `parties = n − 1` before
// constructing it.

/// A `TraceableShamir` instance only needs a valid `f` (0 < f ≤ actual corrupt
/// count for `trace`, 0 < f < threshold for the constructor) when `trace()` is
/// actually called — `split`/`reconstruct`/`compute_tracing_keys` never read
/// `self.f`. `split`/`reconstruct` use this placeholder so construction always
/// succeeds regardless of how many parties will later be marked corrupt.
const DEMO_PLACEHOLDER_F: usize = 1;

#[derive(Serialize)]
struct TsSplitResult {
    shares: Vec<WasmShare>, // (x_i, q(x_i)) — random evaluation points
    tk: Vec<String>,        // tracing/verification key: hash(x_i) per party, hex
}

/// Split into traceable shares.  Returns `{ shares, tk }`.
#[wasm_bindgen]
pub fn ts_split(secret: u64, t: usize, n: usize, seed: &[u8]) -> Result<JsValue, JsError> {
    let mut rng = rng(seed);
    let s = Fq::from(secret);
    let ts = TraceableShamir::<Sha512>::new(t + 1, n - 1, DEMO_PLACEHOLDER_F, DEMO_SEC_PARAM)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let poly = ts.polynomial(s, &mut rng);
    let shares = ts.split(&poly).map_err(|e| JsError::new(&e.to_string()))?;
    let (_tk_secret, tk_public) = ts
        .compute_tracing_keys(&poly)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let result = TsSplitResult {
        shares: shares
            .iter()
            .map(|s| WasmShare {
                x: to_hex(s.x),
                y: to_hex(s.y),
            })
            .collect(),
        tk: tk_public.0.iter().map(|&x| to_hex(x)).collect(),
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

/// Reconstruct from traceable shares.
#[wasm_bindgen]
pub fn ts_reconstruct(shares_json: &str, t: usize, n: usize) -> Result<u64, JsError> {
    let raw: Vec<WasmShare> =
        serde_json::from_str(shares_json).map_err(|e| JsError::new(&e.to_string()))?;
    let shares: Vec<TsShare<Fq>> = raw
        .iter()
        .map(|s| -> Result<TsShare<Fq>, JsError> {
            Ok(TsShare {
                x: parse_hex(&s.x, "share x")?,
                y: parse_hex(&s.y, "share y")?,
            })
        })
        .collect::<Result<_, _>>()?;
    let ts = TraceableShamir::<Sha512>::new(t + 1, n - 1, DEMO_PLACEHOLDER_F, DEMO_SEC_PARAM)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let secret = ts
        .reconstruct(&shares)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(to_u64(secret))
}

#[derive(Serialize)]
struct TraceResult {
    accused: Vec<usize>, // 1-based party indices, matching the demo's guardian numbering
    witness: Vec<String>,
}

/// Trace corrupt parties from their leaked shares.
///
/// `corrupt_json`: JSON array of 0-based indices into `shares_json` — these
/// parties' shares are handed to `trace` directly (no reconstruction-box
/// closure — `trace` internally reconstructs with fresh synthetic probes).
#[wasm_bindgen]
pub fn ts_trace(
    shares_json: &str,
    tk_json: &str,
    corrupt_json: &str,
    t: usize,
    n: usize,
    seed: &[u8],
) -> Result<JsValue, JsError> {
    let mut rng = rng(seed);

    let raw: Vec<WasmShare> =
        serde_json::from_str(shares_json).map_err(|e| JsError::new(&e.to_string()))?;
    let all_shares: Vec<TsShare<Fq>> = raw
        .iter()
        .map(|s| -> Result<TsShare<Fq>, JsError> {
            Ok(TsShare {
                x: parse_hex(&s.x, "share x")?,
                y: parse_hex(&s.y, "share y")?,
            })
        })
        .collect::<Result<_, _>>()?;

    let tk_raw: Vec<String> =
        serde_json::from_str(tk_json).map_err(|e| JsError::new(&e.to_string()))?;
    let tk_vals: Vec<Fq> = tk_raw
        .iter()
        .map(|h| parse_hex(h, "tk entry"))
        .collect::<Result<_, _>>()?;
    let tk_public = TsTracingKey(tk_vals);

    let corrupt_idx: Vec<usize> =
        serde_json::from_str(corrupt_json).map_err(|e| JsError::new(&e.to_string()))?;
    let corrupted: Vec<TsShare<Fq>> = corrupt_idx
        .iter()
        .map(|&i| TsShare {
            x: all_shares[i].x,
            y: all_shares[i].y,
        })
        .collect();

    let f = corrupted.len();
    let ts = TraceableShamir::<Sha512>::new(t + 1, n - 1, f, DEMO_SEC_PARAM)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let (accused, witness) = ts
        .trace(&tk_public, &corrupted, &mut rng)
        .map_err(|e| JsError::new(&e.to_string()))?
        .ok_or_else(|| {
            JsError::new("tracing failed: no candidate polynomial matched the trace key")
        })?;
    ts.verify_trace(&accused, &witness, &tk_public)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let result = TraceResult {
        accused: accused.iter().map(|&i| i + 1).collect(),
        witness: witness.iter().map(|&w| to_hex(w)).collect(),
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

// ── BUSS ──────────────────────────────────────────────────────────────────────

const DEMO_OWNER_ID: &[u8] = b"pleiades-demo";

#[derive(Serialize)]
struct BussSetupResult {
    phi: Vec<String>,
    guardian_sks: Vec<String>,
    sigmas: Vec<String>,
}

/// Generate n−1 random guardian keys, compute their σ values and φ.
/// Returns `{ phi, guardian_sks, sigmas }`.
#[wasm_bindgen]
pub fn buss_setup(secret: u64, t: usize, n: usize, seed: &[u8]) -> Result<JsValue, JsError> {
    let mut rng = rng(seed);
    let s = Fq::from(secret);
    let buss = BottomUpSSS::new(t, n).map_err(|e| JsError::new(&e.to_string()))?;

    let guardian_sks: Vec<Fq> = (0..buss.num_shares())
        .map(|_| Fq::random(&mut rng))
        .collect();
    let sigma_b: Vec<BussShare<Fq>> = guardian_sks
        .iter()
        .enumerate()
        .map(|(i, &sk)| BussShare {
            x: Fq::from((i + 1) as u64),
            y: guardian_share::<Fq, Sha512>(DEMO_OWNER_ID, sk),
        })
        .collect();

    let phi = buss
        .split(s, &sigma_b)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let result = BussSetupResult {
        phi: phi.iter().map(|s| to_hex(s.y)).collect(),
        guardian_sks: guardian_sks.iter().map(|&f| to_hex(f)).collect(),
        sigmas: sigma_b.iter().map(|s| to_hex(s.y)).collect(),
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

#[derive(Deserialize)]
struct GuardianEntry {
    index: usize,
    sk: String,
}

/// Reconstruct the secret from φ and t+1 guardian secret keys.
/// `selected_json`: JSON array of `{index, sk}` (index is 1-based).
#[wasm_bindgen]
pub fn buss_reconstruct(
    phi_json: &str,
    selected_json: &str,
    t: usize,
    n: usize,
) -> Result<u64, JsError> {
    let phi_raw: Vec<String> =
        serde_json::from_str(phi_json).map_err(|e| JsError::new(&e.to_string()))?;
    let phi: Vec<BussShare<Fq>> = phi_raw
        .iter()
        .enumerate()
        .map(|(i, h)| -> Result<BussShare<Fq>, JsError> {
            Ok(BussShare {
                x: -Fq::from((i + 1) as u64),
                y: parse_hex(h, "phi entry")?,
            })
        })
        .collect::<Result<_, _>>()?;

    let selected: Vec<GuardianEntry> =
        serde_json::from_str(selected_json).map_err(|e| JsError::new(&e.to_string()))?;
    let sigma_r: Vec<BussShare<Fq>> = selected
        .iter()
        .map(|g| -> Result<BussShare<Fq>, JsError> {
            let sk = parse_hex(&g.sk, "guardian sk")?;
            Ok(BussShare {
                x: Fq::from(g.index as u64),
                y: guardian_share::<Fq, Sha512>(DEMO_OWNER_ID, sk),
            })
        })
        .collect::<Result<_, _>>()?;

    let buss = BottomUpSSS::new(t, n).map_err(|e| JsError::new(&e.to_string()))?;
    let secret = buss
        .reconstruct(&phi, &sigma_r)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(to_u64(secret))
}

#[derive(Serialize)]
struct BussRotateResult {
    phi: Vec<String>,
    new_sk: String,
    new_sigma: String,
}

/// Rotate guardian `guardian_index` (1-based): generate a fresh key from `new_sk_seed`,
/// update φ, and return `{ phi, new_sk, new_sigma }`.
#[wasm_bindgen]
pub fn buss_rotate(
    phi_json: &str,
    guardian_index: usize,
    n: usize,
    old_sk_hex: &str,
    new_sk_seed: &[u8],
) -> Result<JsValue, JsError> {
    let phi_raw: Vec<String> =
        serde_json::from_str(phi_json).map_err(|e| JsError::new(&e.to_string()))?;
    let mut phi: Vec<BussShare<Fq>> = phi_raw
        .iter()
        .enumerate()
        .map(|(i, h)| -> Result<BussShare<Fq>, JsError> {
            Ok(BussShare {
                x: -Fq::from((i + 1) as u64),
                y: parse_hex(h, "phi entry")?,
            })
        })
        .collect::<Result<_, _>>()?;

    let old_sk: Fq = parse_hex(old_sk_hex, "old_sk")?;
    let new_sk = Fq::random(&mut rng(new_sk_seed));

    let phi_len = phi.len();
    if phi_len == 0 || phi_len + 1 >= n {
        return Err(JsError::new("invalid phi length for given n"));
    }
    let t = n - phi_len - 1;

    let buss = BottomUpSSS::new(t, n).map_err(|e| JsError::new(&e.to_string()))?;
    let all_indices: Vec<Fq> = (1..=buss.num_shares())
        .map(|j| Fq::from(j as u64))
        .collect();

    let delta = key_update_delta::<Fq, Sha512>(DEMO_OWNER_ID, old_sk, new_sk);
    buss.update_public_shares(
        Fq::from(guardian_index as u64),
        &all_indices,
        delta,
        &mut phi,
    )
    .map_err(|e| JsError::new(&e.to_string()))?;

    let new_sigma = guardian_share::<Fq, Sha512>(DEMO_OWNER_ID, new_sk);

    let result = BussRotateResult {
        phi: phi.iter().map(|s| to_hex(s.y)).collect(),
        new_sk: to_hex(new_sk),
        new_sigma: to_hex(new_sigma),
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

// ── Traceable BUSS ────────────────────────────────────────────────────────────
//
// Unlike plain BUSS, each guardian here picks their OWN random evaluation
// point x_j (not the fixed integer j), so φ entries and guardian shares alike
// need to carry both `x` and `y`. `TraceableBuss` shares plain BUSS's (t, n)
// convention directly (no ±1 remapping needed, unlike TraceableShamir above).

/// See [`DEMO_PLACEHOLDER_F`] — same rationale, `TraceableBuss::split`/
/// `reconstruct`/`compute_tracing_keys` never read `self.f`.
const DEMO_TBUSS_PLACEHOLDER_F: usize = 1;

#[derive(Serialize)]
struct TBussSetupResult {
    shares: Vec<WasmShare>, // (x_j, σ_j) per guardian
    phi: Vec<WasmShare>,    // public backup — (x, q(x)) pairs
    guardian_sks: Vec<String>,
    vk: Vec<String>, // tracing/verification key: hash(x_j) per guardian, hex
}

/// Split into traceable BUSS shares.  Returns `{ shares, phi, guardian_sks, vk }`.
#[wasm_bindgen]
pub fn tbuss_split(secret: u64, t: usize, n: usize, seed: &[u8]) -> Result<JsValue, JsError> {
    let mut rng = rng(seed);
    let s = Fq::from(secret);
    let tbuss = TraceableBuss::<Sha512>::new(t, n, DEMO_TBUSS_PLACEHOLDER_F, DEMO_SEC_PARAM)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let num_guardians = n - 1;
    let guardian_sks: Vec<Fq> = (0..num_guardians).map(|_| Fq::random(&mut rng)).collect();

    let mut xs: Vec<Fq> = Vec::with_capacity(num_guardians);
    while xs.len() < num_guardians {
        let x = Fq::random(&mut rng);
        if x != Fq::ZERO && !xs.contains(&x) {
            xs.push(x);
        }
    }
    let shares: Vec<BussShare<Fq>> = xs
        .iter()
        .zip(&guardian_sks)
        .map(|(&x, &sk)| BussShare {
            x,
            y: guardian_share::<Fq, Sha512>(DEMO_OWNER_ID, sk),
        })
        .collect();

    let phi = tbuss
        .split(s, &shares)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let (_sk_key, vk) = tbuss
        .compute_tracing_keys(&shares)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let result = TBussSetupResult {
        shares: shares
            .iter()
            .map(|s| WasmShare {
                x: to_hex(s.x),
                y: to_hex(s.y),
            })
            .collect(),
        phi: phi
            .iter()
            .map(|s| WasmShare {
                x: to_hex(s.x),
                y: to_hex(s.y),
            })
            .collect(),
        guardian_sks: guardian_sks.iter().map(|&sk| to_hex(sk)).collect(),
        vk: vk.0.iter().map(|&v| to_hex(v)).collect(),
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

/// Reconstruct the secret from φ and t+1 guardian shares (JSON arrays of `{x,y}`).
#[wasm_bindgen]
pub fn tbuss_reconstruct(
    phi_json: &str,
    selected_json: &str,
    t: usize,
    n: usize,
) -> Result<u64, JsError> {
    let phi_raw: Vec<WasmShare> =
        serde_json::from_str(phi_json).map_err(|e| JsError::new(&e.to_string()))?;
    let phi: Vec<BussShare<Fq>> = phi_raw
        .iter()
        .map(|s| -> Result<BussShare<Fq>, JsError> {
            Ok(BussShare {
                x: parse_hex(&s.x, "phi x")?,
                y: parse_hex(&s.y, "phi y")?,
            })
        })
        .collect::<Result<_, _>>()?;

    let selected_raw: Vec<WasmShare> =
        serde_json::from_str(selected_json).map_err(|e| JsError::new(&e.to_string()))?;
    let selected: Vec<BussShare<Fq>> = selected_raw
        .iter()
        .map(|s| -> Result<BussShare<Fq>, JsError> {
            Ok(BussShare {
                x: parse_hex(&s.x, "share x")?,
                y: parse_hex(&s.y, "share y")?,
            })
        })
        .collect::<Result<_, _>>()?;

    let tbuss = TraceableBuss::<Sha512>::new(t, n, DEMO_TBUSS_PLACEHOLDER_F, DEMO_SEC_PARAM)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let secret = tbuss
        .reconstruct(&phi, &selected)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(to_u64(secret))
}

/// Trace corrupt guardians from their leaked shares.
///
/// `corrupt_json`: JSON array of 0-based indices into `shares_json`.
#[wasm_bindgen]
pub fn tbuss_trace(
    shares_json: &str,
    phi_json: &str,
    vk_json: &str,
    corrupt_json: &str,
    t: usize,
    n: usize,
    seed: &[u8],
) -> Result<JsValue, JsError> {
    let mut rng = rng(seed);

    let shares_raw: Vec<WasmShare> =
        serde_json::from_str(shares_json).map_err(|e| JsError::new(&e.to_string()))?;
    let all_shares: Vec<BussShare<Fq>> = shares_raw
        .iter()
        .map(|s| -> Result<BussShare<Fq>, JsError> {
            Ok(BussShare {
                x: parse_hex(&s.x, "share x")?,
                y: parse_hex(&s.y, "share y")?,
            })
        })
        .collect::<Result<_, _>>()?;

    let phi_raw: Vec<WasmShare> =
        serde_json::from_str(phi_json).map_err(|e| JsError::new(&e.to_string()))?;
    let phi: Vec<BussShare<Fq>> = phi_raw
        .iter()
        .map(|s| -> Result<BussShare<Fq>, JsError> {
            Ok(BussShare {
                x: parse_hex(&s.x, "phi x")?,
                y: parse_hex(&s.y, "phi y")?,
            })
        })
        .collect::<Result<_, _>>()?;

    let vk_raw: Vec<String> =
        serde_json::from_str(vk_json).map_err(|e| JsError::new(&e.to_string()))?;
    let vk = TBussTracingKey(
        vk_raw
            .iter()
            .map(|h| parse_hex(h, "vk entry"))
            .collect::<Result<_, JsError>>()?,
    );

    let corrupt_idx: Vec<usize> =
        serde_json::from_str(corrupt_json).map_err(|e| JsError::new(&e.to_string()))?;
    let corrupted: Vec<BussShare<Fq>> = corrupt_idx
        .iter()
        .map(|&i| BussShare {
            x: all_shares[i].x,
            y: all_shares[i].y,
        })
        .collect();

    let f = corrupted.len();
    let tbuss = TraceableBuss::<Sha512>::new(t, n, f.max(1), DEMO_SEC_PARAM)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let (accused, witness) = tbuss
        .trace(&vk, &phi, &corrupted, &mut rng)
        .map_err(|e| JsError::new(&e.to_string()))?
        .ok_or_else(|| {
            JsError::new("tracing failed: no candidate polynomial matched the trace key")
        })?;
    tbuss
        .verify_trace(&accused, &witness, &vk)
        .map_err(|e| JsError::new(&e.to_string()))?;

    let result = TraceResult {
        accused: accused.iter().map(|&i| i + 1).collect(),
        witness: witness.iter().map(|&w| to_hex(w)).collect(),
    };
    serde_wasm_bindgen::to_value(&result).map_err(|e| JsError::new(&e.to_string()))
}

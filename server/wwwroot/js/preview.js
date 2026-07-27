//
// preview.js — Blender-style LIVE PREVIEW of the TPMS lattice.
//
// A GPU raymarch of the SAME implicit field the worker bakes, drawn inside a box
// proxy at the target part's bbox. Scrubbing a LATTICE parameter rewrites a
// uniform, so cells grow/shrink frame-to-frame with no server round trip.
//
// THIS IS AN APPROXIMATION, deliberately. The bake (GENERATE) stays the ground
// truth for export, watertightness and every metric. The preview differs from it
// in three known ways:
//   1. no voxelisation — the analytic field is sampled directly, so it shows
//      detail a coarse RESOLUTION would swallow;
//   2. no smoothing offset, no island cleanup, no fuse overlap;
//   3. the part clip is a sampled distance field (or, until that field exists,
//      the part's bounding box) rather than the exact voxelised solid.
//
// ── Field ───────────────────────────────────────────────────────────────
//   F(p) = max( partSDF(p_local), lattice(p_world) [, sectionHalfSpace(p_world)] )
// Solid is F < 0. The lattice half is a LINE-FOR-LINE port of worker/TPMSWall.cs
// (see latticeF below); the part half is a Data3DTexture of the part-local
// distance field served by /api/parts/{id}/sdf.* — part-LOCAL, so dragging the
// part with the gizmo only changes the inverse-model uniform and never re-bakes.
//
// ── Frames ──────────────────────────────────────────────────────────────
// The voxel engine is world-anchored, so the LATTICE is evaluated in WORLD space
// (rotation about the target's world bbox centre, exactly as GyroidJob passes
// `mshPart.oBoundingBox().vecCenter()` into TPMSWall). The PART CLIP is evaluated
// in PART-LOCAL space through the inverse of the part's TRS. Both points are
// carried along the ray at once, so neither needs a per-step matrix multiply.
//
import * as THREE from 'three';
import * as api from './api.js';

// Pattern enum, mirroring TPMSWall.EFn's order and the <select> values.
const PATTERN_ID = { gyroid: 0, schwarzP: 1, schwarzD: 2, lidinoid: 3, neovius: 4 };

// Extremes of the RAW pattern value f (before TPMSWall's /grad), per pattern, in
// TPMSWall.EFn order. These bound the whole field: |f|/grad can never exceed
// max/grad, so a threshold past that point makes the lattice SOLID EVERYWHERE
// (sheet) or, in skeletal, either solid everywhere or empty everywhere.
//
//   gyroid    sin x cos y + sin y cos z + sin z cos x            +-3/2
//   schwarzP  cos x + cos y + cos z                              +-3
//   schwarzD  the four-term sin/cos form TPMSWall uses           +-sqrt(2)
//   lidinoid  (with its +0.15 constant, so it is ASYMMETRIC)     +1.15 / -1.35
//   neovius   3*(cx+cy+cz) + 4*cx*cy*cz                          +-13
//
// schwarzP, neovius and lidinoid's -1.35 are read straight off the formula (all
// cosines at +-1). gyroid's 3/2 and schwarzD's sqrt(2) are the classic values,
// and lidinoid's +1.15 has no tidy closed form; all five were confirmed to 9
// decimals by a 240^3 dense sample over one period followed by a coordinate-wise
// hill climb, which reproduced the analytic numbers exactly.
const PATTERN_RANGE = Object.freeze([
  Object.freeze({ max: 1.5, min: -1.5 }),                   // gyroid
  Object.freeze({ max: 3, min: -3 }),                       // schwarzP
  Object.freeze({ max: Math.SQRT2, min: -Math.SQRT2 }),     // schwarzD
  Object.freeze({ max: 1.15, min: -1.35 }),                 // lidinoid
  Object.freeze({ max: 13, min: -13 }),                     // neovius
]);

// Saturation ramp. `sat` is the threshold as a fraction of the largest value the
// field can reach; at sat >= 1 the lattice removes nothing anywhere. The lattice
// is faded out of the max() across the last 5% rather than switching at 1.0, so
// the last sliver of pore closes smoothly instead of popping.
const SAT_FADE_FROM = 0.95;

// QUALITY presets. The march is Lipschitz-corrected sphere tracing (see the
// shader), so `steps` — the per-ray sample budget — is the real quality knob:
// it sets the stride FLOOR at span/steps, which is what decides whether a thin
// wall can be tunnelled through. `ceilFrac` caps the adaptive stride as a share
// of the cell so one leap never clears a whole cell. `refine` is the bisection
// count once a sign change is bracketed.
// HIGH is the default. LOW cuts the budget to ~1/3 (coarser floor, so thin walls
// can drop out at grazing angles) and skips refinement entirely, which puts a
// crossing on a whole step boundary and reads as slight faceting.
const QUALITY = Object.freeze({
  high: Object.freeze({ steps: 160, refine: 4, ceilFrac: 0.50 }),
  low:  Object.freeze({ steps: 96,  refine: 0, ceilFrac: 0.90 }),
});
// Where 160 came from: measured on Intel UHD 630 at 2.07 Mpx (1080p-equivalent),
// both panels collapsed, HOME framing on a 60x40x20 box.
//   HIGH  cell 3 / wall 0.5  48 fps · cell 8 / wall 1.2  34 fps
//         cell 8 / wall 0.4  30 fps · cell 12 / wall 1.2 27 fps
//   LOW   79 to 81 fps at every one of those.
// A COARSE cell is the expensive case, not a fine one: an open lattice lets most
// rays travel the full depth of the part instead of hitting early. Cutting the
// budget does NOT buy that back - at 64 steps cell 12 still measured 34 fps,
// because the sphere trace, not the floor, is what sets the sample count. So 160
// is chosen for fidelity (it renders a 0.4 mm wall, thinner than any FDM line,
// with no dropouts) and the 12 mm case is left to the QUALITY toggle, which is
// exactly what LOW is for. A discrete GPU has multiples of this headroom.

// Sphere-trace stride factor. TPMSWall normalises f by grad = |k|, but the TRUE
// gradient of the gyroid family peaks near 2*|k| (d/dx of sin x cos y + sin z cos x
// is cos x cos y - sin z sin x, magnitude <= 2), so the value it returns overstates
// the real distance by at most ~2x and a factor of 0.5 is provably safe.
// 0.6 is deliberately past that, and the arithmetic says it still cannot tunnel:
// the field maxes out at 1.5/grad = 0.138*cell, so the worst overshoot past the
// true surface is 0.1*0.138*cell = 0.0138*cell — under 0.17 mm at a 12 mm cell,
// far below any printable wall. The payoff is ~25% fewer marched samples.
const LIPSCHITZ = 0.6;

const RESULT_COLOR = 0xd9d9d9;   // --fg, same tint as the baked result mesh

// Depth push for the sampled part clip, in SDF voxels. See the depth write.
const DEPTH_PUSH_VOXELS = 0.75;

// SDF fetch backoff. The endpoint is served by the C# side; while it does not
// exist yet (or a bake is queued) the preview runs in bbox-clip fallback and
// re-asks on this cadence. Polite: one request per part per interval, never a
// tight loop.
const SDF_JOB_POLL_MS = 800;
const SDF_RETRY_MS = 12000;

// ── CHIRALITY GUARDS (dev only — see _verifyOrientation / verifyChirality) ──
// A MIRRORED field is the one defect none of this app's other checks can see.
// The bake's Monte-Carlo fidelity check compares VOLUME FRACTIONS, and a mirror
// preserves volume exactly; every stock fixture (box, cylinder, sphere, and the
// manifold cavity, which is symmetric in X) is its own mirror image; and the
// TPMS patterns are chiral, so a single flipped axis turns a gyroid into its
// enantiomer with an identical histogram. A real Y flip in the worker's slice
// read (PicoGK image rows run top-down — worker/VoxelSlice.cs) therefore shipped
// with every check green while the preview drew the part clip backwards.
//
// Guards run on localhost only: one is a golden-value check of the pattern
// formulas, the other a one-shot check that a freshly fetched field actually
// lands where its metadata claims. Neither costs anything in production.
const DEV_CHECKS = typeof location !== 'undefined' &&
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

// Centroid agreement (mm) demanded between a decoded field and the mesh it was
// baked from. A one-axis mirror moves it by a large fraction of the part; the
// honest disagreement is voxelisation, well under a cell.
const ORIENT_TOL_CELLS = 1.5;
// Below this the part is near enough symmetric on that axis for the centroid to
// say nothing — reported as "not chiral enough to test", never as a pass.
const ORIENT_MIN_SKEW_CELLS = 2.0;

const VERT = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// three.js compiles a plain ShaderMaterial as GLSL ES 3.00 and supplies
// `#define varying in`, `pc_fragColor`/`gl_FragColor` and `linearToOutputTexel`,
// so this reads as GLSL1 but gets sampler3D + `texture()` + gl_FragDepth for
// free. (RawShaderMaterial would NOT get that conversion — do not switch.)
const FRAG = /* glsl */`
precision highp float;
precision highp sampler3D;

varying vec3 vWorld;

uniform mat4 uInvModel;      // world → part-local
uniform vec3 uBoxMin;        // part-local march box (grown by ~half a cell)
uniform vec3 uBoxMax;
uniform vec3 uClipMin;       // part-local TIGHT bbox — the fallback clip solid
uniform vec3 uClipMax;

uniform float uHasSdf;       // 1 = sample uSdf, 0 = bbox fallback
uniform sampler3D uSdf;
uniform vec3  uSdfDims;      // nx, ny, nz
uniform vec3  uSdfOrigin;    // originMM (part-local)
uniform float uSdfCell;      // cellMM
uniform float uSdfBand;      // bandMM

uniform vec3  uK;            // 2*pi / cell, per axis
uniform float uGrad;         // |grad f| ~= sqrt(kx^2+ky^2+kz^2)
uniform float uThreshMM;     // sheet: wall/2 ; skeletal: bias
uniform float uSheet;        // 1 = sheet (|f|), 0 = skeletal (f)
uniform float uLatMix;       // 1 = lattice live, 0 = saturated (lattice removed)
uniform int   uPattern;
uniform mat3  uRot;          // Rz*Ry*Rx, about uCenter
uniform vec3  uCenter;       // world bbox centre of the target (rotation pivot)
uniform vec3  uPhaseMM;      // phase fraction * cell, per axis

uniform int   uSteps;
uniform int   uRefine;
uniform float uStepMax;      // coarsest stride (deep in open pore space)
uniform float uLip;          // Lipschitz-corrected stride factor (see the march)
uniform float uEpsMM;

uniform float uSecOn;
uniform vec4  uSecPlane;     // world (normal.xyz, constant); kept half >= 0

// three.js declares viewMatrix + cameraPosition in the FRAGMENT prefix but NOT
// projectionMatrix (vertex only), so the depth write carries its own copy.
uniform mat4 uProj;

uniform vec3 uKeyDir;
uniform vec3 uFillDir;
uniform vec3 uUpDir;
uniform vec3 uColor;
uniform float uDepthPush;    // mm the depth write is nudged AWAY from the eye

// ── the lattice half — a port of worker/TPMSWall.cs ────────────────────
// TPMSWall.fSignedDistance:
//   p   = Rz*Ry*Rx*(v - c) + c ; p += phaseMM
//   raw = sheet ? |f(k*p)| : f(k*p)
//   d   = (raw - thresh) / grad,  thresh = grad * (sheet ? wall/2 : bias)
// which is algebraically raw/grad - (sheet ? wall/2 : bias) — what is written
// below. grad = sqrt(kx^2+ky^2+kz^2) (k*sqrt(3) for a uniform cell) is TPMSWall's
// own gradient normalisation, i.e. this returns the same approximate mm distance
// the voxel engine is handed.
float latticeF( vec3 pw ) {
  vec3 p = uRot * ( pw - uCenter ) + uCenter + uPhaseMM;
  vec3 k = uK * p;
  float f;
  if ( uPattern == 0 ) {                       // Gyroid
    f = sin( k.x ) * cos( k.y ) + sin( k.y ) * cos( k.z ) + sin( k.z ) * cos( k.x );
  } else if ( uPattern == 1 ) {                // Schwarz P
    f = cos( k.x ) + cos( k.y ) + cos( k.z );
  } else if ( uPattern == 2 ) {                // Schwarz D
    vec3 s = sin( k ), c = cos( k );
    f = s.x * s.y * s.z + s.x * c.y * c.z + c.x * s.y * c.z + c.x * c.y * s.z;
  } else if ( uPattern == 3 ) {                // Lidinoid
    vec3 s = sin( k ), c = cos( k );
    vec3 s2 = sin( 2.0 * k ), c2 = cos( 2.0 * k );
    f = 0.5 * ( s2.x * c.y * s.z + s2.y * c.z * s.x + s2.z * c.x * s.y )
      - 0.5 * ( c2.x * c2.y + c2.y * c2.z + c2.z * c2.x ) + 0.15;
  } else {                                     // Neovius
    vec3 c = cos( k );
    f = 3.0 * ( c.x + c.y + c.z ) + 4.0 * ( c.x * c.y * c.z );
  }
  float raw = mix( f, abs( f ), uSheet );
  return raw / uGrad - uThreshMM;
}

// ── the part half — sampled distance field, or the bbox in fallback ────
float partF( vec3 pl ) {
  if ( uHasSdf < 0.5 ) {
    vec3 d = max( uClipMin - pl, pl - uClipMax );          // exact box SDF
    return min( max( d.x, max( d.y, d.z ) ), 0.0 ) + length( max( d, vec3( 0.0 ) ) );
  }
  vec3 g = ( pl - uSdfOrigin ) / uSdfCell;                 // voxel index space
  if ( any( lessThan( g, vec3( -0.5 ) ) ) || any( greaterThan( g, uSdfDims - 0.5 ) ) )
    return uSdfBand;                                       // outside the baked band
  float v = texture( uSdf, ( g + 0.5 ) / uSdfDims ).r;     // r8, x-fastest
  return ( v * 255.0 - 128.0 ) / 127.0 * uSdfBand;         // <128 = inside
}

float fieldAt( vec3 pw, vec3 pl ) {
  float part = partF( pl );
  // SATURATION: once the threshold clears the pattern's largest attainable
  // |f|/grad the lattice is solid everywhere and carves nothing — but it still
  // sits a hair under 0 in the max(), which turns the part's own surface into a
  // near-tie between two fields and shreds the normal. uLatMix (computed on the
  // JS side, see PATTERN_RANGE) fades the lattice's CONTRIBUTION out over the
  // last 5% of its usable range, so F degrades to the bare part SDF with the
  // pores closing smoothly on the way rather than switching at a hard edge.
  //   mix( part, max(part,lat), m ) == part + m*max(0, lat - part)
  // so the result is never MORE solid than the part, and at m = 0 it lands on
  // the part SDF exactly.
  float d = uLatMix > 0.0 ? mix( part, max( part, latticeF( pw ) ), uLatMix ) : part;
  // SECTION: the cut half-space joins the max(), so the plane both removes the
  // near material AND leaves a flat cross-section face (shaded as material, not
  // hatched — the hatch cap is a mesh-stencil trick the preview has no mesh for).
  if ( uSecOn > 0.5 ) d = max( d, -( dot( uSecPlane.xyz, pw ) + uSecPlane.w ) );
  return d;
}

void main() {
  vec3 ro = cameraPosition;
  vec3 rd = normalize( vWorld - ro );

  // Ray in part-local terms, parameterised by the SAME world t: the local
  // direction is left UNNORMALISED so t stays in world mm through both frames.
  vec3 roL = ( uInvModel * vec4( ro, 1.0 ) ).xyz;
  vec3 rdL = mat3( uInvModel ) * rd;

  // Slab intersect against the part-local march box.
  vec3 inv = 1.0 / rdL;
  vec3 ta = ( uBoxMin - roL ) * inv;
  vec3 tb = ( uBoxMax - roL ) * inv;
  vec3 tn = min( ta, tb ), tf = max( ta, tb );
  float tEnter = max( max( tn.x, tn.y ), tn.z );
  float tExit  = min( min( tf.x, tf.y ), tf.z );
  tEnter = max( tEnter, 0.0 );
  if ( tExit <= tEnter ) discard;

  // The stride floor IS the budget: span/steps. A near-tangent ray, where sphere
  // tracing would otherwise crawl, is forced forward by it and always reaches
  // tExit inside uSteps samples — so a long ray coarsens instead of stopping
  // short, and the far side of a big part never vanishes.
  float span = tExit - tEnter;
  float dtFloor = span / float( uSteps );

  float t0 = tEnter;
  float f0 = fieldAt( ro + rd * t0, roL + rdL * t0 );
  bool hit = f0 < 0.0;                       // camera already inside material
  float tHit = t0;

  if ( ! hit ) {
    for ( int i = 0; i < uSteps; i ++ ) {
      // Lipschitz-corrected stride (see LIPSCHITZ in the JS above): open pores
      // are cleared in a few strides while a wall is approached asymptotically,
      // so nothing is tunnelled at any printable wall thickness. dt is still
      // floored (so grazing rays finish inside the step budget) and ceilinged
      // (so one cell is never leapt on an optimistic estimate).
      float dt = clamp( uLip * f0, dtFloor, uStepMax );
      float t1 = min( t0 + dt, tExit );
      float f1 = fieldAt( ro + rd * t1, roL + rdL * t1 );
      if ( f1 < 0.0 ) {
        // Bisection: t0 is outside, t1 is inside. LOW skips this and accepts
        // the whole-step boundary.
        for ( int j = 0; j < uRefine; j ++ ) {
          float tm = 0.5 * ( t0 + t1 );
          if ( fieldAt( ro + rd * tm, roL + rdL * tm ) < 0.0 ) t1 = tm; else t0 = tm;
        }
        hit = true; tHit = t1;
        break;
      }
      if ( t1 >= tExit ) break;
      t0 = t1; f0 = f1;
    }
  }
  if ( ! hit ) discard;

  vec3 pw = ro + rd * tHit;
  vec3 pl = roL + rdL * tHit;

  // Gradient normal by the TETRAHEDRON trick: four offsets on the corners of a
  // regular tetrahedron instead of six axis-aligned central differences. Same
  // first-order gradient, two fewer field evaluations — and a field evaluation
  // here is 6 transcendentals plus a 3D texture fetch, so on an integrated GPU
  // that is worth real milliseconds. Offsets ride to part-local space through the
  // linear part of the inverse model, which is a mat3 rather than a mat4 per tap.
  // The FULL field is sampled (not just the lattice), so the part clip and the
  // section face shade with their own normals.
  mat3 IM = mat3( uInvModel );
  float e = uEpsMM;
  vec2 kk = vec2( 1.0, -1.0 );
  vec3 o1 = kk.xyy * e, o2 = kk.yyx * e, o3 = kk.yxy * e, o4 = kk.xxx * e;
  vec3 n = kk.xyy * fieldAt( pw + o1, pl + IM * o1 )
         + kk.yyx * fieldAt( pw + o2, pl + IM * o2 )
         + kk.yxy * fieldAt( pw + o3, pl + IM * o3 )
         + kk.xxx * fieldAt( pw + o4, pl + IM * o4 );
  float nl = length( n );
  vec3 N = nl > 1e-9 ? n / nl : -rd;
  if ( dot( N, rd ) > 0.0 ) N = -N;          // always face the viewer

  // Shading matched to the HUD result mesh (light gray, key from the scene's key
  // direction, hemisphere fill, subtle fresnel rim). Linear in, sRGB out.
  float kd  = max( dot( N, uKeyDir ), 0.0 );
  float fd  = max( dot( N, uFillDir ), 0.0 );
  float sky = 0.5 + 0.5 * dot( N, uUpDir );
  vec3 H = normalize( uKeyDir - rd );
  float spec = pow( max( dot( N, H ), 0.0 ), 26.0 ) * 0.30;
  float fres = pow( 1.0 - max( dot( N, -rd ), 0.0 ), 3.0 ) * 0.18;

  vec3 col = uColor * ( 0.16 + 0.30 * sky + 0.86 * kd + 0.24 * fd ) + vec3( spec + fres );

  gl_FragColor = vec4( col, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>

  // Correct depth from the HIT point (not the proxy box face) so the grid shows
  // through the lattice openings and the gizmo/ghosts composite normally.
  //
  // uDepthPush nudges that depth AWAY from the eye by a fraction of an SDF voxel.
  // The part clip is a SAMPLED field: where it stands in for the part's own
  // surface it disagrees with the target's triangle mesh by up to half a voxel,
  // in both directions, in a pattern that follows the voxel grid. The mesh is
  // still drawn as a translucent ghost on top of the preview, and without this
  // push the two swap depth ownership across that error and the ghost paints on
  // in broad stripes. Losing every tie hands the exact mesh the surface it owns
  // — which is what already happens everywhere the lattice cuts INSIDE the part,
  // so the whole surface now reads the one way instead of two.
  vec4 clip = uProj * viewMatrix * vec4( pw + rd * uDepthPush, 1.0 );
  gl_FragDepthEXT = ( clip.z / clip.w ) * 0.5 + 0.5;
}
`;

/** One-voxel placeholder so the sampler3D is always bound to something real. */
function makeDummy3D() {
  const t = new THREE.Data3DTexture(new Uint8Array([255]), 1, 1, 1);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.NearestFilter;
  t.magFilter = THREE.NearestFilter;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

// ── chirality guard 1: the pattern formulas ────────────────────────────
// An inline port of worker/TPMSWall.cs's raw f, term for term, kept beside the
// GLSL twin in latticeF above. The probe points are ASYMMETRIC and the expected
// values are GOLDEN CONSTANTS computed from the C# source — so swapping a term
// pair (sin x cos y -> sin y cos x, the classic way to mirror a gyroid), negating
// an argument, or transposing the yz pair moves the value and trips the assert.
// A symmetric probe such as (1,1,1) would survive every one of those edits.
const CHIRAL_PROBE = Object.freeze([0.7, 0.3, 1.1]);
const CHIRAL_GOLDEN = Object.freeze({
  // f(0.7, 0.3, 1.1) per pattern, and the gyroid at the three single-axis
  // mirrors of that point — all four gyroid values differ, which IS the chirality.
  gyroid: 1.431124470,
  gyroidMirrorX: 0.200235143,   // f(-0.7,  0.3,  1.1)
  gyroidMirrorY: 1.163030831,   // f( 0.7, -0.3,  1.1)
  gyroidMirrorZ: 0.067858497,   // f( 0.7,  0.3, -1.1)
  schwarzD: 1.202544312,
  lidinoid: 0.966104942,
});

/** raw f for the chiral patterns — the JS twin of TPMSWall.fSignedDistance. */
function rawPatternF(pattern, x, y, z) {
  const sx = Math.sin(x), sy = Math.sin(y), sz = Math.sin(z);
  const cx = Math.cos(x), cy = Math.cos(y), cz = Math.cos(z);
  if (pattern === 'gyroid') return sx * cy + sy * cz + sz * cx;
  if (pattern === 'schwarzD') return sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz;
  if (pattern === 'lidinoid') {
    const s2 = [Math.sin(2 * x), Math.sin(2 * y), Math.sin(2 * z)];
    const c2 = [Math.cos(2 * x), Math.cos(2 * y), Math.cos(2 * z)];
    return 0.5 * (s2[0] * cy * sz + s2[1] * cz * sx + s2[2] * cx * sy)
         - 0.5 * (c2[0] * c2[1] + c2[1] * c2[2] + c2[2] * c2[0]) + 0.15;
  }
  return NaN;
}

/** Golden-value chirality check of the pattern formulas. Returns a failure list. */
export function verifyChirality() {
  const [a, b, c] = CHIRAL_PROBE;
  const G = CHIRAL_GOLDEN;
  const cases = [
    ['gyroid', rawPatternF('gyroid', a, b, c), G.gyroid],
    ['gyroid mirror X', rawPatternF('gyroid', -a, b, c), G.gyroidMirrorX],
    ['gyroid mirror Y', rawPatternF('gyroid', a, -b, c), G.gyroidMirrorY],
    ['gyroid mirror Z', rawPatternF('gyroid', a, b, -c), G.gyroidMirrorZ],
    ['schwarzD', rawPatternF('schwarzD', a, b, c), G.schwarzD],
    ['lidinoid', rawPatternF('lidinoid', a, b, c), G.lidinoid],
  ];
  const fails = [];
  for (const [name, got, want] of cases) {
    if (!(Math.abs(got - want) < 1e-6)) fails.push(`${name}: got ${got} want ${want}`);
  }
  // The point of the exercise: a gyroid is CHIRAL, so mirroring any one axis
  // must change the value. If these ever tie, the field has lost its handedness
  // and the golden values above are testing nothing.
  for (const [name, got] of [['X', G.gyroidMirrorX], ['Y', G.gyroidMirrorY], ['Z', G.gyroidMirrorZ]]) {
    if (Math.abs(got - G.gyroid) < 1e-3) fails.push(`gyroid is not chiral in ${name}`);
  }
  return fails;
}

/** Exact volume centroid of a BufferGeometry (divergence theorem), or null. */
function meshVolumeCentroid(geo) {
  const pos = geo.getAttribute('position');
  if (!pos) return null;
  const idx = geo.getIndex();
  const nTri = Math.floor((idx ? idx.count : pos.count) / 3);
  let vol = 0, mx = 0, my = 0, mz = 0;
  for (let t = 0; t < nTri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3;
    const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    const ax = pos.getX(i0), ay = pos.getY(i0), az = pos.getZ(i0);
    const bx = pos.getX(i1), by = pos.getY(i1), bz = pos.getZ(i1);
    const cx = pos.getX(i2), cy = pos.getY(i2), cz = pos.getZ(i2);
    const v = (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
    vol += v;
    mx += v * (ax + bx + cx) / 4;
    my += v * (ay + by + cy) / 4;
    mz += v * (az + bz + cz) / 4;
  }
  if (!(Math.abs(vol) > 1e-9)) return null;
  return [mx / vol, my / vol, mz / vol];
}

export class LatticePreview {
  /** @param {import('./viewer.js').Viewer} viewer */
  constructor(viewer) {
    this.viewer = viewer;
    this.enabled = false;
    this.quality = 'high';
    this.targetId = null;
    this.onNote = null;      // (text|null) → the regmark under the PREVIEW row

    // Two independent note sources share the one regmark. The part field is
    // still baking (a temporary shortfall in the CLIP) outranks a saturated
    // lattice, because until the field lands the clip is a bounding box and
    // that is the more misleading of the two.
    this._noteSdf = null;
    this._noteSat = null;
    this._noteText = undefined;

    this._params = null;     // last ui.readParams()
    this._dummy = makeDummy3D();
    this._sdf = new Map();   // partId → { state, tex, meta, jobId, nextTry }
    this._timer = 0;

    // Scratch — the sync path runs every frame and must not allocate.
    this._box = new THREE.Box3();
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this._m = new THREE.Matrix4();
    this._m2 = new THREE.Matrix4();
    this._e = new THREE.Euler();

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,     // always rasterise the FAR face → works from inside too
      depthTest: true,
      depthWrite: true,
      transparent: false,
      uniforms: {
        uInvModel: { value: new THREE.Matrix4() },
        uBoxMin: { value: new THREE.Vector3(-1, -1, -1) },
        uBoxMax: { value: new THREE.Vector3(1, 1, 1) },
        uClipMin: { value: new THREE.Vector3(-1, -1, -1) },
        uClipMax: { value: new THREE.Vector3(1, 1, 1) },
        uHasSdf: { value: 0 },
        uSdf: { value: this._dummy },
        uSdfDims: { value: new THREE.Vector3(1, 1, 1) },
        uSdfOrigin: { value: new THREE.Vector3() },
        uSdfCell: { value: 1 },
        uSdfBand: { value: 1 },
        uK: { value: new THREE.Vector3(1, 1, 1) },
        uGrad: { value: 1 },
        uThreshMM: { value: 0.6 },
        uSheet: { value: 1 },
        uLatMix: { value: 1 },
        uPattern: { value: 0 },
        uRot: { value: new THREE.Matrix3() },
        uCenter: { value: new THREE.Vector3() },
        uPhaseMM: { value: new THREE.Vector3() },
        uSteps: { value: QUALITY.high.steps },
        uRefine: { value: QUALITY.high.refine },
        uStepMax: { value: 4 },
        uLip: { value: LIPSCHITZ },
        uEpsMM: { value: 0.05 },
        uSecOn: { value: 0 },
        uSecPlane: { value: new THREE.Vector4(0, 0, 1, 0) },
        uKeyDir: { value: new THREE.Vector3(0, 0, 1) },
        uFillDir: { value: new THREE.Vector3(0, 0, -1) },
        uUpDir: { value: new THREE.Vector3(0, 0, 1) },
        uColor: { value: new THREE.Color(RESULT_COLOR) },
        uDepthPush: { value: 0 },
        uProj: { value: new THREE.Matrix4() },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.material);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = -1;   // opaque, before the translucent ghost lanes
    this.mesh.userData.anvilPreview = true;
    viewer.scene.add(this.mesh);
  }

  // ── public API ────────────────────────────────────────────────────────
  isEnabled() { return this.enabled; }

  setEnabled(on) {
    const next = !!on;
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) {
      this._ensureSdf(this.targetId);
      this._startTimer();
      // main.js gates the regmark on isEnabled(), so anything setParams() found
      // while the preview was off was dropped — re-announce it now.
      this._pushNote(true);
    } else {
      this._stopTimer();
      this._noteSdf = null;
      this._pushNote(true);
    }
    this.sync();
  }

  setQuality(q) {
    const key = q === 'low' ? 'low' : 'high';
    if (key === this.quality) return;
    this.quality = key;
    this._applyQuality();
  }
  getQuality() { return this.quality; }

  /** The part GENERATE would lattice: the selected/role part (single) or the
   *  NEGATIVE (fuse) — its volume is what the lattice fills. */
  setTarget(id) {
    const next = id || null;
    if (next === this.targetId) return;
    this.targetId = next;
    if (this.enabled) this._ensureSdf(next);
    this.sync();
  }
  getTarget() { return this.targetId; }

  /** Uniform refresh from ui.readParams(). Called on EVERY `input` event, so it
   *  writes uniforms only — no allocation, no geometry, no fetch. */
  setParams(p) {
    if (!p) return;
    this._params = p;
    const u = this.material.uniforms;

    const c = p.cellSizeXYZ || null;
    const ax = Math.max(0.05, c ? (c.x > 0 ? c.x : p.cellSizeMM) : p.cellSizeMM);
    const ay = Math.max(0.05, c ? (c.y > 0 ? c.y : p.cellSizeMM) : p.cellSizeMM);
    const az = Math.max(0.05, c ? (c.z > 0 ? c.z : p.cellSizeMM) : p.cellSizeMM);
    const TAU = Math.PI * 2;
    const kx = TAU / ax, ky = TAU / ay, kz = TAU / az;
    u.uK.value.set(kx, ky, kz);
    u.uGrad.value = Math.sqrt(kx * kx + ky * ky + kz * kz);

    const sheet = p.latticeType !== 'skeletal';
    const pattern = PATTERN_ID[p.pattern] ?? 0;
    const thresh = sheet ? (p.wallThicknessMM || 0) * 0.5 : (p.biasMM || 0);
    u.uSheet.value = sheet ? 1 : 0;
    u.uThreshMM.value = thresh;
    u.uPattern.value = pattern;
    this._applySaturation(pattern, sheet, thresh, u.uGrad.value);

    // Phase is a fraction of the cell, clamped 0..1 exactly as PhaseVec does.
    const ph = p.phaseOffset || {};
    const cl = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    u.uPhaseMM.value.set(cl(ph.x) * ax, cl(ph.y) * ay, cl(ph.z) * az);

    // TPMSWall builds Mx·My·Mz in System.Numerics' ROW-vector form, which is
    // Rz·Ry·Rx in column form — three.js Euler order 'ZYX'.
    const r = p.rotationDeg || {};
    const D = Math.PI / 180;
    this._e.set((r.x || 0) * D, (r.y || 0) * D, (r.z || 0) * D, 'ZYX');
    this._m.makeRotationFromEuler(this._e);
    u.uRot.value.setFromMatrix4(this._m);

    const cellMin = Math.min(ax, ay, az);
    this._cellMin = cellMin;
    this._thick = sheet
      ? Math.max(p.wallThicknessMM || 0, 0.05)
      // Skeletal has no wall: its thinnest ligament is a fraction of the cell,
      // narrowing as the bias goes negative.
      : Math.max(cellMin * (0.30 - 0.10 * Math.min(Math.max((p.biasMM || 0) / cellMin, -1), 1)), 0.05);
    this._applyStep();
    // Normal epsilon: fine enough to resolve the wall, never so fine that the
    // central difference lands inside float noise.
    u.uEpsMM.value = Math.max(Math.min(cellMin / 90, this._thick / 8), 1e-4);
  }

  /** How much of the pattern's usable range the threshold is asking for, and the
   *  lattice's resulting weight in the field.
   *
   *  raw |f| lives inside PATTERN_RANGE, so raw/grad can never exceed
   *  `limit = maxRaw/grad` mm. Sheet mode subtracts wall/2 from |f|/grad, so at
   *  wall/2 >= limit the band swallows the whole cell and the lattice is SOLID
   *  EVERYWHERE — 4 mm cells with a 1.2 mm wall on a gyroid is already past it
   *  (1.5/grad = 0.551 mm < 0.600 mm). Skeletal is one-sided: the same runaway
   *  happens at bias >= max/grad, and the mirror case, bias <= min/grad, leaves
   *  NOTHING solid.
   *
   *  Below SAT_FADE_FROM nothing changes. Across the last 5% the lattice fades
   *  out of the max() (see fieldAt), so the field lands on the bare part SDF
   *  with the pores closing instead of a visible switch. */
  _applySaturation(pattern, sheet, thresh, grad) {
    const rng = PATTERN_RANGE[pattern] || PATTERN_RANGE[0];
    // Sheet takes |f|, so its ceiling is whichever extreme is further from zero.
    const rawMax = sheet ? Math.max(rng.max, -rng.min) : rng.max;
    const limit = grad > 0 ? rawMax / grad : 0;
    const sat = limit > 0 ? thresh / limit : 0;

    const t = Math.min(Math.max((sat - SAT_FADE_FROM) / (1 - SAT_FADE_FROM), 0), 1);
    this.material.uniforms.uLatMix.value = 1 - t * t * (3 - 2 * t);   // smoothstep

    // Skeletal below min/grad is the opposite degeneracy: f/grad - bias > 0
    // everywhere, so the lattice removes the entire part and the viewport goes
    // empty. Nothing to blend there (empty is empty) — it just needs saying.
    const emptyLimit = sheet ? -Infinity : (grad > 0 ? rng.min / grad : 0);
    this._noteSat =
      sat >= 1 ? (sheet ? 'wall saturates this cell size - solid'
                        : 'bias saturates this cell size - solid')
      : thresh <= emptyLimit ? 'bias clears this cell size - nothing solid'
      : null;
    this._pushNote();
  }

  /** Stride ceiling, in world mm: cell*ceilFrac, so the adaptive stride never
   *  leaps a whole cell on the strength of an over-optimistic distance estimate.
   *  (The floor is span/steps and lives in the shader — see the march loop.) */
  _applyStep() {
    const q = QUALITY[this.quality];
    this.material.uniforms.uStepMax.value = Math.max((this._cellMin || 8) * q.ceilFrac, 1e-3);
  }

  /** Per-frame: proxy matrix, world pivot, section plane, light directions.
   *  Called from Viewer._tick — never its own rAF. */
  sync() {
    const p = this.enabled && this.targetId ? this.viewer.parts.get(this.targetId) : null;
    const mesh = p && p.mesh;
    if (!mesh || !mesh.geometry) { this.mesh.visible = false; return; }
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const bb = mesh.geometry.boundingBox;
    if (!bb) { this.mesh.visible = false; return; }
    this.mesh.visible = true;

    const u = this.material.uniforms;
    const M = mesh.matrixWorld;

    // Part-local TIGHT bbox (the fallback clip solid).
    u.uClipMin.value.copy(bb.min);
    u.uClipMax.value.copy(bb.max);

    // March box = the tight bbox grown by ~half a cell + a wall, expressed in
    // LOCAL units (so a scaled part grows by the right world amount).
    const par = this._params;
    const cell = par ? Math.max(par.cellSizeMM || 8, 0.05) : 8;
    const wall = par ? Math.abs(par.wallThicknessMM || 0) : 0;
    const growW = cell * 0.5 + wall + 0.5;
    const sx = this._v.setFromMatrixColumn(M, 0).length() || 1;
    const sy = this._v.setFromMatrixColumn(M, 1).length() || 1;
    const sz = this._v.setFromMatrixColumn(M, 2).length() || 1;
    u.uBoxMin.value.set(bb.min.x - growW / sx, bb.min.y - growW / sy, bb.min.z - growW / sz);
    u.uBoxMax.value.set(bb.max.x + growW / sx, bb.max.y + growW / sy, bb.max.z + growW / sz);

    // Proxy geometry is a UNIT box: matrix = M · T(centre) · S(size).
    const cx = (u.uBoxMin.value.x + u.uBoxMax.value.x) * 0.5;
    const cy = (u.uBoxMin.value.y + u.uBoxMax.value.y) * 0.5;
    const cz = (u.uBoxMin.value.z + u.uBoxMax.value.z) * 0.5;
    this._m.makeTranslation(cx, cy, cz);
    this._m2.makeScale(
      Math.max(u.uBoxMax.value.x - u.uBoxMin.value.x, 1e-4),
      Math.max(u.uBoxMax.value.y - u.uBoxMin.value.y, 1e-4),
      Math.max(u.uBoxMax.value.z - u.uBoxMin.value.z, 1e-4));
    this._m.multiply(this._m2);
    this.mesh.matrix.multiplyMatrices(M, this._m);
    this.mesh.matrixWorld.copy(this.mesh.matrix);
    this.mesh.matrixWorldNeedsUpdate = false;

    u.uInvModel.value.copy(M).invert();

    // Rotation pivot: the target's WORLD bbox centre — the same envelope centre
    // GyroidJob hands TPMSWall (mshPart/mshNeg.oBoundingBox().vecCenter()).
    this._box.copy(bb).applyMatrix4(M);
    this._box.getCenter(u.uCenter.value);

    // SECTION — mirrored from the viewer's own clip plane (kept half >= 0).
    const v = this.viewer;
    const on = typeof v._sectionActive === 'function' && v._sectionActive();
    u.uSecOn.value = on ? 1 : 0;
    if (on) {
      const cp = v._clipPlane;
      u.uSecPlane.value.set(cp.normal.x, cp.normal.y, cp.normal.z, cp.constant);
    }

    // Lights follow the scene's own key/fill/up so the preview reads like the
    // baked mesh from every orbit angle and in every MODEL UP mode.
    u.uProj.value.copy(v.camera.projectionMatrix);
    u.uKeyDir.value.copy(v.key.position).normalize();
    u.uFillDir.value.copy(v.fill.position).normalize();
    u.uUpDir.value.copy(v.hemi.position).normalize();

    // SDF binding for this target (ready → real texture, else bbox fallback).
    const rec = this._sdf.get(this.targetId);
    if (rec && rec.state === 'ready') {
      if (u.uSdf.value !== rec.tex) u.uSdf.value = rec.tex;
      u.uHasSdf.value = 1;
      u.uSdfDims.value.set(rec.meta.nx, rec.meta.ny, rec.meta.nz);
      u.uSdfOrigin.value.set(rec.meta.originMM.x, rec.meta.originMM.y, rec.meta.originMM.z);
      u.uSdfCell.value = rec.meta.cellMM;
      u.uSdfBand.value = rec.meta.bandMM;
      // Depth push (see the depth write): three quarters of a voxel, i.e. past
      // the +-half-voxel the sampled field can disagree with the ghost mesh by,
      // and small enough that the grid still reads through every pore.
      u.uDepthPush.value = rec.meta.cellMM * DEPTH_PUSH_VOXELS;
    } else {
      u.uHasSdf.value = 0;
      // The bbox fallback is an EXACT box SDF with no mesh under it, so it has
      // no tie to lose.
      u.uDepthPush.value = 0;
      if (u.uSdf.value !== this._dummy) u.uSdf.value = this._dummy;
    }
  }

  dispose() {
    this._stopTimer();
    this.viewer.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.material.dispose();
    for (const rec of this._sdf.values()) rec.tex?.dispose();
    this._sdf.clear();
    this._dummy.dispose();
  }

  /** Drop a part's cached field (the part was deleted or replaced). */
  forget(id) {
    const rec = this._sdf.get(id);
    if (!rec) return;
    rec.tex?.dispose();
    this._sdf.delete(id);
  }

  // ── internals ─────────────────────────────────────────────────────────
  _applyQuality() {
    const q = QUALITY[this.quality];
    this.material.uniforms.uSteps.value = q.steps;
    this.material.uniforms.uRefine.value = q.refine;
    if (this._params) this._applyStep();
  }

  /** The SDF channel of the regmark. */
  _note(text) {
    if (this._noteSdf === text) return;
    this._noteSdf = text;
    this._pushNote();
  }

  /** Collapse both channels onto the one regmark. `force` re-announces the same
   *  text (setEnabled needs it: main.js drops notes while the preview is off). */
  _pushNote(force) {
    const text = this._noteSdf || this._noteSat || null;
    if (!force && this._noteText === text) return;
    this._noteText = text;
    this.onNote?.(text);
  }

  _startTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tickSdf(), SDF_JOB_POLL_MS);
  }
  _stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = 0;
  }

  // Polite driver: one in-flight request per part, a job poll while a bake runs,
  // and a slow retry while the endpoint is absent (the C# side may land later).
  _tickSdf() {
    if (!this.enabled || !this.targetId) return;
    const id = this.targetId;
    const rec = this._sdf.get(id);
    if (!rec) { this._ensureSdf(id); return; }
    if (rec.state === 'ready') { this._note(null); return; }
    if (rec.state === 'pending') { this._note('BAKING PART FIELD...'); return; }
    if (rec.state === 'retry' && Date.now() >= rec.nextTry) {
      this._sdf.delete(id);
      this._ensureSdf(id);
    }
  }

  _ensureSdf(id) {
    if (!id || !this.enabled) return;
    const have = this._sdf.get(id);
    if (have && have.state !== 'retry') return;
    if (have && have.state === 'retry' && Date.now() < have.nextTry) return;
    const rec = { state: 'pending', tex: null, meta: null, jobId: null, nextTry: 0 };
    this._sdf.set(id, rec);
    this._note('BAKING PART FIELD...');
    this._runSdf(id, rec).catch(() => this._fail(id, rec));
  }

  _fail(id, rec) {
    if (this._sdf.get(id) !== rec) return;
    rec.state = 'retry';
    rec.nextTry = Date.now() + SDF_RETRY_MS;
    // Fallback is a real, working mode — the note stays up because the tight
    // clip is still coming, but nothing about the preview stops working.
    this._note('BAKING PART FIELD...');
  }

  async _runSdf(id, rec) {
    const start = await api.requestPartSdf(id);
    if (this._sdf.get(id) !== rec) return;

    if (!start.ready) {
      const jobId = start.jobId;
      if (!jobId) { this._fail(id, rec); return; }
      rec.jobId = jobId;
      // Poll the shared job endpoint until it settles.
      for (;;) {
        await new Promise((r) => setTimeout(r, SDF_JOB_POLL_MS));
        if (this._sdf.get(id) !== rec) return;
        let st;
        try { st = await api.getJob(jobId); } catch { this._fail(id, rec); return; }
        if (st.state === 'done') break;
        if (st.state === 'failed' || st.state === 'error' || st.state === 'cancelled') {
          this._fail(id, rec); return;
        }
      }
    }

    const meta = await api.getPartSdfMeta(id);
    if (this._sdf.get(id) !== rec) return;
    const res = await fetch(meta.url || api.partSdfBinUrl(id));
    if (!res.ok) { this._fail(id, rec); return; }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (this._sdf.get(id) !== rec) return;
    const need = meta.nx * meta.ny * meta.nz;
    if (buf.length < need) { this._fail(id, rec); return; }

    const tex = new THREE.Data3DTexture(buf, meta.nx, meta.ny, meta.nz);
    tex.format = THREE.RedFormat;
    tex.type = THREE.UnsignedByteType;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;

    rec.tex = tex;
    rec.meta = meta;
    rec.state = 'ready';
    this._verifyOrientation(id, meta, buf);
    this._note(null);
    this.sync();
  }

  // ── chirality guard 2: the field actually lands where its metadata says ──
  // Decodes the field the SHADER's way — index = x + nx*(y + ny*z), voxel (0,0,0)
  // centred on originMM — and compares the centroid of everything it calls INSIDE
  // with the exact volume centroid of the mesh the bake was made from. Those are
  // the same solid in the same part-local frame, so they must coincide to within
  // voxelisation error. Mirror one axis anywhere between the worker's slice read
  // and this decode and the centroid reflects about the grid centre, which on a
  // chiral part is a gross, unmissable disagreement.
  //
  // Runs once per bake, on the user's REAL part, and needs no fixture. On an axis
  // where the part is near-symmetric it says so rather than claiming a pass —
  // that axis genuinely carries no evidence (which is exactly how a Y flip hid
  // behind a box, a cylinder, and an X-symmetric manifold cavity).
  _verifyOrientation(id, meta, buf) {
    if (!DEV_CHECKS || !meta || !buf) return null;
    const p = this.viewer.parts.get(id);
    const geo = p && p.mesh && p.mesh.geometry;
    if (!geo) return null;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const meshC = meshVolumeCentroid(geo);
    if (!meshC) return null;

    const { nx, ny, nz, cellMM } = meta;
    const o = meta.originMM || {};
    let n = 0, sx = 0, sy = 0, sz = 0;
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        const row = nx * (y + ny * z);
        for (let x = 0; x < nx; x++) if (buf[row + x] < 128) { n++; sx += x; sy += y; sz += z; }
      }
    }
    if (!n) return null;
    const fieldC = [o.x + (sx / n) * cellMM, o.y + (sy / n) * cellMM, o.z + (sz / n) * cellMM];

    const bb = geo.boundingBox;
    const bbC = [(bb.min.x + bb.max.x) / 2, (bb.min.y + bb.max.y) / 2, (bb.min.z + bb.max.z) / 2];
    const tol = ORIENT_TOL_CELLS * cellMM;
    const report = { partId: id, meshCentroid: meshC, fieldCentroid: fieldC, cellMM, axes: {} };
    let bad = false;
    for (let a = 0; a < 3; a++) {
      const key = 'xyz'[a];
      const skew = Math.abs(meshC[a] - bbC[a]);
      const err = Math.abs(fieldC[a] - meshC[a]);
      if (skew < ORIENT_MIN_SKEW_CELLS * cellMM) {
        report.axes[key] = `symmetric on this axis (skew ${skew.toFixed(3)} mm) - carries no chirality evidence`;
      } else if (err > tol) {
        report.axes[key] = `MIRRORED OR MISALIGNED: field ${fieldC[a].toFixed(3)} vs mesh ${meshC[a].toFixed(3)} mm (err ${err.toFixed(3)} mm > ${tol.toFixed(3)})`;
        bad = true;
      } else {
        report.axes[key] = `ok (err ${err.toFixed(3)} mm)`;
      }
    }
    if (bad) {
      console.error('[anvil] SDF ORIENTATION CHECK FAILED — the preview clip does not match the part.', report);
      console.assert(false, 'anvil: part SDF is mirrored/misaligned relative to its mesh');
    }
    return report;
  }
}

// Golden-value pattern chirality, checked once at module load in dev. Cheap
// (six evaluations) and it fails loudly rather than silently drawing the mirror
// image of the lattice the bake will produce.
if (DEV_CHECKS) {
  const fails = verifyChirality();
  if (fails.length) {
    console.error('[anvil] TPMS CHIRALITY CHECK FAILED — the preview lattice no longer matches worker/TPMSWall.cs:', fails);
    console.assert(false, 'anvil: TPMS pattern chirality regression');
  }
}

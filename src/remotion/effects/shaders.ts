/**
 * Every field here is a pure function of (uv, time, seed). Remotion renders
 * frames in parallel across several browser tabs and hands each tab an
 * arbitrary range, so a stateful simulation — the ping-pong buffers a real
 * fluid solver needs — would give a different picture depending on which tab
 * drew the frame. Advection is faked by iterating a noise field analytically,
 * which costs nothing in fidelity at this blur level and is reproducible.
 */

export const VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const PRELUDE = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uAspect;
  uniform float uSeed;
  uniform vec3 uBase;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uC;

  float hash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 6; i++) {
      value += amplitude * vnoise(p);
      p = rot * p;
      amplitude *= 0.5;
    }
    return value;
  }

  vec2 field(vec2 p) {
    return (p - 0.5) * vec2(uAspect, 1.0);
  }

  // Slight lift toward the top of frame keeps the type end of the picture
  // from going flat, and a vignette holds attention centre-frame.
  vec3 finish(vec3 colour, vec2 uv) {
    float vignette = smoothstep(1.25, 0.25, length((uv - 0.5) * vec2(uAspect, 1.0)) * 1.4);
    return colour * mix(0.86, 1.08, vignette);
  }
`;

/** Domain-warped fbm: the structure reads as soft depth rather than flat noise. */
const CLOUDS = /* glsl */ `
  void main() {
    vec2 p = field(vUv) * 2.6 + uSeed;
    float t = uTime * 0.055;

    vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3) - t * 0.7));
    vec2 r = vec2(
      fbm(p + 4.0 * q + vec2(1.7, 9.2) + 0.15 * t),
      fbm(p + 4.0 * q + vec2(8.3, 2.8) + 0.12 * t)
    );
    float f = fbm(p + 4.0 * r);

    vec3 colour = mix(uBase, uA, clamp(0.22 + f * f * 2.8, 0.0, 1.0));
    colour = mix(colour, uB, clamp(length(q) * 1.15, 0.0, 1.0));
    colour = mix(colour, uC, clamp(r.x * r.x * 1.15, 0.0, 1.0));
    gl_FragColor = vec4(finish(colour, vUv), 1.0);
  }
`;

/** Iterated advection through its own gradient: marbled, liquid banding. */
const FLUID = /* glsl */ `
  void main() {
    vec2 p = field(vUv) * 2.1 + uSeed;
    float t = uTime * 0.1;

    vec2 flow = p;
    for (int i = 0; i < 4; i++) {
      flow += 0.5 * vec2(
        fbm(flow * 1.7 + vec2(0.0, t)),
        fbm(flow * 1.7 + vec2(3.1, -t))
      );
    }

    float d = fbm(flow * 0.9);
    float bands = sin(d * 7.0 + t * 1.5);

    vec3 colour = mix(uBase, uA, 0.25 + 0.75 * smoothstep(-0.35, 0.85, bands));
    colour = mix(colour, uB, smoothstep(0.15, 0.95, d));
    colour += uC * 0.2 * pow(max(0.0, bands), 3.0);
    gl_FragColor = vec4(finish(colour, vUv), 1.0);
  }
`;

/** Stacked ribbons with a noise veil; reads as a slow curtain of light. */
const AURORA = /* glsl */ `
  void main() {
    vec2 uv = vUv;
    float t = uTime * 0.085;
    float glow = 0.0;

    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      float centre = 0.52
        + 0.17 * sin(uv.x * 2.1 + t * 1.3 + fi * 1.7 + uSeed)
        + 0.09 * fbm(vec2(uv.x * 3.0 + fi + uSeed, t));
      float width = 0.075 + 0.045 * fi;
      glow += smoothstep(width, 0.0, abs(uv.y - centre)) * (0.75 - fi * 0.13);
    }

    float veil = fbm(vec2(uv.x * 3.0 + uSeed, uv.y * 2.0 - t));
    vec3 colour = uBase;
    colour = mix(colour, uA, clamp(0.18 + glow * 1.1, 0.0, 1.0));
    colour = mix(colour, uB, clamp(glow * veil * 0.85, 0.0, 1.0));
    colour += uC * glow * 0.22;
    gl_FragColor = vec4(finish(colour, vUv), 1.0);
  }
`;

/** The original CSS look, kept as a shader so every mode goes down one path. */
const GRADIENT = /* glsl */ `
  void main() {
    vec2 p = field(vUv);
    float t = uTime * 0.05;
    float a = smoothstep(1.1, -0.2, length(p - vec2(sin(t + uSeed) * 0.35, -0.45)) * 1.5);
    float b = smoothstep(1.0, -0.1, length(p - vec2(cos(t * 0.8 + uSeed) * 0.4, 0.5)) * 1.6);
    float c = smoothstep(0.9, 0.0, length(p - vec2(0.35, 0.1)) * 1.7);

    vec3 colour = uBase;
    colour = mix(colour, uA, clamp(0.2 + a * 0.95, 0.0, 1.0));
    colour = mix(colour, uB, b * 0.85);
    colour = mix(colour, uC, c * 0.45);
    gl_FragColor = vec4(finish(colour, vUv), 1.0);
  }
`;

/**
 * Dead channel. Broadband static, rolling horizontal tear bands, a slow
 * vertical hold slip and a faint scanline beat. Time is quantised to a coarse
 * step so the grain jumps the way a broken signal does rather than shimmering
 * smoothly — a per-frame value that is still a pure function of time, so it
 * stays reproducible across the render workers.
 */
const STATIC = /* glsl */ `
  /**
   * Wrapped before hashing. This is the whole trick: vnoise feeds its argument
   * to fract(), which stops discriminating once the argument reaches the
   * hundreds at 32-bit float. The other fields never hit that because fbm
   * starts from a unit square; a static field indexes hundreds of cells
   * directly, and un-wrapped it collapses into flat grey. Wrapping at 64 tiles
   * the noise, which on television snow is not visible.
   */
  float cell(vec2 p) {
    return vnoise(mod(p, 64.0));
  }

  void main() {
    // Twelve steps a second, so the grain jumps like a dead channel instead of
    // shimmering. Still a pure function of time, so every worker agrees.
    float t = mod(floor(uTime * 12.0) / 12.0 + uSeed, 32.0);

    // Cells are sized against the treatment blur, not against realism: grain
    // finer than the blur radius is averaged away before it reaches the frame.
    float grain = cell(vec2(vUv.x * 120.0 + t * 7.0, vUv.y * 210.0 - t * 5.0));
    float speck = cell(vec2(vUv.y * 260.0 - t * 3.0, vUv.x * 160.0 + t * 11.0));
    float snow = clamp(grain * 0.85 + speck * 0.7, 0.0, 1.0);

    // A band of the picture tears sideways and resolves into different noise.
    float band = cell(vec2(vUv.y * 22.0, t * 3.0));
    float torn = smoothstep(0.74, 0.96, band);
    float shifted = cell(vec2((vUv.x + torn * 0.18) * 110.0 + t * 9.0, vUv.y * 200.0));
    snow = mix(snow, shifted, torn);

    // Scanlines, and a slow bright roll travelling up the frame.
    float scan = 0.74 + 0.26 * sin(vUv.y * 210.0);
    float roll = smoothstep(0.0, 0.12, abs(fract(vUv.y + t * 0.08) - 0.5));
    snow *= scan * mix(1.3, 1.0, roll);

    /**
     * A dead channel has no palette. Broadcast snow is achromatic — luminance
     * on a black screen — and running it through the beat's colours made this
     * the one field that never read as what it is: on a warm palette it came
     * out as brown mud rather than a broken signal.
     *
     * It also broke the imagery modes, which is the less obvious half. The
     * tinted snow was dark, and dark noise screened over a photograph changes
     * almost nothing, so "dissolved into the field" came back as a dim picture
     * with no field in it at all. Bright achromatic snow is what screen was
     * always waiting for: the darks stay transparent and the picture shows
     * through, and the white lands on top of it as interference.
     */
    float level = clamp(snow * 1.35, 0.0, 1.0);
    vec3 colour = vec3(0.02) + vec3(level * 0.98);
    gl_FragColor = vec4(finish(colour, vUv), 1.0);
  }
`;

export const FRAGMENTS: Record<string, string> = {
  gradient: PRELUDE + GRADIENT,
  clouds: PRELUDE + CLOUDS,
  fluid: PRELUDE + FLUID,
  aurora: PRELUDE + AURORA,
  static: PRELUDE + STATIC,
};

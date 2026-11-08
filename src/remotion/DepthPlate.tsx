import React, { useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { Img, continueRender, delayRender } from 'remotion';

/**
 * A still that moves like a filmed shot: the near part of the picture slides
 * past the far part.
 *
 * A push-in on a flat print scales everything by the same amount, and the eye
 * reads it as exactly that -- a zoom on a photograph. A real camera moving
 * through a room shows parallax: the lamp in front crosses the wall behind it.
 * Given a depth map, a fragment shader can fake that per pixel, which is the
 * "2.5D" move the cinematic edits are known for.
 *
 * The shader does not simply push each pixel by its depth -- that smears the
 * near subject over the background as a rubber sheet. For every output pixel
 * it walks from the nearest possible depth to the farthest, asking "if the
 * surface here were at this depth, where would it have come from, and is the
 * picture actually that near there?" The first yes is the nearest surface
 * that lands on this pixel, so a figure passes in front of the wall behind it
 * instead of dragging it along. A few bisection steps then find the edge
 * exactly, which is what keeps silhouettes clean rather than stepped.
 */

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform sampler2D uImage;
uniform sampler2D uDepth;
uniform vec2 uShift;
uniform float uZoom;
uniform float uFocus;
// Front layer: only the surfaces nearer than uMatte, on a transparent ground.
uniform float uFront;
uniform float uMatte;
// How far to shrink the near region back: the depth map was grown past every
// silhouette for the camera move, and a matte that size leaves a ring of
// background drawn over the caption all the way round the subject.
uniform vec2 uErode;
varying vec2 vUv;

// Where a surface at depth z, seen at output p, sits in the source picture.
vec2 source(vec2 p, float z) {
  float k = z - uFocus;
  vec2 q = p - uShift * k;
  return 0.5 + (q - 0.5) / (1.0 + uZoom * k);
}

void main() {
  const int STEPS = 28;
  vec2 hit = source(vUv, 0.0);
  float zHit = 0.0;
  for (int i = 0; i <= STEPS; i++) {
    float z = 1.0 - float(i) / float(STEPS);
    if (texture2D(uDepth, source(vUv, z)).r >= z) {
      float lo = z;
      float hi = min(1.0, z + 1.0 / float(STEPS));
      for (int j = 0; j < 5; j++) {
        float mid = 0.5 * (lo + hi);
        if (texture2D(uDepth, source(vUv, mid)).r >= mid) lo = mid; else hi = mid;
      }
      hit = source(vUv, lo);
      zHit = lo;
      break;
    }
  }
  vec2 at = clamp(hit, vec2(0.0), vec2(1.0));
  vec4 colour = texture2D(uImage, at);
  if (uFront < 0.5) {
    gl_FragColor = colour;
    return;
  }
  // The same surface the camera move found, so the matte moves with the
  // subject exactly -- then eroded, then cut at the picture's own threshold.
  float near = min(
    min(texture2D(uDepth, at + vec2(uErode.x, 0.0)).r, texture2D(uDepth, at - vec2(uErode.x, 0.0)).r),
    min(texture2D(uDepth, at + vec2(0.0, uErode.y)).r, texture2D(uDepth, at - vec2(0.0, uErode.y)).r)
  );
  near = min(near, zHit);
  float a = smoothstep(uMatte - 0.035, uMatte + 0.035, near);
  // Premultiplied, which is what the canvas composites.
  gl_FragColor = vec4(colour.rgb * a, a);
}
`;

export type Parallax = {
  /** How far the nearest surface moves against the farthest, in picture widths. */
  shift: [number, number];
  /** Extra scale the nearest surface gets over the farthest: a dolly. */
  zoom: number;
};

type Built = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  material: THREE.ShaderMaterial;
  dispose: () => void;
};

function loadTexture(url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.colorSpace = THREE.NoColorSpace;
        texture.minFilter = THREE.LinearFilter;
        texture.magFilter = THREE.LinearFilter;
        texture.generateMipmaps = false;
        texture.wrapS = THREE.ClampToEdgeWrapping;
        texture.wrapT = THREE.ClampToEdgeWrapping;
        resolve(texture);
      },
      undefined,
      () => reject(new Error(`could not load ${url}`)),
    );
  });
}

export const DepthPlate: React.FC<{
  src: string;
  depthSrc: string;
  parallax: Parallax;
  style: React.CSSProperties;
  /**
   * Draw only what is nearer than this depth, on a transparent ground: the
   * layer that goes back over a caption set into the picture.
   */
  front?: number;
}> = ({ src, depthSrc, parallax, style, front }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const builtRef = useRef<Built | null>(null);
  const parallaxRef = useRef(parallax);
  parallaxRef.current = parallax;
  const [handle] = useState(() => delayRender(`depth plate: ${src}`));
  const [failed, setFailed] = useState(false);

  const draw = (built: Built) => {
    const current = parallaxRef.current;
    built.material.uniforms['uShift']!.value.set(current.shift[0], current.shift[1]);
    built.material.uniforms['uZoom']!.value = current.zoom;
    built.renderer.render(built.scene, built.camera);
  };

  // Both textures first, then a context sized to the picture itself -- so the
  // shader samples one texel per pixel and the CSS does the only scaling.
  useLayoutEffect(() => {
    let cancelled = false;
    Promise.all([loadTexture(src), loadTexture(depthSrc)])
      .then(([image, depth]) => {
        if (cancelled) {
          image.dispose();
          depth.dispose();
          // Released even so, or a plate unmounted mid-load holds the render.
          continueRender(handle);
          return;
        }
        const element = image.image as HTMLImageElement;
        /**
         * Sized here and only here. Sizing it through React state re-rendered
         * the canvas after the first draw, and assigning a canvas's width --
         * even to the value it already has -- clears it: the frame Remotion
         * captured was blank.
         */
        const canvas = canvasRef.current;
        if (canvas === null) throw new Error('no canvas');
        canvas.width = element.naturalWidth || element.width;
        canvas.height = element.naturalHeight || element.height;

        const layered = front !== undefined;
        const renderer = new THREE.WebGLRenderer({
          canvas,
          antialias: false,
          alpha: layered,
          premultipliedAlpha: true,
        });
        renderer.setPixelRatio(1);
        renderer.setSize(canvas.width, canvas.height, false);
        if (layered) renderer.setClearColor(0x000000, 0);
        renderer.outputColorSpace = THREE.LinearSRGBColorSpace;

        const material = new THREE.ShaderMaterial({
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            uImage: { value: image },
            uDepth: { value: depth },
            uShift: { value: new THREE.Vector2(0, 0) },
            uZoom: { value: 0 },
            uFocus: { value: 0.5 },
            uFront: { value: layered ? 1 : 0 },
            uMatte: { value: front ?? 1 },
            // The grow in localvision.ts is width/280 pixels, then blurred;
            // a little more than that, in each axis's own units.
            uErode: {
              value: new THREE.Vector2(1.4 / 280, (1.4 / 280) * (canvas.width / canvas.height)),
            },
          },
        });
        const scene = new THREE.Scene();
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
        mesh.frustumCulled = false;
        scene.add(mesh);

        const built: Built = {
          renderer,
          scene,
          camera: new THREE.Camera(),
          material,
          dispose: () => {
            mesh.geometry.dispose();
            material.dispose();
            image.dispose();
            depth.dispose();
            renderer.dispose();
            // A tab can only hold so many contexts, and a long essay mounts
            // a new plate every few seconds.
            renderer.forceContextLoss();
          },
        };
        builtRef.current = built;
        draw(built);
        continueRender(handle);
      })
      .catch((error: unknown) => {
        console.error('breezematic: depth plate fell back to a flat still', error);
        if (!cancelled) setFailed(true);
        continueRender(handle);
      });
    return () => {
      cancelled = true;
      builtRef.current?.dispose();
      builtRef.current = null;
    };
  }, [src, depthSrc, front]);

  // Every frame after the first: new uniforms, one draw, before the paint.
  useLayoutEffect(() => {
    const built = builtRef.current;
    if (built !== null) draw(built);
  });

  if (failed) {
    // A front layer that cannot be drawn draws nothing: the caption simply
    // sits over the picture, which is a caption, rather than a second copy
    // of the whole picture covering it, which is a missing caption.
    return front !== undefined ? null : <Img src={src} style={style} />;
  }
  return <canvas ref={canvasRef} style={{ ...style, display: 'block' }} />;
};

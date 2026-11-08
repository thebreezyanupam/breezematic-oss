import { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { continueRender, delayRender, useCurrentFrame, useVideoConfig } from 'remotion';
import { FRAGMENTS, VERTEX } from './shaders.js';

export type ShaderFieldProps = {
  effect: string;
  base: string;
  colours: readonly string[];
  seed: number;
};

type Scene = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
  material: THREE.ShaderMaterial;
};

/**
 * Raw three.js rather than react-three-fiber: the whole effect is one
 * fullscreen quad, and driving `render()` by hand from a layout effect puts
 * the GL frame on the canvas before the browser paints, which is what Remotion
 * screenshots.
 */
export const ShaderField: React.FC<ShaderFieldProps> = ({ effect, base, colours, seed }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<Scene | null>(null);
  const handleRef = useRef<number | null>(null);

  if (handleRef.current === null) {
    handleRef.current = delayRender(`shader field: ${effect}`);
  }

  // A canvas can only ever hand out one WebGL context, so the scene is built
  // from a string key rather than from the colour array — a fresh array every
  // render would tear the renderer down and rebuild it on every frame, and the
  // second context request returns nothing.
  const key = `${effect}|${base}|${colours.join(',')}|${width}x${height}`;

  const palette = useMemo(
    () => ({
      base: new THREE.Color(base),
      a: new THREE.Color(colours[0] ?? base),
      b: new THREE.Color(colours[1] ?? colours[0] ?? base),
      c: new THREE.Color(colours[2] ?? colours[0] ?? base),
    }),
    [key],
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false });
    } catch (error) {
      console.error('breezematic: no WebGL context', error);
      return;
    }
    renderer.setPixelRatio(1);
    renderer.setSize(width, height, false);

    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENTS[effect] ?? FRAGMENTS['gradient'] ?? '',
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uAspect: { value: width / height },
        uSeed: { value: 0 },
        uBase: { value: palette.base },
        uA: { value: palette.a },
        uB: { value: palette.b },
        uC: { value: palette.c },
      },
    });

    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
    mesh.frustumCulled = false;
    scene.add(mesh);

    sceneRef.current = { renderer, scene, camera: new THREE.Camera(), material };

    return () => {
      mesh.geometry.dispose();
      material.dispose();
      renderer.dispose();
      sceneRef.current = null;
    };
  }, [key, palette, width, height, effect]);

  useLayoutEffect(() => {
    const current = sceneRef.current;
    if (current === null) return;

    current.material.uniforms['uTime']!.value = frame / fps;
    current.material.uniforms['uSeed']!.value = (seed % 1000) / 97;
    current.renderer.render(current.scene, current.camera);

    const programs = current.renderer.info.programs;
    if (programs !== null && programs.length === 0) {
      console.error('breezematic: shader did not compile for effect', effect);
    }

    if (handleRef.current !== null) {
      continueRender(handleRef.current);
      handleRef.current = null;
    }
  });

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
    />
  );
};

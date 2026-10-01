"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import * as THREE from "three";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";

export type ViewerHandle = {
  /** Renders the model from 4 angles and returns PNG data URLs. */
  capture: () => Promise<string[]>;
};

export type ModelInfo = { x: number; y: number; z: number; triangles: number };

type Props = {
  stl: ArrayBuffer | null;
  handleRef: RefObject<ViewerHandle | null>;
  onInfo?: (info: ModelInfo | null) => void;
};

export default function Viewer({ stl, handleRef, onInfo }: Props) {
  const geometry = useMemo(() => {
    if (!stl) return null;
    const g = new STLLoader().parse(stl);
    g.computeBoundingBox();
    const bb = g.boundingBox!;
    // Centre on X/Y, sit on the bed at Z=0 (OpenSCAD is Z-up).
    g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
    g.computeVertexNormals();
    g.computeBoundingBox();
    return g;
  }, [stl]);

  useEffect(() => {
    if (!geometry) return onInfo?.(null);
    const s = new THREE.Vector3();
    geometry.boundingBox!.getSize(s);
    onInfo?.({ x: s.x, y: s.y, z: s.z, triangles: geometry.attributes.position.count / 3 });
    return () => geometry.dispose();
  }, [geometry, onInfo]);

  return (
    <Canvas
      shadows
      camera={{ position: [60, 60, 60], fov: 40, near: 0.1, far: 5000 }}
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      className="!h-full !w-full"
    >
      <color attach="background" args={["#0f1115"]} />
      <hemisphereLight args={["#ffffff", "#334155", 1.1]} />
      <directionalLight position={[80, 140, 60]} intensity={1.6} castShadow />
      <directionalLight position={[-90, 60, -80]} intensity={0.5} />
      <Scene geometry={geometry} handleRef={handleRef} />
    </Canvas>
  );
}

function Scene({ geometry, handleRef }: { geometry: THREE.BufferGeometry | null; handleRef: RefObject<ViewerHandle | null> }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl, scene, invalidate } = useThree();

  const radius = useMemo(() => {
    if (!geometry) return 30;
    const sphere = new THREE.Sphere();
    geometry.boundingBox!.getBoundingSphere(sphere);
    return Math.max(sphere.radius, 5);
  }, [geometry]);

  const height = geometry ? geometry.boundingBox!.max.z : 0;
  // Grid: 10 mm cells, sized to the model.
  const gridSize = Math.max(50, Math.ceil((radius * 3) / 10) * 10);

  // Frame the model whenever it changes size significantly.
  const lastRadius = useRef(0);
  useEffect(() => {
    if (!geometry) return;
    if (Math.abs(lastRadius.current - radius) / radius < 0.25) return;
    lastRadius.current = radius;
    const d = radius * 3.2;
    camera.position.set(d * 0.7, d * 0.6, d * 0.7);
    controls.current?.target.set(0, height / 2, 0);
    controls.current?.update();
  }, [geometry, radius, height, camera]);

  useEffect(() => {
    handleRef.current = {
      capture: async () => {
        const cam = camera as THREE.PerspectiveCamera;
        const savedPos = cam.position.clone();
        const savedTarget = controls.current?.target.clone() ?? new THREE.Vector3();
        const target = new THREE.Vector3(0, height / 2, 0);
        const d = radius * 3.2;
        const views: [number, number, number][] = [
          [0, height / 2, d], // front
          [d, height / 2, 0], // side
          [0, d, 0.001], // top
          [d * 0.7, d * 0.6, d * 0.7], // iso
        ];
        const out: string[] = [];
        for (const v of views) {
          cam.position.set(...v);
          cam.lookAt(target);
          cam.updateMatrixWorld();
          gl.render(scene, cam);
          out.push(downscale(gl.domElement, 768));
        }
        cam.position.copy(savedPos);
        controls.current?.target.copy(savedTarget);
        controls.current?.update();
        invalidate();
        return out;
      },
    };
  }, [camera, gl, scene, radius, height, handleRef, invalidate]);

  return (
    <>
      <OrbitControls ref={controls} makeDefault enableDamping />
      <gridHelper args={[gridSize, gridSize / 10, "#475569", "#1e293b"]} />
      {geometry && (
        // Rotate Z-up (OpenSCAD) to Y-up (three.js)
        <group rotation={[-Math.PI / 2, 0, 0]}>
          <mesh geometry={geometry} castShadow receiveShadow>
            <meshStandardMaterial color="#f59e0b" roughness={0.55} metalness={0.05} />
          </mesh>
        </group>
      )}
    </>
  );
}

function downscale(src: HTMLCanvasElement, max: number) {
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext("2d")!.drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}

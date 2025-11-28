"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type PlotPoints = {
     x: number[];
     y: number[];
     z: number[];
     text: string[];
};

type ThreeEmbeddingViewerProps = {
     points: PlotPoints;
     pointSize: number;
};

const clampPointSize = (value: number) => Math.min(Math.max(value, 2), 60);

const buildColor = (idx: number, total: number) => {
     const color = new THREE.Color();
     const hue = total > 0 ? idx / total : 0;
     color.setHSL(hue, 0.6, 0.55);
     return color;
};

const normalizeValue = (value: number, center: number, spread: number) => {
     if (!Number.isFinite(value)) {
          return 0;
     }
     const safeSpread = spread <= 0 ? 1 : spread;
     return ((value - center) / safeSpread) * 6;
};

const createAxisLabelSprite = (text: string, color: string) => {
     const canvas = document.createElement("canvas");
     const size = 128;
     canvas.width = size;
     canvas.height = size;
     const ctx = canvas.getContext("2d");
     if (!ctx) {
          return new THREE.Sprite();
     }
     ctx.clearRect(0, 0, size, size);
     ctx.fillStyle = "rgba(0,0,0,0)";
     ctx.fillRect(0, 0, size, size);
     ctx.font = "bold 72px Inter, sans-serif";
     ctx.fillStyle = color;
     ctx.textAlign = "center";
     ctx.textBaseline = "middle";
     ctx.fillText(text, size / 2, size / 2);

     const texture = new THREE.CanvasTexture(canvas);
     texture.needsUpdate = true;
     const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
     const sprite = new THREE.Sprite(material);
     sprite.scale.set(0.64, 0.64, 0.64);
     return sprite;
};

export default function ThreeEmbeddingViewer({ points, pointSize }: ThreeEmbeddingViewerProps) {
     const mountRef = useRef<HTMLDivElement>(null);
     const hoverLabelRef = useRef<HTMLDivElement>(null);
     const compassRef = useRef<HTMLDivElement>(null);

     useEffect(() => {
          const mount = mountRef.current;
          if (!mount) {
               return undefined;
          }

          const compassMount = compassRef.current;
          const hoverLabel = hoverLabelRef.current;
          const count = Math.min(points.x.length, points.y.length, points.z.length);

          if (count === 0) {
               mount.innerHTML = "";
               if (compassMount) {
                    compassMount.innerHTML = "";
               }
               return undefined;
          }

          mount.innerHTML = "";
          const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
          renderer.setPixelRatio(window.devicePixelRatio ?? 1);
          renderer.setSize(mount.clientWidth, mount.clientHeight);
          renderer.setClearColor(0x000000, 0);
          mount.appendChild(renderer.domElement);

          const scene = new THREE.Scene();
          const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.01, 1000);
          camera.position.set(4, 4, 4);

          const controls = new OrbitControls(camera, renderer.domElement);
          controls.enableDamping = true;
          controls.dampingFactor = 0.08;
          controls.minDistance = 1.5;
          controls.maxDistance = 32;

          const positionAttribute = new Float32Array(count * 3);
          const colorAttribute = new Float32Array(count * 3);
          const xValues = points.x;
          const yValues = points.y;
          const zValues = points.z;

          const minX = Math.min(...xValues);
          const maxX = Math.max(...xValues);
          const minY = Math.min(...yValues);
          const maxY = Math.max(...yValues);
          const minZ = Math.min(...zValues);
          const maxZ = Math.max(...zValues);
          const centerX = (minX + maxX) / 2;
          const centerY = (minY + maxY) / 2;
          const centerZ = (minZ + maxZ) / 2;
          const spread = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1);

          for (let i = 0; i < count; i += 1) {
               const posIndex = i * 3;
               positionAttribute[posIndex] = normalizeValue(xValues[i], centerX, spread);
               positionAttribute[posIndex + 1] = normalizeValue(yValues[i], centerY, spread);
               positionAttribute[posIndex + 2] = normalizeValue(zValues[i], centerZ, spread);

               const { r, g, b } = buildColor(i, count - 1);
               colorAttribute[posIndex] = r;
               colorAttribute[posIndex + 1] = g;
               colorAttribute[posIndex + 2] = b;
          }

          const geometry = new THREE.BufferGeometry();
          const bufferPositions = new THREE.BufferAttribute(positionAttribute, 3);
          geometry.setAttribute("position", bufferPositions);
          geometry.setAttribute("color", new THREE.BufferAttribute(colorAttribute, 3));

          const material = new THREE.PointsMaterial({
               size: clampPointSize(pointSize) * 0.035,
               vertexColors: true,
               transparent: true,
               opacity: 0.9,
               depthWrite: false,
          });

          const pointCloud = new THREE.Points(geometry, material);
          scene.add(pointCloud);

          const raycaster = new THREE.Raycaster();
          const pointer = new THREE.Vector2();
          let hoveredIndex: number | null = null;

          const updateHoverLabel = (label: string | null) => {
               if (!hoverLabel) {
                    return;
               }
               hoverLabel.textContent = label ?? "None";
          };

          // Initialize label
          updateHoverLabel(null);

          const handlePointerMove = (event: PointerEvent) => {
               if (event.buttons === 1) {
                    hoveredIndex = null;
                    updateHoverLabel(null);
                    return;
               }
               const rect = renderer.domElement.getBoundingClientRect();
               pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
               pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
               raycaster.setFromCamera(pointer, camera);
               const intersects = raycaster.intersectObject(pointCloud);
               if (intersects.length > 0 && typeof intersects[0].index === "number") {
                    hoveredIndex = intersects[0].index;
                    updateHoverLabel(points.text[hoveredIndex] ?? `Point ${hoveredIndex + 1}`);
               } else {
                    hoveredIndex = null;
                    updateHoverLabel(null);
               }
          };

          const handlePointerLeave = () => {
               hoveredIndex = null;
               updateHoverLabel(null);
          };

          renderer.domElement.addEventListener("pointermove", handlePointerMove);
          renderer.domElement.addEventListener("pointerleave", handlePointerLeave);

          let compassRenderer: THREE.WebGLRenderer | null = null;
          let compassScene: THREE.Scene | null = null;
          let compassCamera: THREE.PerspectiveCamera | null = null;
          let compassRoot: THREE.Object3D | null = null;

          if (compassMount) {
               compassMount.innerHTML = "";
               compassRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
               compassRenderer.setPixelRatio(window.devicePixelRatio ?? 1);
               compassRenderer.setSize(compassMount.clientWidth, compassMount.clientHeight);
               compassMount.appendChild(compassRenderer.domElement);

               compassScene = new THREE.Scene();
               compassCamera = new THREE.PerspectiveCamera(35, 1, 0.1, 10);
               compassCamera.position.set(0, 0, 3);

               const ambient = new THREE.AmbientLight(0xffffff, 1.1);
               const directional = new THREE.DirectionalLight(0xffffff, 0.8);
               directional.position.set(2, 2, 3);
               compassScene.add(ambient, directional);

               compassRoot = new THREE.Object3D();
               compassScene.add(compassRoot);

               const sphere = new THREE.Mesh(
                    new THREE.SphereGeometry(0.75, 32, 32),
                    new THREE.MeshStandardMaterial({
                         color: 0x111827,
                         metalness: 0.25,
                         roughness: 0.65,
                         opacity: 0.85,
                         transparent: true,
                    })
               );
               compassRoot.add(sphere);

               const axisLength = 1.4;
               const axisRadius = 0.025;
               const axisGeometry = new THREE.CylinderGeometry(axisRadius, axisRadius, axisLength, 16);
               const buildAxis = (color: number, axis: "x" | "y" | "z") => {
                    const mesh = new THREE.Mesh(axisGeometry, new THREE.MeshStandardMaterial({ color }));
                    switch (axis) {
                         case "x":
                              mesh.rotation.z = Math.PI / 2;
                              mesh.position.x = axisLength / 2 - 0.2;
                              break;
                         case "y":
                              mesh.position.y = axisLength / 2 - 0.2;
                              break;
                         case "z":
                              mesh.rotation.x = Math.PI / 2;
                              mesh.position.z = axisLength / 2 - 0.2;
                              break;
                         default:
                              break;
                    }
                    compassRoot?.add(mesh);
               };

               buildAxis(0xf87171, "x");
               buildAxis(0x34d399, "y");
               buildAxis(0x60a5fa, "z");

               const labelOffset = 1.05;
               const labelX = createAxisLabelSprite("X", "#f87171");
               labelX.position.set(labelOffset, 0, 0);
               const labelY = createAxisLabelSprite("Y", "#34d399");
               labelY.position.set(0, labelOffset, 0);
               const labelZ = createAxisLabelSprite("Z", "#60a5fa");
               labelZ.position.set(0, 0, labelOffset);
               compassRoot.add(labelX, labelY, labelZ);
          }

          const resizeObserver =
               typeof ResizeObserver !== "undefined"
                    ? new ResizeObserver((entries) => {
                           for (const entry of entries) {
                                if (entry.contentRect.width === 0 || entry.contentRect.height === 0) {
                                     continue;
                                }
                                const { width, height } = entry.contentRect;
                                camera.aspect = width / height;
                                camera.updateProjectionMatrix();
                                renderer.setSize(width, height);
                           }
                      })
                    : null;
          resizeObserver?.observe(mount);

          let animationFrame: number;
          const animate = () => {
               controls.update();
               renderer.render(scene, camera);
               if (compassRenderer && compassScene && compassCamera && compassRoot) {
                    compassRoot.quaternion.copy(camera.quaternion);
                    compassRenderer.render(compassScene, compassCamera);
               }
               animationFrame = requestAnimationFrame(animate);
          };
          animate();

          return () => {
               cancelAnimationFrame(animationFrame);
               resizeObserver?.disconnect();
               renderer.domElement.removeEventListener("pointermove", handlePointerMove);
               renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
               controls.dispose();
               geometry.dispose();
               material.dispose();
               renderer.dispose();
               if (mount.contains(renderer.domElement)) {
                    mount.removeChild(renderer.domElement);
               }
               if (compassRenderer && compassMount && compassRenderer.domElement.parentElement === compassMount) {
                    compassMount.removeChild(compassRenderer.domElement);
                    compassRenderer.dispose();
               }
          };
     }, [points, pointSize]);

     return (
          <div className="relative h-full w-full">
               <div ref={mountRef} className="h-full w-full" />
               <div
                    ref={hoverLabelRef}
                    className="pointer-events-none absolute top-3 left-3 max-w-[50%] truncate rounded-md bg-black/80 px-3 py-1.5 text-xs text-white shadow-lg"
               >
                    None
               </div>
               <div
                    ref={compassRef}
                    className="pointer-events-none absolute bottom-3 left-3 h-24 w-24 overflow-hidden rounded-full border border-white/10 bg-black/30 backdrop-blur-sm"
               />
               <div className="pointer-events-none absolute bottom-3 right-4 rounded-full bg-black/60 px-3 py-1 text-[10px] uppercase tracking-wide text-white">
                    Drag to rotate · Scroll to zoom
               </div>
          </div>
     );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { PCDLoader } from "three/examples/jsm/loaders/PCDLoader.js";
import { XMLParser } from "fast-xml-parser";
import { applyProjection, ProjectionConfig } from "./projection";
import "./overlay.css";

export type OpenHDMapViewerProps = {
  vectorUrl: string;
  pointcloudUrl: string;
  projectionMode?: "identity" | "proj4";
  proj4From?: string;
  proj4To?: string;
  vectorFlipY?: boolean;
  defaultPointSize?: number; // 0.1
  defaultDensityPercent?: number; // 40
  style?: React.CSSProperties; // container size
};

export const OpenHDMapViewer: React.FC<OpenHDMapViewerProps> = ({
  vectorUrl,
  pointcloudUrl,
  projectionMode = "identity",
  proj4From = "EPSG:4326",
  proj4To = "EPSG:3857",
  vectorFlipY = true,
  defaultPointSize = 0.1,
  defaultDensityPercent = 40,
  style
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer>();
  const sceneRef = useRef<THREE.Scene>();
  const cameraRef = useRef<THREE.PerspectiveCamera>();
  const controlsRef = useRef<OrbitControls>();
  const cloudGroupRef = useRef(new THREE.Group());
  const vectorGroupRef = useRef(new THREE.Group());
  const currentPointRef = useRef<THREE.Points | null>(null);
  const originalGeomRef = useRef<THREE.BufferGeometry | null>(null);

  const [pointSize, setPointSize] = useState(defaultPointSize);
  const [density, setDensity] = useState(defaultDensityPercent);
  const [showCloud, setShowCloud] = useState(true);
  const [showVector, setShowVector] = useState(true);
  const [status, setStatus] = useState("Initializing ...");

  const proj: ProjectionConfig = useMemo(() => (
    projectionMode === "proj4"
      ? { mode: "proj4", from: proj4From, to: proj4To }
      : { mode: "identity" }
  ), [projectionMode, proj4From, proj4To]);

  useEffect(() => {
    const mount = mountRef.current!;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    rendererRef.current = renderer;
    const width = mount.clientWidth;
    const height = mount.clientHeight;
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    mount.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d0f12);
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(60, width / height, 0.1, 1e8);
    camera.position.set(60, 60, 60);
    cameraRef.current = camera;

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.8));
    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(100, 200, 100);
    scene.add(dir);

    scene.add(vectorGroupRef.current);
    scene.add(cloudGroupRef.current);

    const onResize = () => {
      if (!rendererRef.current || !cameraRef.current) return;
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", onResize);

    let raf = 0;
    const tick = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  const updatePointCloudSettings = () => {
    const points = currentPointRef.current;
    const originalGeom = originalGeomRef.current;
    if (!points || !originalGeom) return;

    // size
    // @ts-ignore
    (points.material as THREE.PointsMaterial).size = pointSize;

    // density
    const originalPositions = originalGeom.getAttribute("position");
    const originalColors = originalGeom.getAttribute("color");

    const densityRatio = Math.max(0.01, Math.min(1, density / 100));
    if (densityRatio < 1) {
      const totalPoints = originalPositions.count;
      const targetPoints = Math.floor(totalPoints * densityRatio);
      const indices = new Array(totalPoints).fill(0).map((_, i) => i);
      for (let i = indices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [indices[i], indices[j]] = [indices[j], indices[i]];
      }
      const sampled = indices.slice(0, targetPoints);
      const newPositions = new Float32Array(targetPoints * 3);
      const newColors = new Float32Array(targetPoints * 3);
      for (let i = 0; i < targetPoints; i++) {
        const idx = sampled[i];
        newPositions[i * 3] = originalPositions.getX(idx);
        newPositions[i * 3 + 1] = originalPositions.getY(idx);
        newPositions[i * 3 + 2] = originalPositions.getZ(idx);
        if (originalColors) {
          newColors[i * 3] = (originalColors as any).getX(idx);
          newColors[i * 3 + 1] = (originalColors as any).getY(idx);
          newColors[i * 3 + 2] = (originalColors as any).getZ(idx);
        }
      }
      const newGeom = new THREE.BufferGeometry();
      newGeom.setAttribute("position", new THREE.BufferAttribute(newPositions, 3));
      if (originalColors) newGeom.setAttribute("color", new THREE.BufferAttribute(newColors, 3));
      points.geometry.dispose();
      points.geometry = newGeom;
    } else {
      points.geometry.dispose();
      points.geometry = originalGeom.clone();
    }
  };

  const loadPointCloud = async (url: string) => {
    setStatus(`Loading point cloud: ${url}`);
    const loader = new PCDLoader();
    const obj = await loader.loadAsync(url);
    obj.rotation.x = -Math.PI / 2;
    originalGeomRef.current = obj.geometry.clone();
    currentPointRef.current = obj;
    cloudGroupRef.current.add(obj);
    setStatus("Point cloud loaded.");
    updatePointCloudSettings();
  };

  const loadLanelet = async (url: string) => {
    setStatus(`Loading vector map: ${url}`);
    const xmlText = await (await fetch(url)).text();
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
    const osm = parser.parse(xmlText)?.osm;
    const nodeMap = new Map();
    const nodes = Array.isArray(osm.node) ? osm.node : [osm.node];
    for (const n of nodes) {
      const id = n.id;
      let x: number | null = null, y: number | null = null, z = 0;
      if (n.tag) {
        const tags = Array.isArray(n.tag) ? n.tag : [n.tag];
        for (const t of tags) {
          if (t.k === "local_x") x = parseFloat(t.v);
          if (t.k === "local_y") y = parseFloat(t.v);
          if (t.k === "ele") z = parseFloat(t.v);
        }
      }
      if (x !== null && y !== null) nodeMap.set(id, { x, y, z });
    }

    // clear previous
    vectorGroupRef.current.children.forEach(obj => {
      if ((obj as any).geometry) (obj as any).geometry.dispose();
    });
    vectorGroupRef.current.clear();

    const ways = Array.isArray(osm.way) ? osm.way : [osm.way];
    for (const w of ways) {
      if (!w.nd) continue;
      const nds = Array.isArray(w.nd) ? w.nd : [w.nd];
      const pts: THREE.Vector3[] = [];
      for (const nd of nds) {
        const node = nodeMap.get(nd.ref);
        if (!node) continue;
        const [X, Y, Z] = applyProjection([node.x, node.y, node.z], proj);
        const Yup = vectorFlipY ? -Y : Y;
        pts.push(new THREE.Vector3(X, Z, Yup));
      }
      if (pts.length > 1) {
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        const mat = new THREE.LineBasicMaterial({ color: 0xffc107, transparent: true, opacity: 0.95 });
        const line = new THREE.Line(geom, mat);
        vectorGroupRef.current.add(line);
      }
    }
    setStatus("Vector map loaded.");
  };

  useEffect(() => {
    if (!pointcloudUrl || !vectorUrl) return;
    // reset groups
    cloudGroupRef.current.clear();
    vectorGroupRef.current.clear();
    loadPointCloud(pointcloudUrl);
    loadLanelet(vectorUrl);
  }, [pointcloudUrl, vectorUrl, proj, vectorFlipY]);

  // vis toggles
  useEffect(() => {
    cloudGroupRef.current.visible = showCloud;
  }, [showCloud]);
  useEffect(() => {
    vectorGroupRef.current.visible = showVector;
  }, [showVector]);

  // update on sliders
  useEffect(() => { updatePointCloudSettings(); }, [pointSize]);
  useEffect(() => { updatePointCloudSettings(); }, [density]);

  return (
    <div style={{ position: "relative", ...style }} ref={mountRef}>
      <div className="overlay">
        <div className="panel">
          <h1>OpenHD Map Viewer</h1>
          <div>{status}</div>
          <div className="controls">
            <label><input type="checkbox" checked={showCloud} onChange={e=>setShowCloud(e.target.checked)} /> Point Cloud Layer</label>
            <label><input type="checkbox" checked={showVector} onChange={e=>setShowVector(e.target.checked)} /> Vector Map Layer</label>
          </div>
          <div className="point-cloud-controls">
            <div className="control-group">
              <label>Point Size: <span>{pointSize.toFixed(2)}</span></label>
              <input type="range" min={0.1} max={2} step={0.05} value={pointSize} onChange={e=>setPointSize(parseFloat(e.target.value))} />
            </div>
            <div className="control-group">
              <label>Density: <span>{density}</span>%</label>
              <input type="range" min={1} max={50} step={1} value={density} onChange={e=>setDensity(parseInt(e.target.value))} />
            </div>
            <div className="control-group">
              <label>Update files:</label>
              <input type="file" accept=".pcd" onChange={e=>{ const f=e.target.files?.[0]; if (f) loadPointCloud(URL.createObjectURL(f)); }} />
              <input type="file" accept=".osm,.xml" onChange={e=>{ const f=e.target.files?.[0]; if (f) loadLanelet(URL.createObjectURL(f)); }} />
            </div>
        </div>
      </div>
      </div>
    </div>
  );
};



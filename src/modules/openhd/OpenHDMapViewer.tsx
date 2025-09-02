import React, { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { PCDLoader } from "three/addons/loaders/PCDLoader.js";
import { XMLParser } from "fast-xml-parser";
import { applyProjection, ProjectionConfig } from "./projection";
import yaml from "js-yaml";
import "./overlay.css";

export type MapOrigin = {
  lat: number;  // degrees
  lon: number;  // degrees
  ele: number;  // meters
  roll: number; // radians (ENU: roll about East/X)
  pitch: number;// radians (ENU: pitch about North/Z in ENU; see viewer mapping below)
  yaw: number;  // radians (ENU: yaw about Up/Y)
};

export type MapConfigPayload = {
  origin: MapOrigin;
  isTemporary: true; // explicit signal that this came from the loader temp source
};

export type OpenHDMapViewerProps = {
  vectorUrl: string;
  pointcloudUrl: string;
  projectionMode?: "identity" | "proj4";
  proj4From?: string;
  proj4To?: string;
  vectorFlipY?: boolean;
  pcdAxisPreset?: "Zup" | "Yup"; // default "Yup" to preserve current behavior
  mapOrigin?: MapOrigin; // optional, from loader
  applyOriginOffset?: boolean; // default false; if true, subtract origin E/N/U or apply via mapFrameRef
  applyOriginRPY?: boolean; // default false; if true, apply RPY to mapFrameRef
  defaultPointSize?: number; // 0.1
  defaultDensityPercent?: number; // 35
  showLineDirections?: boolean; // false
  style?: React.CSSProperties; // container size
};

export const OpenHDMapViewer: React.FC<OpenHDMapViewerProps> = ({
  vectorUrl,
  pointcloudUrl,
  projectionMode = "identity",
  proj4From = "EPSG:4326",
  proj4To = "EPSG:3857",
  vectorFlipY = true,
  pcdAxisPreset = "Yup",
  mapOrigin,
  applyOriginOffset = false,
  applyOriginRPY = false,
  defaultPointSize = 0.1,
  defaultDensityPercent = 35,
  showLineDirections = false,
  style
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer>();
  const sceneRef = useRef<THREE.Scene>();
  const cameraRef = useRef<THREE.PerspectiveCamera>();
  const controlsRef = useRef<OrbitControls>();
  const mapFrameRef = useRef(new THREE.Group());
  const cloudGroupRef = useRef(new THREE.Group());
  const vectorGroupRef = useRef(new THREE.Group());
  const directionGroupRef = useRef(new THREE.Group());
  const currentPointRef = useRef<THREE.Points | null>(null);
  const originalGeomRef = useRef<THREE.BufferGeometry | null>(null);
  const sharedArrowGeometryRef = useRef<THREE.ConeGeometry | null>(null);
  const sharedArrowMaterialRef = useRef<THREE.MeshBasicMaterial | null>(null);
  const sharedLineMaterialRef = useRef<THREE.LineBasicMaterial | null>(null);
  const cachedWaysRef = useRef<any[]>([]);
  const cachedNodeMapRef = useRef<Map<any, any>>(new Map());

  const [pointSize, setPointSize] = useState(defaultPointSize);
  const [density, setDensity] = useState(defaultDensityPercent);
  const [showCloud, setShowCloud] = useState(true);
  const [showVector, setShowVector] = useState(true);
  const [showDirections, setShowDirections] = useState(showLineDirections);
  const [status, setStatus] = useState("Initializing ...");
  const [isLoadingPointCloud, setIsLoadingPointCloud] = useState(false);
  const [isLoadingVectorMap, setIsLoadingVectorMap] = useState(false);
  const [isCreatingArrows, setIsCreatingArrows] = useState(false);
  
  // File loading state
  const [loadedFiles, setLoadedFiles] = useState<{
    pointcloud?: File;
    vector?: File;
    mapProjectorInfo?: File;
    mapConfig?: File;
  }>({});

  // Projector metadata state
  const [projectorMeta, setProjectorMeta] = useState<{
    projector: "Local" | "MGRS" | "Unknown";
    mgrsGrid?: string;
    usingLocalTags: boolean;
    usingProj4: boolean;
    utmEpsg?: string;
  }>({ projector: "Unknown", usingLocalTags: true, usingProj4: false });

  // Origin offset state
  const [originOffset, setOriginOffset] = useState<{ E: number; N: number; U: number } | null>(null);
  const [tempMapOrigin, setTempMapOrigin] = useState<MapOrigin | null>(null);

  // Load token to prevent async races
  const loadTokenRef = useRef(0);

  // Store projection parameters for arrow creation
  const [currentProjParams, setCurrentProjParams] = useState<{
    usingProj4: boolean;
    projForThisMap?: ProjectionConfig;
  }>({ usingProj4: false });

  // Individual frame refs for separate layer control
  const vectorFrameRef = useRef(new THREE.Group());
  const cloudFrameRef = useRef(new THREE.Group());

  // Store normalization origin for alignment
  const normOriginRef = useRef<{ E0: number; N0: number; U0: number } | null>(null);

  // Stats for diagnostics
  const [layerStats, setLayerStats] = useState<{
    vectorCentroid?: THREE.Vector3;
    cloudCentroid?: THREE.Vector3;
    vectorRadius?: number;
    cloudRadius?: number;
    originSource?: string;
  }>({});

  const proj: ProjectionConfig = useMemo(() => (
    projectionMode === "proj4"
      ? { mode: "proj4", from: proj4From, to: proj4To }
      : { mode: "identity" }
  ), [projectionMode, proj4From, proj4To]);

  const isLoading = isLoadingPointCloud || isLoadingVectorMap || isCreatingArrows;

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

    // Set up frame hierarchy: individual frames for separate layer control
    vectorFrameRef.current.add(vectorGroupRef.current);
    vectorFrameRef.current.add(directionGroupRef.current); // arrows belong with vectors
    cloudFrameRef.current.add(cloudGroupRef.current);
    
    mapFrameRef.current.add(vectorFrameRef.current);
    mapFrameRef.current.add(cloudFrameRef.current);
    scene.add(mapFrameRef.current);

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
      
      // Cleanup shared resources
      if (sharedArrowGeometryRef.current) {
        sharedArrowGeometryRef.current.dispose();
      }
      if (sharedArrowMaterialRef.current) {
        sharedArrowMaterialRef.current.dispose();
      }
      if (sharedLineMaterialRef.current) {
        sharedLineMaterialRef.current.dispose();
      }
    };
  }, []);

  const updatePointCloudSettings = () => {
    const points = currentPointRef.current;
    const originalGeom = originalGeomRef.current;
    if (!points || !originalGeom) return;

    // Update point size
    const material = points.material as THREE.PointsMaterial;
    material.size = pointSize * 0.3; // Much smaller, more refined points

    // Update density
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

  // Helper to parse YAML projector info
  async function parseProjectorYaml(file?: File): Promise<{ projector:"Local"|"MGRS"|"Unknown"; mgrsGrid?:string }> {
    if (!file) {
      // Default to MGRS when no projector file is provided
      return { projector: "MGRS" };
    }
    try {
      const text = await file.text();
      const doc: any = yaml.load(text);
      const proj = (doc?.projector_type || doc?.projectorType || "").toString();
      const grid = (doc?.mgrs_grid || doc?.mgrsGrid || undefined) as string | undefined;
      
      let result: { projector:"Local"|"MGRS"|"Unknown"; mgrsGrid?:string };
      if (/^local$/i.test(proj)) {
        result = { projector: "Local" };
      } else if (/^mgrs$/i.test(proj)) {
        result = { projector: "MGRS", mgrsGrid: grid };
      } else {
        result = { projector: "Unknown" };
      }
      
      console.log(`parsed map_projector_info.yaml → projector=${result.projector}, mgrs_grid=${result.mgrsGrid || 'undefined'}`);
      return result;
    } catch (error) {
      console.warn('Error parsing map_projector_info.yaml:', error);
      // On parse error, fall back to MGRS
      return { projector: "MGRS" };
    }
  }

  // Helper to derive UTM EPSG string
  function deriveUtmEpsgFromSample(lat: number, lon: number, mgrsCode?: string): string {
    let zone: number | null = null;
    if (mgrsCode) {
      const m = mgrsCode.match(/^(\d{1,2})[C-X]/i); // e.g., "54SVE..." -> 54
      if (m) zone = parseInt(m[1], 10);
    }
    if (zone == null) zone = Math.floor((lon + 180) / 6) + 1;
    const north = lat >= 0;
    return north ? `EPSG:326${String(zone).padStart(2, "0")}` : `EPSG:327${String(zone).padStart(2, "0")}`;
  }

  // Helper to parse map_config.yaml
  async function parseMapConfigYaml(file?: File): Promise<MapOrigin | null> {
    if (!file) return null;
    try {
      const text = await file.text();
      const doc: any = yaml.load(text);
      
      // Try multiple fallback paths for robust parsing
      let origin = null;
      
      // Primary path: /**:ros__parameters:map_origin
      if (doc?.['/**']?.ros__parameters?.map_origin) {
        origin = doc['/**'].ros__parameters.map_origin;
      }
      // Fallback 1: ros__parameters:map_origin
      else if (doc?.ros__parameters?.map_origin) {
        origin = doc.ros__parameters.map_origin;
      }
      // Fallback 2: map_origin directly
      else if (doc?.map_origin) {
        origin = doc.map_origin;
      }
      // Fallback 3: camelCase variant
      else if (doc?.['/**']?.ros__parameters?.mapOrigin) {
        origin = doc['/**'].ros__parameters.mapOrigin;
      }
      
      if (!origin) {
        console.warn('map_config.yaml: No map_origin found in any expected location');
        return null;
      }
      
      // Coerce to numbers safely with fallbacks
      const lat = Number(origin.latitude) || 0.0;
      const lon = Number(origin.longitude) || 0.0;
      const ele = Number(origin.elevation) || 0.0;
      const roll = Number(origin.roll) || 0.0;
      const pitch = Number(origin.pitch) || 0.0;
      const yaw = Number(origin.yaw) || 0.0;
      
      // Warn if RPY values look like degrees instead of radians
      if (Math.abs(roll) > 6.3 || Math.abs(pitch) > 6.3 || Math.abs(yaw) > 6.3) {
        console.warn('RPY values appear to be in degrees rather than radians. Expected range: ±6.28 radians (±360°)');
      }
      
      console.log(`parsed map_config.yaml → lat=${lat.toFixed(6)}, lon=${lon.toFixed(6)}, ele=${ele.toFixed(2)}, roll=${roll.toFixed(4)}, pitch=${pitch.toFixed(4)}, yaw=${yaw.toFixed(4)}`);
      
      return { lat, lon, ele, roll, pitch, yaw };
    } catch (error) {
      console.error('Error parsing map_config.yaml:', error);
      return null;
    }
  }

  // Helper to fit camera to loaded content
  const fitSceneToContents = (opts: { padding?: number; minRadius?: number } = {}) => {
    const { padding = 1.25, minRadius = 5 } = opts;
    
    if (!cameraRef.current || !controlsRef.current || !sceneRef.current) {
      console.warn('Camera, controls, or scene not available for fitting');
      return;
    }

    const box = new THREE.Box3();
    let hasGeometry = false;

    // Collect bounds from vector group
    vectorGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Mesh) {
        if (child.geometry) {
          child.geometry.computeBoundingBox();
          if (child.geometry.boundingBox && !child.geometry.boundingBox.isEmpty()) {
            box.expandByObject(child);
            hasGeometry = true;
          }
        }
      }
    });

    // Collect bounds from cloud group
    cloudGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Line || child instanceof THREE.Points || child instanceof THREE.Mesh) {
        if (child.geometry) {
          child.geometry.computeBoundingBox();
          if (child.geometry.boundingBox && !child.geometry.boundingBox.isEmpty()) {
            box.expandByObject(child);
            hasGeometry = true;
          }
        }
      }
    });

    if (!hasGeometry || box.isEmpty()) {
      console.warn('No drawable geometry found for camera fitting');
      return;
    }

    const center = new THREE.Vector3();
    const sphere = new THREE.Sphere();
    box.getCenter(center);
    box.getBoundingSphere(sphere);

    // Check for unrealistic bounds (likely geographic degrees not projected)
    if (sphere.radius > 5e7) {
      console.warn('Geometry bounds are extremely large (>50M units). Likely geographic degrees not projected. Refusing to auto-fit.');
      return;
    }

    // Ensure minimum radius
    const effectiveRadius = Math.max(sphere.radius, minRadius);

    // Update controls target
    controlsRef.current.target.copy(center);

    // Position camera at appropriate distance
    const fovRad = (cameraRef.current.fov * Math.PI) / 180;
    const distance = (effectiveRadius * padding) / Math.sin(fovRad / 2);
    
    // Keep current camera direction or use default diagonal
    const currentDirection = new THREE.Vector3();
    cameraRef.current.getWorldDirection(currentDirection);
    
    if (currentDirection.length() < 0.1) {
      // First load or invalid direction - use default diagonal
      currentDirection.set(1, 1, 1).normalize();
    }
    
    cameraRef.current.position.copy(center).add(currentDirection.multiplyScalar(distance));

    // Adjust clipping planes
    cameraRef.current.near = Math.max(0.1, effectiveRadius * 0.01);
    cameraRef.current.far = Math.max(1000, effectiveRadius * 50);
    cameraRef.current.updateProjectionMatrix();

    // Update controls
    controlsRef.current.update();

    console.log(`Camera fitted to scene: center=${center.toArray().map(x => x.toFixed(2)).join(', ')}, radius=${effectiveRadius.toFixed(2)}`);
  };

  // Helper to count geometry for diagnostics
  const getGeometryCounts = () => {
    let vectorCount = 0;
    let cloudCount = 0;
    let pointCount = 0;
    
    vectorGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Line) vectorCount++;
    });
    
    cloudGroupRef.current.traverse((child) => {
      if (child instanceof THREE.Points) {
        cloudCount++;
        if (child.geometry && child.geometry.attributes.position) {
          pointCount += child.geometry.attributes.position.count;
        }
      }
    });
    
    return { vectorCount, cloudCount, pointCount };
  };

  // Helper to compute layer statistics
  const computeLayerStats = () => {
    const vectorBox = new THREE.Box3();
    const cloudBox = new THREE.Box3();
    let hasVectorGeometry = false;
    let hasCloudGeometry = false;

    // Compute vector bounds
    vectorFrameRef.current.traverse((child) => {
      if (child instanceof THREE.Line && child.geometry) {
        child.geometry.computeBoundingBox();
        if (child.geometry.boundingBox && !child.geometry.boundingBox.isEmpty()) {
          vectorBox.expandByObject(child);
          hasVectorGeometry = true;
        }
      }
    });

    // Compute cloud bounds
    cloudFrameRef.current.traverse((child) => {
      if (child instanceof THREE.Points && child.geometry) {
        child.geometry.computeBoundingBox();
        if (child.geometry.boundingBox && !child.geometry.boundingBox.isEmpty()) {
          cloudBox.expandByObject(child);
          hasCloudGeometry = true;
        }
      }
    });

    const vectorCentroid = hasVectorGeometry ? vectorBox.getCenter(new THREE.Vector3()) : undefined;
    const cloudCentroid = hasCloudGeometry ? cloudBox.getCenter(new THREE.Vector3()) : undefined;
    const vectorSphere = hasVectorGeometry ? vectorBox.getBoundingSphere(new THREE.Sphere()) : undefined;
    const cloudSphere = hasCloudGeometry ? cloudBox.getBoundingSphere(new THREE.Sphere()) : undefined;

    return {
      vectorCentroid,
      cloudCentroid,
      vectorRadius: vectorSphere?.radius,
      cloudRadius: cloudSphere?.radius
    };
  };

  const handleFileSelect = async (file: File, type: 'pointcloud' | 'vector' | 'mapProjectorInfo' | 'mapConfig') => {
    setLoadedFiles(prev => ({ ...prev, [type]: file }));
    setStatus(`File loaded: ${file.name}`);
  };

  const reloadWithLoadedFiles = async () => {
    if (!loadedFiles.pointcloud && !loadedFiles.vector) {
      setStatus("Please load at least one file first");
      return;
    }

    // Get load token to prevent async races
    const myToken = ++loadTokenRef.current;

    setStatus("Reloading with new files...");
    
    try {
      // Reset all frame transforms to identity
      mapFrameRef.current.position.set(0, 0, 0);
      mapFrameRef.current.rotation.set(0, 0, 0);
      mapFrameRef.current.scale.set(1, 1, 1);
      vectorFrameRef.current.position.set(0, 0, 0);
      vectorFrameRef.current.rotation.set(0, 0, 0);
      vectorFrameRef.current.scale.set(1, 1, 1);
      cloudFrameRef.current.position.set(0, 0, 0);
      cloudFrameRef.current.rotation.set(0, 0, 0);
      cloudFrameRef.current.scale.set(1, 1, 1);
      
      // Clear previous data and reset per-load refs/state
      cloudGroupRef.current.clear();
      vectorGroupRef.current.clear();
      directionGroupRef.current.clear();
      currentPointRef.current = null;
      originalGeomRef.current = null;
      cachedWaysRef.current = [];
      cachedNodeMapRef.current = new Map();
      setOriginOffset(null); // IMPORTANT: clear old MGRS offsets
      normOriginRef.current = null; // Clear normalization origin
      setLayerStats({}); // Clear stats
      
      // Parse YAML info
      const yamlInfo = await parseProjectorYaml(loadedFiles.mapProjectorInfo);
      if (myToken !== loadTokenRef.current) return; // Check token
      
      setProjectorMeta(p => ({ ...p, projector: yamlInfo.projector, mgrsGrid: yamlInfo.mgrsGrid }));
      
      // Parse map_config.yaml if provided
      const parsedMapConfig = await parseMapConfigYaml(loadedFiles.mapConfig);
      if (myToken !== loadTokenRef.current) return; // Check token
      
      setTempMapOrigin(parsedMapConfig);
      
      // Load new files
      let pcdLoaded = false;
      let vectorLoaded = false;
      
      if (loadedFiles.pointcloud) {
        await loadPointCloud(URL.createObjectURL(loadedFiles.pointcloud));
        if (myToken !== loadTokenRef.current) return; // Check token
        pcdLoaded = true;
      }
      
      if (loadedFiles.vector) {
        await loadLanelet(URL.createObjectURL(loadedFiles.vector), yamlInfo, parsedMapConfig ?? null);
        if (myToken !== loadTokenRef.current) return; // Check token
        vectorLoaded = true;
      }
      
      // Fit camera to loaded content after both loads complete
      if (pcdLoaded || vectorLoaded) {
        // Small delay to ensure scene graph is updated
        await Promise.resolve();
        if (myToken !== loadTokenRef.current) return; // Check token
        fitSceneToContents({ padding: 1.25 });
      }
      
      setStatus("Map reloaded successfully!");
    } catch (error) {
      console.error('Error reloading map:', error);
      setStatus(`Error reloading map: ${error}`);
    }
  };

  const clearLoadedFiles = () => {
    setLoadedFiles({});
    setTempMapOrigin(null);
    setOriginOffset(null);
    setStatus("Loaded files cleared");
  };

  const loadPointCloud = async (url: string) => {
    setIsLoadingPointCloud(true);
    setStatus(`Loading point cloud: ${url}`);
    try {
      // Clear previous point cloud data
      cloudGroupRef.current.children.forEach(obj => {
        if ((obj as any).geometry) (obj as any).geometry.dispose();
      });
      cloudGroupRef.current.clear();
      currentPointRef.current = null;
      originalGeomRef.current = null;
      
      const loader = new PCDLoader();
      const obj = await loader.loadAsync(url);
      
      // Create a frame for PCD axis normalization
      const pcdFrame = new THREE.Group();
      
      // Apply explicit axis preset:
      // "Yup": convert to Z-up by rotating -90° about X (matches current working setup)
      if (pcdAxisPreset === "Yup") {
        pcdFrame.rotation.x = -Math.PI / 2;
      } else {
        // "Zup": no rotation
      }
      
      // Optimize point cloud material for better appearance
      const material = obj.material as THREE.PointsMaterial;
      material.size = pointSize * 0.3; // Much smaller default size
      material.sizeAttenuation = true; // Size varies with distance
      material.alphaTest = 0.1; // Better transparency handling
      material.transparent = true;
      material.opacity = 0.8;
      
      currentPointRef.current = obj;
      originalGeomRef.current = obj.geometry.clone();
      
      // Mount the Points under the PCD frame, then mount the frame under cloudGroupRef
      pcdFrame.add(obj);
      cloudGroupRef.current.add(pcdFrame);
      
      // Compute cloud statistics and check for alignment
      const stats = computeLayerStats();
      setLayerStats(prev => ({ 
        ...prev, 
        cloudCentroid: stats.cloudCentroid, 
        cloudRadius: stats.cloudRadius 
      }));
      
      // PCD alignment: if cloud is absolute UTM-scale, translate cloudFrameRef
      if (stats.cloudCentroid) {
        const cloudMagnitude = stats.cloudCentroid.length();
        console.log(`PCD centroid magnitude: ${cloudMagnitude.toFixed(2)} meters`);
        
        if (cloudMagnitude > 10000 && normOriginRef.current) {
          // PCD appears absolute - align with vector normalization origin
          const { E0, N0, U0 } = normOriginRef.current;
          cloudFrameRef.current.position.x = -E0;
          cloudFrameRef.current.position.y = -U0;
          cloudFrameRef.current.position.z = vectorFlipY ? +N0 : -N0;
          console.log(`PCD aligned: translated cloudFrameRef by (-${E0.toFixed(2)}, -${U0.toFixed(2)}, ${vectorFlipY ? '+' : '-'}${N0.toFixed(2)})`);
        } else if (cloudMagnitude <= 10000) {
          console.log("PCD appears local - no alignment needed");
        }
      }
      
      setStatus("Point cloud loaded.");
      updatePointCloudSettings();
    } finally {
      setIsLoadingPointCloud(false);
    }
  };

  const createDirectionArrows = async (ways: any[], nodeMap: Map<any, any>, usingProj4: boolean = false, projForThisMap?: ProjectionConfig) => {
    if (!showDirections) return;
    
    setIsCreatingArrows(true);
    
    // Initialize shared geometry and material if not exists
    if (!sharedArrowGeometryRef.current) {
      sharedArrowGeometryRef.current = new THREE.ConeGeometry(0.35, 0.7, 4);
    }
    if (!sharedArrowMaterialRef.current) {
      sharedArrowMaterialRef.current = new THREE.MeshBasicMaterial({ color: 0xff4444 });
    }
    
    let arrowCount = 0;
    const maxArrows = 100;
    const up = new THREE.Vector3(0, 1, 0); // Reuse vector to avoid allocations
    
    for (const w of ways) {
      if (!w.nd || arrowCount >= maxArrows) break;
      
      const nds = Array.isArray(w.nd) ? w.nd : [w.nd];
      const pts: THREE.Vector3[] = [];
      
      // Use the same coordinate processing logic as loadLanelet
      for (const nd of nds) {
        const node = nodeMap.get(nd.ref);
        if (!node) continue;
        
        let X: number, Y: number, Z: number;
        if (node.x != null && node.y != null) {
          // Local coordinates (CARLA) - use directly
          [X, Y, Z] = [node.x, node.y, node.z ?? 0];
        } else if (usingProj4 && node.lat != null && node.lon != null && projForThisMap) {
          // Geographic coordinates (MGRS) - project to UTM and normalize (same as vector map)
          const [px, py, pz] = applyProjection([node.lon, node.lat, node.z ?? 0], projForThisMap);
          // Apply same normalization as vector map
          if (normOriginRef.current) {
            const { E0, N0, U0 } = normOriginRef.current;
            X = px - E0;
            Y = py - N0;
            Z = pz - U0;
          } else {
            [X, Y, Z] = [px, py, pz];
          }
        } else {
          continue;
        }
        
        const Yup = vectorFlipY ? -Y : Y;
        pts.push(new THREE.Vector3(X, Z, Yup));
      }
      
      if (pts.length < 2) continue;
      
      // Calculate total path length more efficiently
      let totalLength = 0;
      const startPoint = pts[0];
      const endPoint = pts[pts.length - 1];
      
      // Use direct distance calculation for total length estimation
      const directDistance = startPoint.distanceTo(endPoint);
      if (directDistance < 25) continue; // Early exit for short paths
      
      // Calculate actual path length only for qualifying paths
      for (let i = 0; i < pts.length - 1; i++) {
        totalLength += pts[i].distanceTo(pts[i + 1]);
      }
      
      if (totalLength < 25) continue;
      
      // Calculate overall direction
      const overallDirection = new THREE.Vector3().subVectors(endPoint, startPoint).normalize();
      if (overallDirection.length() < 0.1) continue;
      
      // Place arrow at 1/3 of the path length
      const targetDistance = totalLength / 3;
      let currentDistance = 0;
      const arrowPosition = new THREE.Vector3();
      
      for (let j = 0; j < pts.length - 1; j++) {
        const segmentLength = pts[j].distanceTo(pts[j + 1]);
        if (currentDistance + segmentLength >= targetDistance) {
          const segmentProgress = (targetDistance - currentDistance) / segmentLength;
          arrowPosition.lerpVectors(pts[j], pts[j + 1], segmentProgress);
          break;
        }
        currentDistance += segmentLength;
      }
      
      // Create arrow using shared geometry and material
      const arrow = new THREE.Mesh(sharedArrowGeometryRef.current, sharedArrowMaterialRef.current);
      arrow.position.copy(arrowPosition);
      
      // Orient the arrow (reuse quaternion)
      const quaternion = new THREE.Quaternion();
      quaternion.setFromUnitVectors(up, overallDirection);
      arrow.quaternion.copy(quaternion);
      
      directionGroupRef.current.add(arrow);
      arrowCount++;
      
      // Yield control every 20 arrows for better performance
      if (arrowCount % 20 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    setIsCreatingArrows(false);
  };

  const loadLanelet = async (url: string, yamlInfo?: { projector: "Local"|"MGRS"|"Unknown"; mgrsGrid?: string }, originOverride?: MapOrigin | null) => {
    setIsLoadingVectorMap(true);
    setStatus(`Loading vector map: ${url}`);
    try {
      // Clear previous vector map data
      vectorGroupRef.current.children.forEach(obj => {
        if ((obj as any).geometry) (obj as any).geometry.dispose();
      });
      vectorGroupRef.current.clear();
      
      // Clear previous direction arrows and uncheck the checkbox
      directionGroupRef.current.children.forEach(obj => {
        if ((obj as any).geometry) (obj as any).geometry.dispose();
      });
      directionGroupRef.current.clear();
      setShowDirections(false); // Uncheck the arrow checkbox when reloading vector map
      
      const xmlText = await (await fetch(url)).text();
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
      const osm = parser.parse(xmlText)?.osm;
      const nodeMap = new Map();
      const nodes = Array.isArray(osm.node) ? osm.node : [osm.node];
      
      // Detect coordinate system
      let hasLocal = false;
      let hasLatLon = false;
      let firstLat: number | undefined, firstLon: number | undefined;
      let sampleMgrs: string | undefined;

      for (const n of nodes) {
        const id = n.id;
        let x: number | null = null, y: number | null = null, z = 0;
        let lat: number | null = null, lon: number | null = null;
        let mgrsCode: string | undefined;

        if (n.tag) {
          const tags = Array.isArray(n.tag) ? n.tag : [n.tag];
          for (const t of tags) {
            if (t.k === "local_x") x = parseFloat(t.v);
            if (t.k === "local_y") y = parseFloat(t.v);
            if (t.k === "ele") z = parseFloat(t.v);
            if (t.k === "mgrs_code") mgrsCode = t.v;
          }
        }

        if (x != null && y != null) {
          hasLocal = true;
          nodeMap.set(id, { x, y, z });
        } else if (n.lat != null && n.lon != null) {
          hasLatLon = true;
          lat = parseFloat(n.lat); lon = parseFloat(n.lon);
          if (firstLat === undefined) { firstLat = lat; firstLon = lon; sampleMgrs = mgrsCode; }
          nodeMap.set(id, { lat, lon, z, mgrsCode });
        }
      }

      // Decide coordinate flavor and setup normalization
      let usingProj4 = false;
      let projForThisMap: ProjectionConfig = proj;
      let E0 = 0, N0 = 0, U0 = 0; // Normalization origin
      let originSource = "none";

      if (!hasLocal && hasLatLon && firstLat != null && firstLon != null) {
        // MGRS/geographic map - derive UTM EPSG
        const utmEpsg = deriveUtmEpsgFromSample(firstLat, firstLon, yamlInfo?.mgrsGrid || sampleMgrs);
        projForThisMap = { mode: "proj4", from: "EPSG:4326", to: utmEpsg };
        usingProj4 = true;
        setStatus(`Derived UTM projection: ${utmEpsg}`);
        
        // Compute normalization origin in UTM meters
        const effectiveMapOrigin = mapOrigin || originOverride || tempMapOrigin;
        if (effectiveMapOrigin) {
          // Use map_config.yaml origin
          [E0, N0, U0] = applyProjection([effectiveMapOrigin.lon, effectiveMapOrigin.lat, effectiveMapOrigin.ele], projForThisMap);
          originSource = tempMapOrigin ? "map_config (TEMP)" : "map_config";
          console.log(`Using map_config origin: E0=${E0.toFixed(2)}, N0=${N0.toFixed(2)}, U0=${U0.toFixed(2)}`);
        } else {
          // Fallback: compute centroid of projected nodes as origin
          let sumE = 0, sumN = 0, sumZ = 0, count = 0;
          for (const [_, node] of nodeMap.entries()) {
            if (node.lat != null && node.lon != null) {
              const [E, N, Z] = applyProjection([node.lon, node.lat, node.z ?? 0], projForThisMap);
              sumE += E; sumN += N; sumZ += Z; count++;
            }
          }
          if (count > 0) {
            E0 = sumE / count; N0 = sumN / count; U0 = sumZ / count;
            originSource = "centroid-fallback";
            console.log(`Using centroid fallback origin: E0=${E0.toFixed(2)}, N0=${N0.toFixed(2)}, U0=${U0.toFixed(2)}`);
          }
        }
        
        // Store normalization origin for PCD alignment
        normOriginRef.current = { E0, N0, U0 };
        
        // Check for unrealistic coordinates before normalization
        const maxE = Math.max(...Array.from(nodeMap.values()).filter(n => n.lat != null).map(n => {
          const [E] = applyProjection([n.lon!, n.lat!, 0], projForThisMap);
          return Math.abs(E);
        }));
        const maxN = Math.max(...Array.from(nodeMap.values()).filter(n => n.lat != null).map(n => {
          const [_, N] = applyProjection([n.lon!, n.lat!, 0], projForThisMap);
          return Math.abs(N);
        }));
        
        if (maxE > 1e7 || maxN > 1e7) {
          console.warn(`Vector appears un-normalized; check EPSG or mgrs_grid. Selected EPSG=${utmEpsg}, maxE=${maxE.toFixed(0)}, maxN=${maxN.toFixed(0)}`);
        }
      }

      setProjectorMeta(p => ({
        projector: yamlInfo?.projector ?? p.projector,
        mgrsGrid: yamlInfo?.mgrsGrid ?? p.mgrsGrid,
        usingLocalTags: hasLocal,
        usingProj4,
        utmEpsg: usingProj4 ? (projForThisMap as any).to : undefined
      }));

      // Store projection parameters for arrow creation
      setCurrentProjParams({ usingProj4, projForThisMap });

    const ways = Array.isArray(osm.way) ? osm.way : [osm.way];
    
    // Cache the ways and nodeMap for arrow creation
    cachedWaysRef.current = ways;
    cachedNodeMapRef.current = nodeMap;
    
    for (const w of ways) {
      if (!w.nd) continue;
      const nds = Array.isArray(w.nd) ? w.nd : [w.nd];
      const pts: THREE.Vector3[] = [];
      for (const nd of nds) {
        const node = nodeMap.get(nd.ref);
        if (!node) continue;

        let X: number, Y: number, Z: number;
        if (hasLocal && node.x != null) {
          // Local coordinates (CARLA) - use directly
          [X, Y, Z] = [node.x, node.y, node.z ?? 0];
        } else if (usingProj4 && node.lat != null && node.lon != null) {
          // Geographic coordinates (MGRS) - project to UTM and normalize
          const [px, py, pz] = applyProjection([node.lon, node.lat, node.z ?? 0], projForThisMap);
          // ALWAYS apply normalization for MGRS (automatic alignment)
          X = px - E0;
          Y = py - N0;
          Z = pz - U0;
        } else {
          continue;
        }

        // Map to viewer coordinates: x=E, y=Z, z=±N (respecting vectorFlipY)
        const Yup = vectorFlipY ? -Y : Y;
        pts.push(new THREE.Vector3(X, Z, Yup));
      }
      if (pts.length > 1) {
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        
        // Reuse shared line material for better performance
        if (!sharedLineMaterialRef.current) {
          sharedLineMaterialRef.current = new THREE.LineBasicMaterial({ 
            color: 0xFFFF00, 
            transparent: true, 
            opacity: 0.95, 
            linewidth: 5 
          });
        }
        
        const line = new THREE.Line(geom, sharedLineMaterialRef.current);
        vectorGroupRef.current.add(line);
      }
    }
    
    // Compute and store vector statistics
    const stats = computeLayerStats();
    setLayerStats(prev => ({ 
      ...prev, 
      vectorCentroid: stats.vectorCentroid, 
      vectorRadius: stats.vectorRadius,
      originSource 
    }));
    
    // Apply RPY rotation if enabled (only for UI toggle, not alignment)
    const effectiveMapOrigin = mapOrigin || originOverride || tempMapOrigin;
    if (effectiveMapOrigin && applyOriginRPY) {
      mapFrameRef.current.rotation.x = effectiveMapOrigin.roll;
      mapFrameRef.current.rotation.y = effectiveMapOrigin.yaw;
      mapFrameRef.current.rotation.z = vectorFlipY ? -effectiveMapOrigin.pitch : effectiveMapOrigin.pitch;
    }
    
    // Check bounds after normalization
    if (stats.vectorRadius && stats.vectorRadius > 5e6) {
      setStatus("Vector bounds extremely large after normalization — projection/origin mismatch likely");
      console.warn(`Vector radius after normalization: ${stats.vectorRadius.toFixed(0)} meters`);
    } else {
      setStatus("Vector map loaded.");
    }
    } finally {
      setIsLoadingVectorMap(false);
    }
  };

  useEffect(() => {
    if (!pointcloudUrl || !vectorUrl) return;
    
    // Get load token to prevent async races
    const myToken = ++loadTokenRef.current;
    
    // Reset all frame transforms to identity
    mapFrameRef.current.position.set(0, 0, 0);
    mapFrameRef.current.rotation.set(0, 0, 0);
    mapFrameRef.current.scale.set(1, 1, 1);
    vectorFrameRef.current.position.set(0, 0, 0);
    vectorFrameRef.current.rotation.set(0, 0, 0);
    vectorFrameRef.current.scale.set(1, 1, 1);
    cloudFrameRef.current.position.set(0, 0, 0);
    cloudFrameRef.current.rotation.set(0, 0, 0);
    cloudFrameRef.current.scale.set(1, 1, 1);
    
    // reset groups and state
    cloudGroupRef.current.clear();
    vectorGroupRef.current.clear();
    directionGroupRef.current.clear();
    currentPointRef.current = null;
    originalGeomRef.current = null;
    cachedWaysRef.current = [];
    cachedNodeMapRef.current = new Map();
    setOriginOffset(null);
    normOriginRef.current = null;
    setLayerStats({});

    (async () => {
      // Default to MGRS if file not present or fetch fails
      let yamlInfo: { projector: "Local" | "MGRS" | "Unknown"; mgrsGrid?: string } = { projector: "MGRS", mgrsGrid: undefined };
      try {
        const base = vectorUrl.substring(0, vectorUrl.lastIndexOf("/") + 1);
        const res = await fetch(base + "map_projector_info.yaml");
        if (res.ok) {
          const text = await res.text();
          const doc: any = yaml.load(text);
          const proj = (doc?.projector_type || "").toString();
          const grid = (doc?.mgrs_grid || undefined) as string | undefined;
          yamlInfo = {
            projector: /^local$/i.test(proj) ? "Local" : /^mgrs$/i.test(proj) ? "MGRS" : "Unknown",
            mgrsGrid: grid
          };
        }
      } catch {}
      
      if (myToken !== loadTokenRef.current) return; // Check token

      // Load point cloud
      await loadPointCloud(pointcloudUrl);
      if (myToken !== loadTokenRef.current) return; // Check token
      
      // Load vector map
      await loadLanelet(vectorUrl, yamlInfo);
      if (myToken !== loadTokenRef.current) return; // Check token
      
      // Fit camera to loaded content
      await Promise.resolve(); // Small delay to ensure scene graph is updated
      if (myToken !== loadTokenRef.current) return; // Check token
      fitSceneToContents({ padding: 1.25 });
    })();
  }, [pointcloudUrl, vectorUrl, proj, vectorFlipY, pcdAxisPreset]);

  // vis toggles
  useEffect(() => {
    cloudGroupRef.current.visible = showCloud;
  }, [showCloud]);
  useEffect(() => {
    vectorGroupRef.current.visible = showVector;
  }, [showVector]);
  useEffect(() => {
    directionGroupRef.current.visible = showDirections;
  }, [showDirections]);

  // Separate effect to create arrows when toggled on
  useEffect(() => {
    if (showDirections && directionGroupRef.current.children.length === 0 && cachedWaysRef.current.length > 0) {
      // Only create arrows if they don't exist yet and we have cached data
      const createArrowsAsync = async () => {
        setStatus("Creating direction arrows...");
        await createDirectionArrows(cachedWaysRef.current, cachedNodeMapRef.current, currentProjParams.usingProj4, currentProjParams.projForThisMap);
        setStatus("Direction arrows created.");
      };
      createArrowsAsync();
    }
  }, [showDirections, currentProjParams]);

  // update on sliders
  useEffect(() => { updatePointCloudSettings(); }, [pointSize]);
  useEffect(() => { updatePointCloudSettings(); }, [density]);

  return (
    <div style={{ position: "relative", ...style }} ref={mountRef}>
      {isLoading && (
        <div className="loading-overlay">
          <div className="loading-spinner"></div>
          <div className="loading-text">
            {isLoadingPointCloud && "Loading point cloud..."}
            {isLoadingVectorMap && "Loading vector map..."}
            {isCreatingArrows && "Creating direction arrows..."}
          </div>
        </div>
      )}
      <div className="overlay">
        <div className="panel">
          <h1>OpenHD Map Viewer</h1>
          <div>{status}</div>
          <div style={{ fontSize: "10px", color: "#888", marginTop: "4px" }}>
            Projector: {projectorMeta.projector} | MGRS grid: {projectorMeta.mgrsGrid ?? "-"} | 
            Coords: {projectorMeta.usingLocalTags ? "local_x/local_y (meters)" : (projectorMeta.usingProj4 ? `lat/lon → ${projectorMeta.utmEpsg}` : "unknown")}
          </div>
          <div style={{ fontSize: "10px", color: "#888", marginTop: "2px" }}>
            Origin: {layerStats.originSource || "none"} | 
            UsingProj4: {projectorMeta.usingProj4 ? "true" : "false"} | 
            EPSG: {projectorMeta.utmEpsg || "none"}
          </div>
          <div style={{ fontSize: "10px", color: "#888", marginTop: "2px" }}>
            Vector centroid: {layerStats.vectorCentroid ? `(${layerStats.vectorCentroid.x.toFixed(1)}, ${layerStats.vectorCentroid.y.toFixed(1)}, ${layerStats.vectorCentroid.z.toFixed(1)})` : "none"}
          </div>
          <div style={{ fontSize: "10px", color: "#888", marginTop: "2px" }}>
            PCD centroid: {layerStats.cloudCentroid ? `(${layerStats.cloudCentroid.x.toFixed(1)}, ${layerStats.cloudCentroid.y.toFixed(1)}, ${layerStats.cloudCentroid.z.toFixed(1)})` : "none"}
          </div>
          <div style={{ fontSize: "10px", color: "#888", marginTop: "2px" }}>
            Geometry: {(() => {
              const counts = getGeometryCounts();
              return `${counts.vectorCount} lines, ${counts.cloudCount} clouds (${counts.pointCount.toLocaleString()} points)`;
            })()}
          </div>
          <div className="controls">
            <label><input type="checkbox" checked={showCloud} onChange={e=>setShowCloud(e.target.checked)} /> Point Cloud Layer</label>
            <label><input type="checkbox" checked={showVector} onChange={e=>setShowVector(e.target.checked)} /> Vector Map Layer</label>
            <label><input type="checkbox" checked={showDirections} onChange={e=>setShowDirections(e.target.checked)} /> Line Directions</label>
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
              <label>📁 Load New Map Files:</label>
              <div style={{ marginTop: "8px" }}>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", color: "#e9edf1" }}>
                  Point Cloud (.pcd):
                </label>
                <input type="file" accept=".pcd" onChange={e=>{ const f=e.target.files?.[0]; if (f) handleFileSelect(f, 'pointcloud'); }} />
                {loadedFiles.pointcloud && <div style={{ fontSize: "10px", color: "#888" }}>✓ {loadedFiles.pointcloud.name}</div>}
              </div>
              <div style={{ marginTop: "8px" }}>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", color: "#e9edf1" }}>
                  Vector Map (.osm, .xml):
                </label>
                <input type="file" accept=".osm,.xml" onChange={e=>{ const f=e.target.files?.[0]; if (f) handleFileSelect(f, 'vector'); }} />
                {loadedFiles.vector && <div style={{ fontSize: "10px", color: "#888" }}>✓ {loadedFiles.vector.name}</div>}
              </div>
              <div style={{ marginTop: "8px" }}>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", color: "#e9edf1" }}>
                  Map Projector Info (.yaml, optional):
                </label>
                <input type="file" accept=".yaml,.yml" onChange={e=>{ const f=e.target.files?.[0]; if (f) handleFileSelect(f, 'mapProjectorInfo'); }} />
                {loadedFiles.mapProjectorInfo && <div style={{ fontSize: "10px", color: "#888" }}>✓ {loadedFiles.mapProjectorInfo.name}</div>}
              </div>
              <div style={{ marginTop: "8px" }}>
                <label style={{ display: "block", marginBottom: "4px", fontSize: "12px", color: "#e9edf1" }}>
                  Map Config (.yaml, optional, <span style={{ color: "#ff9800", fontWeight: "bold" }}>TEMPORARY</span>):
                </label>
                <input type="file" accept=".yaml,.yml" onChange={e=>{ const f=e.target.files?.[0]; if (f) handleFileSelect(f, 'mapConfig'); }} />
                {loadedFiles.mapConfig && <div style={{ fontSize: "10px", color: "#888" }}>✓ {loadedFiles.mapConfig.name} <span style={{ color: "#ff9800", fontWeight: "bold" }}>[TEMP]</span></div>}
              </div>
              
              {/* Action Buttons Section */}
              <div style={{ marginTop: "16px", borderTop: "1px solid #333", paddingTop: "12px" }}>
                <div style={{ marginBottom: "8px", fontSize: "12px", color: "#888", fontWeight: "bold" }}>
                  Map Actions:
                </div>
                
                <button 
                  onClick={reloadWithLoadedFiles}
                  disabled={!loadedFiles.pointcloud && !loadedFiles.vector}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: (loadedFiles.pointcloud || loadedFiles.vector) ? "#4CAF50" : "#666",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    cursor: (loadedFiles.pointcloud || loadedFiles.vector) ? "pointer" : "not-allowed",
                    fontSize: "12px",
                    width: "100%",
                    marginBottom: "8px"
                  }}
                >
                  🔄 Reload Map with New Files
                </button>
                
                <button 
                  onClick={clearLoadedFiles}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#FF9800",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px",
                    width: "100%"
                  }}
                >
                  🗑️ Clear All Loaded Files
                </button>
                
                <button 
                  onClick={() => fitSceneToContents({ padding: 1.25 })}
                  style={{
                    padding: "8px 16px",
                    backgroundColor: "#4CAF50",
                    color: "white",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                    fontSize: "12px",
                    width: "100%",
                    marginTop: "8px"
                  }}
                >
                  📷 Refit Camera
                </button>
              </div>
              
              {/* Origin Controls Section */}
              {(mapOrigin || tempMapOrigin) && (
                <div style={{ marginTop: "16px", borderTop: "1px solid #333", paddingTop: "12px" }}>
                  <div style={{ marginBottom: "8px", fontSize: "12px", color: "#888", fontWeight: "bold" }}>
                    Origin Controls:
                  </div>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "11px", color: "#e9edf1" }}>
                    <input 
                      type="checkbox" 
                      checked={applyOriginOffset} 
                      onChange={e => {
                        // This would need to be handled by parent component
                        console.log('Apply Origin Offset:', e.target.checked);
                      }}
                      style={{ marginRight: "4px" }}
                    />
                    Apply Origin Offset
                  </label>
                  <label style={{ display: "block", marginBottom: "4px", fontSize: "11px", color: "#e9edf1" }}>
                    <input 
                      type="checkbox" 
                      checked={applyOriginRPY} 
                      onChange={e => {
                        // This would need to be handled by parent component
                        console.log('Apply Origin RPY:', e.target.checked);
                      }}
                      style={{ marginRight: "4px" }}
                    />
                    Apply Origin RPY Rotation
                  </label>
                </div>
              )}
            </div>
        </div>
      </div>
      </div>
    </div>
  );
};



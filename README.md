OpenHD Map Viewer (MVP)
=======================

Purpose
- Visualize HD maps consisting of:
  1) Lanelet2 vector map (.osm)
  2) Point cloud (.pcd)

Stack
- Vite + TypeScript + React
- Three.js (PCDLoader)
- fast-xml-parser + osmtogeojson for OSM -> GeoJSON (when needed)
- Optional: proj4 (stubbed, can be enabled later)

Prereqs
- nvm installed
- Node LTS 20.x
- Yarn installed globally

Quick Start
1) nvm install && nvm use
2) yarn install
3) Place your map files under:
   public/hd_maps/current/
   - vector_map.osm
   - pointcloud_map.pcd
   - config.json (see below)
4) yarn dev

Config
Create public/hd_maps/current/config.json with:
{
  "vector": "/hd_maps/current/vector_map.osm",
  "pointcloud": "/hd_maps/current/pointcloud_map.pcd",
  "projection": "identity",  // options: "identity" (default), "proj4"
  "proj4": {
    "from": "EPSG:4326",
    "to": "EPSG:3857"
  },
  "vectorFlipY": true
}

Notes
- For MVP, we assume map frames are compatible. If not, set projection to "proj4" and configure "from"/"to".
- Large point clouds may need tiling/streaming in the future.

Component
- Reusable React component: OpenHDMapViewer
- Props: vectorUrl, pointcloudUrl, projectionMode, proj4From, proj4To, vectorFlipY, defaultPointSize, defaultDensityPercent, style 
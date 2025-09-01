# OpenHD Map Viewer Module

Self-contained module for rendering Autoware HD map vector data (OSM/Lanelet) and point cloud (PCD) in Three.js.

## Usage

```tsx
import { OpenHDMapViewer } from "@/modules/openhd";

<OpenHDMapViewer
  vectorUrl="/hd_maps/current/vector_map.osm"
  pointcloudUrl="/hd_maps/current/pointcloud_map.pcd"
  projectionMode="identity" // or "proj4"
  proj4From="EPSG:4326"
  proj4To="EPSG:3857"
  vectorFlipY={true}
  style={{ width: "100vw", height: "100vh" }}
/>;
```

## Props

- `vectorUrl`: URL to Lanelet/OSM XML file
- `pointcloudUrl`: URL to PCD file
- `projectionMode`: `identity` | `proj4`
- `proj4From`, `proj4To`: CRS strings when using proj4
- `vectorFlipY`: flips Y axis for vector map alignment
- `defaultPointSize`, `defaultDensityPercent`: initial point cloud settings

## Internals

- `projection.ts`: optional coordinate projection via proj4
- `overlay.css`: local UI styles imported by the component

## Assets & Resources

Place runtime assets under your app's `public/hd_maps/...` or provide absolute URLs via props. This module does not bundle any data.



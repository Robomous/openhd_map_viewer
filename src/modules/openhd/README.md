# OpenHD Map Viewer Module

Self-contained module for rendering Autoware HD map vector data (OSM/Lanelet) and point cloud (PCD) in Three.js.

## Usage

### Basic Usage
```tsx
import { OpenHDMapViewer } from "@/modules/openhd";

<OpenHDMapViewer
  vectorUrl="/hd_maps/current/vector_map.osm"
  pointcloudUrl="/hd_maps/current/pointcloud_map.pcd"
  style={{ width: "100vw", height: "100vh" }}
/>;
```

### Advanced Usage with Custom Settings
```tsx
<OpenHDMapViewer
  vectorUrl="/hd_maps/current/vector_map.osm"
  pointcloudUrl="/hd_maps/current/pointcloud_map.pcd"
  projectionMode="proj4"
  proj4From="EPSG:4326"
  proj4To="EPSG:3857"
  vectorFlipY={true}
  defaultPointSize={0.2}
  defaultDensityPercent={60}
  showLineDirections={true}
  style={{ width: "100vw", height: "100vh" }}
/>;
```

## Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `vectorUrl` | string | - | URL to Lanelet/OSM XML file |
| `pointcloudUrl` | string | - | URL to PCD file |
| `projectionMode` | "identity" \| "proj4" | "identity" | Coordinate projection mode |
| `proj4From` | string | "EPSG:4326" | Source CRS for proj4 projection |
| `proj4To` | string | "EPSG:3857" | Target CRS for proj4 projection |
| `vectorFlipY` | boolean | true | Flip Y axis for vector alignment |
| `defaultPointSize` | number | 0.1 | Initial point cloud point size (0.1-2.0) |
| `defaultDensityPercent` | number | 35 | Initial point cloud density (1-100%) |
| `showLineDirections` | boolean | false | Show minimal direction arrows on vector map lines (1 arrow per path) |
| `style` | CSSProperties | - | Container styling |

## Internals

- `projection.ts`: optional coordinate projection via proj4
- `overlay.css`: local UI styles imported by the component

## Assets & Resources

Place runtime assets under your app's `public/hd_maps/...` or provide absolute URLs via props. This module does not bundle any data.



import React from "react";
import { OpenHDMapViewer } from "../modules/openhd/index.js";

export const App: React.FC = () => {
  return (
    <OpenHDMapViewer
      vectorUrl="/hd_maps/current/vector_map.osm"
      pointcloudUrl="/hd_maps/current/pointcloud_map.pcd"
      projectionMode="identity"
      proj4From="EPSG:4326"
      proj4To="EPSG:3857"
      vectorFlipY={true}
      defaultPointSize={0.1}
      defaultDensityPercent={35}
      showLineDirections={false}
      style={{ width: "100vw", height: "100vh" }}
    />
  );
};
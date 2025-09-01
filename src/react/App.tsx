import React, { useEffect, useState } from "react";
import { OpenHDMapViewer } from "../modules/openhd/index.js";

type ConfigJson = {
  vector?: string;
  pointcloud?: string;
  projection?: "identity" | "proj4";
  proj4?: { from?: string; to?: string };
  vectorFlipY?: boolean;
  defaultPointSize?: number;
  defaultDensityPercent?: number;
};

export const App: React.FC = () => {
  const [config, setConfig] = useState<ConfigJson>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/hd_maps/current/config.json");
        if (!res.ok) throw new Error(`Config not found (HTTP ${res.status}).`);
        const json = (await res.json()) as ConfigJson;
        setConfig(json);
      } catch (e: any) {
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="overlay"><div className="panel"><div>Loading config ...</div></div></div>;
  if (error) return <div className="overlay"><div className="panel"><div>Error: {error}</div></div></div>;

  return (
    <OpenHDMapViewer
      vectorUrl={config?.vector ?? "/hd_maps/current/vector_map.osm"}
      pointcloudUrl={config?.pointcloud ?? "/hd_maps/current/pointcloud_map.pcd"}
      projectionMode={config?.projection ?? "identity"}
      proj4From={config?.proj4?.from ?? "EPSG:4326"}
      proj4To={config?.proj4?.to ?? "EPSG:3857"}
      vectorFlipY={config?.vectorFlipY ?? true}
      defaultPointSize={config?.defaultPointSize ?? 0.1}
      defaultDensityPercent={config?.defaultDensityPercent ?? 35}
      style={{ width: "100vw", height: "100vh" }}
    />
  );
};
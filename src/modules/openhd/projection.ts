import proj4lib from "proj4";

export type ProjectionConfig =
  | { mode: "identity" }
  | { mode: "proj4"; from: string; to: string };

/**
 * Apply an optional projection to a [x, y, z] triple.
 * For MVP we assume:
 * - If identity: input is already metric/local to the point cloud frame.
 * - If proj4: treat input as [lon, lat, z?] and project into planar meters.
 * Returns [X, Y, Z] in meters.
 */
export function applyProjection(
  coord: [number, number, number?],
  cfg: ProjectionConfig
): [number, number, number] {
  const [x, y, z = 0] = coord;

  if (cfg.mode === "identity") {
    return [x, y, z];
  }

  // proj4 path: project lon/lat -> planar meters
  const p = proj4lib(cfg.from, cfg.to, [x, y]) as [number, number];
  return [p[0], p[1], z];
}



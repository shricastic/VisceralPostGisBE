import express from "express";
import cors from "cors";
import { Pool } from "pg";
import fs from "fs";
import path from "path";

const countryGeoJSONPath = path.join(__dirname, "../public/country.geo.json");
const countryData = JSON.parse(fs.readFileSync(countryGeoJSONPath, "utf8"));

const pool = new Pool({
  connectionString: "postgresql://postgres:postgres@localhost:5433/test_gis",
});

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({ status: "ok", time: result.rows[0].now });
  } catch (err) {
    console.error("Healthcheck error:", err);
    res.status(500).json({ error: "DB connection failed" });
  }
});

app.post("/polygons", async (req, res) => {
  const { name, geometry, agent_id, user_id, properties } = req.body;

  if (!geometry) {
    return res.status(400).json({ error: "Missing geometry" });
  }

  try {
    await pool.query(
      "DELETE FROM user_polygons WHERE agent_id = $1 AND user_id = $2",
      [agent_id, user_id],
    );

    const insertResult = await pool.query(
      `
      INSERT INTO user_polygons (name, geom, agent_id, user_id, properties)
      VALUES ($1, ST_SetSRID(ST_GeomFromGeoJSON($2), 4326), $3, $4, $5)
      RETURNING id
      `,
      [
        name || `Drawing Set for Agent ${agent_id}`,
        JSON.stringify(geometry),
        agent_id,
        user_id,
        JSON.stringify(properties || {}),
      ],
    );

    const polygonId = insertResult.rows[0].id;

    // US states specific
    const intersectingStateResult = await pool.query(
      `
      SELECT gid, name || ',United States' AS location, stusps
      FROM us_state
      WHERE ST_Intersects(
        ST_SetSRID(geom, 4326),
        (SELECT geom FROM user_polygons WHERE id = $1)
      )
      `,
      [polygonId],
    );

    res.json({
      status: "saved",
      id: polygonId,
      states: intersectingStateResult.rows,
      message: `Saved ${properties?.featureCount || 0} drawings in one record`,
    });
  } catch (err) {
    console.error("Save polygon collection error:", err);
    res.status(500).json({ error: "Save failed" });
  }
});

app.get("/polygons", async (req, res) => {
  const { agent_id, user_id } = req.query;

  try {
    let query = `
      SELECT id, name, agent_id, user_id, properties, created_at, updated_at,
             ST_AsGeoJSON(geom) AS geometry 
      FROM user_polygons
    `;
    const params: any[] = [];
    const conditions: string[] = [];

    if (agent_id) {
      conditions.push(`agent_id = $${params.length + 1}`);
      params.push(agent_id);
    }

    if (user_id) {
      conditions.push(`user_id = $${params.length + 1}`);
      params.push(user_id);
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }

    query += ` ORDER BY created_at DESC`;

    const result = await pool.query(query, params);

    const features = result.rows.map((row) => {
      const props =
        typeof row.properties === "string"
          ? JSON.parse(row.properties)
          : row.properties || {};

      return {
        type: "Feature",
        id: row.id,
        properties: {
          id: row.id,
          name: row.name,
          agent_id: row.agent_id,
          user_id: row.user_id,
          created_at: row.created_at,
          updated_at: row.updated_at,
          ...props,
        },
        geometry: JSON.parse(row.geometry),
      };
    });

    res.json({
      type: "FeatureCollection",
      features,
    });
  } catch (err) {
    console.error("Fetch polygons error:", err);
    res.status(500).json({ error: "Fetch failed" });
  }
});

app.delete("/polygons/agent/:agent_id/user/:user_id", async (req, res) => {
  const { agent_id, user_id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM user_polygons WHERE agent_id = $1 AND user_id = $2 RETURNING id, name",
      [agent_id, user_id],
    );

    res.json({
      status: "deleted",
      deletedRecords: result.rows.length,
      records: result.rows,
    });
  } catch (err) {
    console.error("Delete polygon collections error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

// Delete specific polygon collection by ID
app.delete("/polygons/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM user_polygons WHERE id = $1 RETURNING id, name, agent_id, user_id",
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Polygon collection not found" });
    }

    res.json({
      status: "deleted",
      record: result.rows[0],
    });
  } catch (err) {
    console.error("Delete polygon collection error:", err);
    res.status(500).json({ error: "Delete failed" });
  }
});

// Get single polygon collection endpoint
app.get("/polygons/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT id, name, agent_id, user_id, properties, created_at, updated_at,
             ST_AsGeoJSON(geom) AS geometry 
      FROM user_polygons 
      WHERE id = $1
      `,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Polygon collection not found" });
    }

    const row = result.rows[0];
    const feature = {
      type: "Feature",
      id: row.id,
      properties: {
        id: row.id,
        name: row.name,
        agent_id: row.agent_id,
        user_id: row.user_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        ...JSON.parse(row.properties || "{}"),
      },
      geometry: JSON.parse(row.geometry),
    };

    res.json(feature);
  } catch (err) {
    console.error("Fetch polygon collection error:", err);
    res.status(500).json({ error: "Fetch failed" });
  }
});

// Get stats endpoint
app.get("/stats", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        agent_id,
        user_id,
        COUNT(*) as total_records,
        MAX(created_at) as last_updated,
        SUM((properties->>'featureCount')::int) as total_features
      FROM user_polygons 
      GROUP BY agent_id, user_id
      ORDER BY last_updated DESC
    `);

    res.json({
      stats: result.rows,
    });
  } catch (err) {
    console.error("Stats error:", err);
    res.status(500).json({ error: "Stats fetch failed" });
  }
});

app.post("/locations-geojson", async (req, res) => {
  const { locations } = req.body;

  if (!Array.isArray(locations) || locations.length === 0) {
    return res.status(400).json({ error: "Need an array of location names" });
  }

  try {
    const allFeatures = [];

    for (const name of locations) {
      let found = false;

      // 1. First try countries (g_boundaries table)
      // if (!found) {
      //   try {
      //     const countryResult = await pool.query(
      //       `SELECT gid, name_en as name, iso_a2 as code, ST_AsGeoJSON(geom) AS geometry
      //        FROM g_boundaries
      //        WHERE LOWER(name_en) = LOWER($1)
      //           OR LOWER(name) = LOWER($1)
      //           OR LOWER(name_long) = LOWER($1)
      //        LIMIT 1`,
      //       [name],
      //     );
      //
      //     if (countryResult.rows.length > 0) {
      //       const row = countryResult.rows[0];
      //       allFeatures.push({
      //         type: "Feature",
      //         properties: {
      //           id: row.gid,
      //           name: row.name,
      //           code: row.code,
      //           level: "country",
      //         },
      //         geometry: JSON.parse(row.geometry),
      //       });
      //       found = true;
      //     }
      //   } catch (err) {
      //     console.log(`Country search failed for ${name}:`, err.message);
      //   }
      // }
      if (!found) {
        try {
          const lowerName = name.toLowerCase();

          const countryFeature =
            countryData.features.find((f: any) => {
              const props = f.properties || {};
              const candidateNames = [
                props.name,
                props.name_en,
                props.admin,
                props.name_long,
                props.brk_name,
                props.name_sort,
                props.abbrev,
                props.postal,
                props.formal_en,
                props.iso_a2,
                props.iso_a3,
              ].filter(Boolean);

              return candidateNames.some(
                (n: string) => n.toLowerCase() === lowerName,
              );
            }) ||
            countryData.features.find((f: any) => {
              const props = f.properties || {};
              const candidateNames = [
                props.name,
                props.name_en,
                props.admin,
                props.name_long,
                props.brk_name,
                props.name_sort,
              ].filter(Boolean);

              return candidateNames.some((n: string) =>
                n.toLowerCase().includes(lowerName),
              );
            });

          if (countryFeature) {
            allFeatures.push({
              type: "Feature",
              properties: {
                id:
                  countryFeature.properties.iso_a3 ||
                  countryFeature.properties.adm0_a3,
                name:
                  countryFeature.properties.name ||
                  countryFeature.properties.admin ||
                  countryFeature.properties.name_long,
                code: countryFeature.properties.iso_a2,
                level: "country",
              },
              geometry: countryFeature.geometry,
            });
            found = true;
          }
        } catch (err) {
          console.log(
            `Country search failed for ${name}:`,
            (err as Error).message,
          );
        }
      }

      // 2. If not found in countries, try US states
      if (!found) {
        try {
          const stateResult = await pool.query(
            `SELECT gid, name, stusps, ST_AsGeoJSON(geom) AS geometry
             FROM us_state 
             WHERE LOWER(name) = LOWER($1) 
                OR LOWER(stusps) = LOWER($1)
             LIMIT 1`,
            [name],
          );

          if (stateResult.rows.length > 0) {
            const row = stateResult.rows[0];
            allFeatures.push({
              type: "Feature",
              properties: {
                id: row.gid,
                name: row.name,
                code: row.stusps,
                level: "state",
              },
              geometry: JSON.parse(row.geometry),
            });
            found = true;
          }
        } catch (err) {
          console.log(`State search failed for ${name}:`, err.message);
        }
      }

      // 3. If not found in countries or states, try cities/places
      if (!found) {
        try {
          const cityResult = await pool.query(
            `SELECT gid, name, statefp, ST_AsGeoJSON(geom) AS geometry
             FROM tiger.place 
             WHERE LOWER(name) = LOWER($1)
             LIMIT 1`,
            [name],
          );

          if (cityResult.rows.length > 0) {
            const row = cityResult.rows[0];
            allFeatures.push({
              type: "Feature",
              properties: {
                id: row.gid,
                name: row.name,
                state_fips: row.statefp,
                level: "city",
              },
              geometry: JSON.parse(row.geometry),
            });
            found = true;
          }
        } catch (err) {
          console.log(`City search failed for ${name}:`, err.message);
        }
      }

      if (!found) {
        try {
          const urbanResult = await pool.query(
            `SELECT gid, name, ST_AsGeoJSON(geom) AS geometry
             FROM urban_areas 
             WHERE LOWER(name) LIKE LOWER($1) || '%'
             LIMIT 1`,
            [name],
          );

          if (urbanResult.rows.length > 0) {
            const row = urbanResult.rows[0];
            allFeatures.push({
              type: "Feature",
              properties: {
                id: row.gid,
                name: row.name,
                level: "urban_area",
              },
              geometry: JSON.parse(row.geometry),
            });
            found = true;
          }
        } catch (err) {
          console.log(`Urban area search failed for ${name}:`, err.message);
        }
      }

      if (!found) {
        console.log(`Location not found: ${name}`);
      }
    }

    if (allFeatures.length === 0) {
      return res.status(404).json({ error: "No locations found" });
    }

    res.json({
      type: "FeatureCollection",
      features: allFeatures,
    });
  } catch (err) {
    console.error("Location search error:", err);
    res.status(500).json({ error: "Location search failed" });
  }
});

// app.post("/states", async (req, res) => {
//   const { states: names } = req.body;
//
//   if (!Array.isArray(names) || names.length === 0) {
//     return res.status(400).json({ error: "Need an array of state names" });
//   }
//
//   try {
//     const result = await pool.query(
//       `SELECT gid, name, stusps, ST_AsGeoJSON(geom) AS geometry
//        FROM us_state
//        WHERE name = ANY($1)`,
//       [names],
//     );
//
//     if (result.rows.length === 0) {
//       return res.status(404).json({ error: "No states found" });
//     }
//
//     const features = result.rows.map((row) => ({
//       type: "Feature",
//       properties: {
//         id: row.gid,
//         name: row.name,
//         stusps: row.stusps,
//       },
//       geometry: JSON.parse(row.geometry),
//     }));
//
//     res.json({
//       type: "FeatureCollection",
//       features,
//     });
//   } catch (err) {
//     console.error("State fetch error:", err);
//     res.status(500).json({ error: "State fetch failed" });
//   }
// });

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Visceral PostGIS BE running at http://localhost:${PORT}`);
});

import express from "express";
import cors from "cors";
import { Pool } from "pg";

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

    const result = await pool.query(
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

    res.json({
      status: "saved",
      id: result.rows[0].id,
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

// Get stats endpoint - useful for monitoring
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

app.post("/states", async (req, res) => {
  const { states } = req.body;

  if (!Array.isArray(states) || states.length === 0) {
    return res.status(400).json({ error: "Need an array of state names" });
  }

  try {
    const result = await pool.query(
      `SELECT gid, name, stusps, ST_AsGeoJSON(geom) AS geometry
       FROM us_state
       WHERE name = ANY($1)`,
      [states],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No states found" });
    }

    const features = result.rows.map((row) => ({
      type: "Feature",
      properties: {
        id: row.gid,
        name: row.name,
        stusps: row.stusps,
      },
      geometry: JSON.parse(row.geometry),
    }));

    res.json({
      type: "FeatureCollection",
      features,
    });
  } catch (err) {
    console.error("State fetch error:", err);
    res.status(500).json({ error: "State fetch failed" });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Visceral PostGIS BE running at http://localhost:${PORT}`);
});

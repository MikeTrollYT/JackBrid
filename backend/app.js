const express = require("express");
const cors = require("cors");
const parseTorrent = require("parse-torrent");

const jackett = require("./jackettClient");
const alldebrid = require("./alldebridClient");

const app = express();
const PORT = 3000;

/* =========================
   MIDDLEWARE
========================= */
app.use(cors());
app.use(express.json({ limit: "5mb" }));

/* =========================
   HEALTH
   Comprueba Jackett + AllDebrid
========================= */
app.get("/health", async (req, res) => {
  try {
    await jackett.getIndexers();
    await alldebrid.listItems();
    res.json({ ok: true });
  } catch (err) {
    console.error("Health error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* =========================
   LINKS
   Devuelve URLs de acceso a paneles externos
========================= */
app.get("/links", (req, res) => {
  res.json({
    jackett: process.env.JACKETT_URL || "http://localhost:9117",
    alldebrid: "https://alldebrid.com/magnets/",
    alldebridApiKey: process.env.ALLDEBRID_API_KEY || ""
  });
});

/* =========================
   TRACKERS
========================= */
app.get("/trackers", async (req, res) => {
  try {
    const trackers = await jackett.getIndexers();
    res.json({ trackers });
  } catch (err) {
    console.error("Error en /trackers:", err.message);
    res.status(500).json({ trackers: [], error: err.message });
  }
});

/* =========================
   SEARCH
   🔑 NO FILTRAMOS NADA
========================= */
app.get("/search", async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const trackers = (req.query.trackers || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const sort = (req.query.sort || "relevance").toLowerCase();
    const limit = Number(req.query.limit) || null;
    const onlySeeded = (req.query.onlySeeded || "no").toLowerCase();

    if (!q || !trackers.length) {
      return res.json({ results: [] });
    }

    let results = await jackett.search({
      query: q,
      trackers,
    });

    // Aplicar filtro: solo con seeders
    if (onlySeeded === "yes") {
      results = results.filter((r) => typeof r.seeders === "number" && r.seeders > 0);
    }

    // Orden
    if (sort === "seeders") {
      results.sort((a, b) => (Number(b.seeders) || 0) - (Number(a.seeders) || 0));
    } else if (sort === "size") {
      results.sort((a, b) => (Number(b.sizeBytes) || 0) - (Number(a.sizeBytes) || 0));
    } else if (sort === "date") {
      // try to use raw.pubDate or raw.uploadDate; fallbacks handled
      const toTs = (r) => {
        try {
          const s = r.raw?.pubDate || r.raw?.uploadDate || r.raw?.time || null;
          if (!s) return 0;
          const t = Date.parse(s);
          return Number.isNaN(t) ? 0 : t;
        } catch (e) {
          return 0;
        }
      };
      results.sort((a, b) => toTs(b) - toTs(a));
    }

    // Limitar
    if (limit && Number.isFinite(limit) && limit > 0) {
      results = results.slice(0, limit);
    }

    res.json({ results });
  } catch (err) {
    console.error("Error en /search:", err.message);
    res.status(500).json({ results: [], error: err.message });
  }
});

/* =========================
   DOWNLOAD TORRENT
   Devuelve el .torrent para que el cliente (navegador) lo suba
========================= */
app.post("/download-torrent", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.raw) {
      return res.status(400).json({ error: "Payload inválido (falta raw)" });
    }

    const raw = payload.raw;
    const torrentUrl = raw.enclosure?.url || raw.torrentUrl || raw.link;

    if (!torrentUrl) {
      return res.status(400).json({ error: "No hay URL de descarga" });
    }

    // Descargar el .torrent desde Jackett
    const torrentRes = await fetch(torrentUrl);
    if (!torrentRes.ok) {
      return res.status(400).json({ error: "No se pudo descargar el .torrent desde Jackett" });
    }

    const arr = await torrentRes.arrayBuffer();
    const buffer = Buffer.from(arr);
    const filename = (raw.title || "torrent").replace(/[^a-z0-9]/gi, "_") + ".torrent";

    res.setHeader("Content-Type", "application/x-bittorrent");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("Error en /download-torrent:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   EXTRACT MAGNET FROM TORRENT
   Backend descarga .torrent, extrae magnet, devuelve al cliente
========================= */
app.post("/extract-magnet", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.raw) {
      return res.status(400).json({ error: "Payload inválido (falta raw)" });
    }

    const raw = payload.raw;
    const torrentUrl = raw.enclosure?.url || raw.torrentUrl || raw.link;

    if (!torrentUrl) {
      return res.status(400).json({ error: "No hay URL de descarga" });
    }

    // Descargar el .torrent desde Jackett
    const torrentRes = await fetch(torrentUrl);
    if (!torrentRes.ok) {
      return res.status(400).json({ error: "No se pudo descargar el .torrent desde Jackett" });
    }

    const arr = await torrentRes.arrayBuffer();
    const buffer = Buffer.from(arr);

    // Parsear el torrent para extraer info y generar magnet
    const torrentInfo = await parseTorrent(buffer);
    
    // Construir el magnet manualmente desde el hash de info
    const infoHash = torrentInfo.infoHash.toString();
    const name = torrentInfo.name || raw.title || "torrent";
    const trackers = (torrentInfo.announce || []).join("&tr=");
    const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}${trackers ? "&tr=" + trackers : ""}`;

    console.log("Extracted magnet:", magnet);
    res.json({ magnet, infoHash, name });
  } catch (err) {
    console.error("Error en /extract-magnet:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   ADD → AllDebrid (legacy, para magnets solamente)
========================= */
app.post("/add", async (req, res) => {
  try {
    const payload = req.body;

    if (!payload || !payload.raw) {
      return res.status(400).json({ error: "Payload inválido (falta raw)" });
    }

    const result = await alldebrid.addItem(payload);
    res.json(result);
  } catch (err) {
    console.error("Error en /add:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   LIST (AllDebrid)
========================= */
app.get("/list", async (req, res) => {
  try {
    const items = await alldebrid.listItems();
    res.json({ items });
  } catch (err) {
    console.error("Error en /list:", err.message);
    res.status(500).json({ items: [], error: err.message });
  }
});

/* =========================
   DELETE MAGNET
========================= */
app.post("/delete", async (req, res) => {
  try {
    const magnetId = req.body?.id;
    if (!magnetId) {
      return res.status(400).json({ error: "ID requerido" });
    }
    const result = await alldebrid.deleteItem(magnetId);
    res.json({ success: true, result });
  } catch (err) {
    console.error("Error en /delete:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   GET DOWNLOADABLE LINKS
   Obtiene URLs de descarga para archivos de video
========================= */
app.post("/download-links", async (req, res) => {
  try {
    const magnetId = req.body?.id;
    if (!magnetId) {
      return res.status(400).json({ error: "ID requerido" });
    }
    const links = await alldebrid.getDownloadableLinks(magnetId);
    res.json({ success: true, links });
  } catch (err) {
    console.error("Error en /download-links:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   STATUS (opcional)
========================= */
app.post("/status", async (req, res) => {
  try {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
    const statusById = await alldebrid.getStatus(ids);
    res.json({ statusById });
  } catch (err) {
    console.error("Error en /status:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`✅ Backend escuchando en el puerto ${PORT}`);
});

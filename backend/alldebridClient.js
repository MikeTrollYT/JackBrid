const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");

const ALLDEBRID_API_KEY = process.env.ALLDEBRID_API_KEY;
const BASE = "https://api.alldebrid.com/v4.1";

/* =========================
   Utils
========================= */
function normalizeUrl(url) {
  if (!url) return null;
  return url.replace(/&amp;/g, "&");
}

/* =========================
   ADD ITEM
========================= */
async function addItem(payload) {
  const raw = payload?.raw;
  if (!raw) throw new Error("Payload sin raw");

  /* 1️⃣ MAGNET */
  if (raw.magnet) {
    const magnet = normalizeUrl(raw.magnet);

    const res = await fetch(`${BASE}/magnet/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALLDEBRID_API_KEY}`,
      },
      body: JSON.stringify({ magnet }),
    });

    const json = await res.json();
    if (!json?.status || json.status !== "success") {
      throw new Error("Error subiendo magnet a AllDebrid: " + (json?.error?.message || JSON.stringify(json)));
    }
    return json;
  }

  /* 2️⃣ TORRENT (.torrent desde Jackett) */
  const torrentUrl = normalizeUrl(
    raw.enclosure?.url || raw.torrentUrl || raw.link
  );

  if (!torrentUrl) {
    throw new Error("No hay magnet ni torrentUrl");
  }

  // Descargar el .torrent a memoria
  const torrentRes = await fetch(torrentUrl);
  if (!torrentRes.ok) {
    throw new Error("No se pudo descargar el .torrent desde Jackett");
  }

  const contentType = torrentRes.headers.get("content-type") || "";

  // Si Jackett no devuelve un .torrent, intentamos buscar un magnet en el cuerpo
  let buffer = null;
  let magnetFromBody = null;

  if (contentType.includes("application/x-bittorrent")) {
    buffer = await torrentRes.buffer();
  } else {
    const text = await torrentRes.text();

    // Buscar magnet dentro del HTML/texto
    const m = text.match(/(magnet:\?[^"'<>\s]+)/i);
    if (m && m[1]) {
      magnetFromBody = m[1];
    } else if (torrentUrl && torrentUrl.startsWith("magnet:")) {
      magnetFromBody = torrentUrl;
    } else {
      throw new Error(
        `Jackett no devolvió .torrent válido (content-type=${contentType}). Primeros chars: ${text.slice(
          0,
          120
        )}`
      );
    }
  }

  // Si obtuvimos un magnet desde la página, subir como magnet
  if (magnetFromBody) {
    const magnet = normalizeUrl(magnetFromBody);
    const res = await fetch(`${BASE}/magnet/upload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ALLDEBRID_API_KEY}`,
      },
      body: JSON.stringify({ magnet }),
    });

    const json = await res.json();
    if (!json?.status || json.status !== "success") {
      console.error("AllDebrid magnet upload failed:", json);
      throw new Error(
        "Error subiendo magnet a AllDebrid: " + (json?.error?.message || JSON.stringify(json))
      );
    }
    return json;
  }

  // Antes de subir, guarda el .torrent en ./downloads para depuración (si tenemos buffer)
  if (buffer) {
    try {
      const downloadsDir = path.join(__dirname, "downloads");
      await fs.promises.mkdir(downloadsDir, { recursive: true });
      const filename = `upload-${Date.now()}.torrent`;
      const filepath = path.join(downloadsDir, filename);
      await fs.promises.writeFile(filepath, buffer);
      console.log("Saved .torrent for inspection:", filepath);
    } catch (e) {
      console.warn("No se pudo guardar .torrent localmente:", e.message || e);
    }
  }

  // Subir .torrent usando el endpoint correcto: /v4/magnet/upload/file
  const form = new FormData();
  form.append("files[]", buffer, {
    filename: "upload.torrent",
    contentType: "application/x-bittorrent",
  });

  const uploadRes = await fetch(`${BASE}/magnet/upload/file`, {
    method: "POST",
    body: form,
    headers: Object.assign({}, form.getHeaders(), {
      Authorization: `Bearer ${ALLDEBRID_API_KEY}`,
    }),
  });

  let uploadJson = {};
  try {
    uploadJson = await uploadRes.json();
  } catch (e) {
    console.error("AllDebrid upload non-json response", { status: uploadRes.status, statusText: uploadRes.statusText });
    throw new Error("File upload failed: respuesta no JSON desde AllDebrid");
  }

  if (!uploadJson?.status || uploadJson.status !== "success") {
    console.error("AllDebrid upload failed:", uploadJson);
    throw new Error("File upload failed: " + (uploadJson?.error?.message || JSON.stringify(uploadJson)));
  }

  return uploadJson;
}

/* =========================
   LIST
========================= */
async function listItems() {
  const res = await fetch(`${BASE}/magnet/status`, {
    headers: { Authorization: `Bearer ${ALLDEBRID_API_KEY}` },
  });
  const json = await res.json();
  if (json?.status !== "success") return [];

  const magnets = Array.isArray(json.data?.magnets) ? json.data.magnets : [];

  // Map to a simple shape the frontend can use
  return magnets.map((m) => ({
    id: m.id || m.hash || null,
    magnet: m.magnet || null,
    title: m.name || m.filename || m.magnet || "Sin nombre",
    sizeBytes: typeof m.size === "number" ? m.size : m.size ? Number(m.size) : null,
    ready: m.ready || false,
    // AllDebrid may provide a timestamp in different fields; prefer uploadDate
    createdAt:
      m.uploadDate || m.upload_date || m.added || m.added_at || m.time || m.timestamp || null,
    raw: m,
  }));
}

/* =========================
   GET DOWNLOADABLE LINKS
   Obtiene URLs de descarga para archivos de video
========================= */
async function getDownloadableLinks(magnetId) {
  if (!magnetId) throw new Error("ID del magnet requerido");

  // Paso 1: Obtener archivos del magnet
  const filesForm = new FormData();
  filesForm.append("id[]", magnetId);

  const filesRes = await fetch(`${BASE}/magnet/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALLDEBRID_API_KEY}`,
    },
    body: filesForm,
  });

  const filesJson = await filesRes.json();
  if (filesJson?.status !== "success" || !filesJson?.data?.magnets?.[0]) {
    throw new Error("Error obteniendo archivos: " + (filesJson?.error?.message || JSON.stringify(filesJson)));
  }

  const magnet = filesJson.data.magnets[0];
  const files = magnet.files || [];

  // Filtrar solo archivos de video
  const videoExtensions = [".mp4", ".mkv", ".avi", ".mov", ".flv", ".wmv", ".webm", ".m4v"];
  const videoFiles = [];

  for (const folder of files) {
    if (folder.e && Array.isArray(folder.e)) {
      for (const file of folder.e) {
        const filename = file.n || "";
        const isVideo = videoExtensions.some(ext => filename.toLowerCase().endsWith(ext));
        if (isVideo) {
          videoFiles.push({
            name: filename,
            url: file.l || "",
          });
        }
      }
    }
  }

  if (!videoFiles.length) {
    throw new Error("No se encontraron archivos de video");
  }

  // Paso 2: Desbloquear cada link
  const unlockedLinks = [];
  for (const file of videoFiles) {
    try {
      const linkForm = new FormData();
      linkForm.append("link", file.url);

      const linkRes = await fetch(`${BASE}/link/unlock`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ALLDEBRID_API_KEY}`,
        },
        body: linkForm,
      });

      const linkJson = await linkRes.json();
      if (linkJson?.status === "success" && linkJson?.data?.link) {
        // Limpiar escapes de las barras
        const cleanUrl = linkJson.data.link.replace(/\\\//g, "/");
        unlockedLinks.push({
          filename: file.name,
          url: cleanUrl,
        });
      }
    } catch (err) {
      console.warn(`Error desbloqueando ${file.name}:`, err.message);
    }
  }

  if (!unlockedLinks.length) {
    throw new Error("No se pudieron desbloquear los links");
  }

  return unlockedLinks;
}

module.exports = {
  addItem,
  listItems,
  deleteItem,
  getDownloadableLinks,
};

/* =========================
   DELETE ITEM
========================= */
async function deleteItem(magnetId) {
  if (!magnetId) throw new Error("ID del magnet requerido");

  const form = new FormData();
  form.append("id", magnetId);

  const res = await fetch(`${BASE}/magnet/delete`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ALLDEBRID_API_KEY}`,
    },
    body: form,
  });

  const json = await res.json();
  if (json?.status !== "success") {
    throw new Error("Error eliminando magnet: " + (json?.error?.message || JSON.stringify(json)));
  }
  return json;
}

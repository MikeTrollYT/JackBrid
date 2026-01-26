const API = {
  health: "/api/health",
  trackers: "/api/trackers",
  search: "/api/search",
  add: "/api/add",
  list: "/api/list",
  links: "/api/links",
  delete: "/api/delete",
  downloadLinks: "/api/download-links",
};

const el = (id) => document.getElementById(id);

const state = {
  trackers: [],
  results: [],
  downloads: [],
  links: {
    jackett: `http://${window.location.hostname}:9117`,
    alldebrid: "https://alldebrid.com/magnets/",
    alldebridApiKey: ""
  },
};

/* ===========================
   TOAST
=========================== */
function toast(msg) {
  const t = el("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2400);
}

/* ===========================
   FORMAT BYTES
=========================== */
function fmtBytes(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}

/* ===========================
   API HELPERS
=========================== */
async function apiGet(url) {
  const r = await fetch(url, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function apiPost(url, body) {
  const r = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`${r.status} ${r.statusText}${txt ? " — " + txt : ""}`);
  }
  return r.json();
}

/* ===========================
   HEALTH
=========================== */
async function refreshHealth() {
  const txt = el("healthText");
  try {
    const data = await apiGet(API.health);
    txt.textContent = data?.ok ? "Backend OK" : "Backend";
  } catch {
    txt.textContent = "Conectando…";
  }
}

/* ===========================
   TRACKERS
=========================== */
async function refreshTrackers() {
  try {
    const data = await apiGet(API.trackers);
    state.trackers = Array.isArray(data.trackers) ? data.trackers : [];
    renderTrackers();
  } catch (e) {
    state.trackers = [];
    renderTrackers();
    toast("No se pudieron cargar trackers: " + e.message);
  }
}

function renderTrackers() {
  const wrap = el("trackers");
  wrap.innerHTML = "";

  if (!state.trackers.length) {
    wrap.innerHTML = `<div class="empty">No hay trackers.</div>`;
    return;
  }

  for (const t of state.trackers) {
    const label = document.createElement("label");
    label.className = "tracker";
    label.innerHTML = `
      <input type="checkbox" name="tracker" value="${escapeHtml(t.id)}">
      <div>
        <div class="name">${escapeHtml(t.name || t.id)}</div>
        <div class="meta">${escapeHtml(t.description || "")}</div>
      </div>
    `;
    wrap.appendChild(label);
  }
}

function selectedTrackerIds() {
  return [...document.querySelectorAll('input[name="tracker"]:checked')].map(
    (i) => i.value
  );
}

/* ===========================
   SEARCH
=========================== */
async function doSearch() {
  const q = el("q").value.trim();
  const trackers = selectedTrackerIds();
  if (!q) return toast("Escribe algo para buscar");
  if (!trackers.length) return toast("Selecciona trackers");

  el("results-loading")?.classList.remove("hidden");

  try {
    const sort = el("sort")?.value || "relevance";
    const limit = el("limit")?.value || "50";
    const onlySeeded = el("onlySeeded")?.value || "no";

    const params = new URLSearchParams({
      q,
      trackers: trackers.join(","),
      sort,
      limit,
      onlySeeded,
    });
    const data = await apiGet(`${API.search}?${params}`);
    state.results = Array.isArray(data.results) ? data.results : [];
    renderResults();
    toast(`Resultados: ${state.results.length}`);
  } catch (e) {
    state.results = [];
    renderResults();
    toast("Error buscando: " + e.message);
  } finally {
    el("results-loading")?.classList.add("hidden");
  }
}

/* ===========================
   RESULTS
=========================== */
function renderResults() {
  const body = el("resultsBody");
  body.innerHTML = "";

  if (!state.results.length) {
    body.innerHTML = `<tr><td colspan="5" class="empty">Sin resultados</td></tr>`;
    return;
  }

  for (const r of state.results) {
    const tr = document.createElement("tr");

    tr.innerHTML = `
      <td>${escapeHtml(r.title ?? "—")}</td>
      <td>${fmtBytes(r.sizeBytes)}</td>
      <td>${r.seeders ?? "—"}</td>
      <td>${escapeHtml(r.tracker ?? r.trackerId ?? "—")}</td>
      <td>
        <button class="btn btn-sm">Enviar</button>
      </td>
    `;

    // Extraer magnet en servidor, subir desde navegador del usuario
    tr.querySelector("button").onclick = async () => {
      try {
        // 1. Obtener magnet desde el backend (servidor descarga .torrent y extrae magnet)
        const magnetRes = await fetch("/api/extract-magnet", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ raw: r.raw }),
        });

        if (!magnetRes.ok) {
          const errData = await magnetRes.json().catch(() => ({ error: magnetRes.statusText }));
          throw new Error(errData.error || "Error extrayendo magnet");
        }

        const magnetData = await magnetRes.json();
        const magnet = magnetData.magnet;

        if (!magnet) {
          throw new Error("No se pudo extraer el magnet del torrent");
        }

        // 2. Subir magnet desde el navegador a AllDebrid (IP del usuario)
        const apiKey = state.links.alldebridApiKey;
        if (!apiKey) {
          throw new Error("API Key de AllDebrid no configurada");
        }
        
        const form = new FormData();
        form.append("magnets[]", magnet);

        const uploadRes = await fetch("https://api.alldebrid.com/v4/magnet/upload", {
          method: "POST",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: form,
        });

        if (!uploadRes.ok) {
          throw new Error(`AllDebrid respondió con ${uploadRes.status}`);
        }

        const uploadJson = await uploadRes.json();
        if (!uploadJson?.status || uploadJson.status !== "success") {
          throw new Error(uploadJson?.error?.message || "Error subiendo a AllDebrid");
        }

        toast("Enviado a AllDebrid");
        await refreshDownloads();
      } catch (e) {
        toast("Error: " + e.message);
      }
    };

    body.appendChild(tr);
  }
}

/* ===========================
   DOWNLOADS
=========================== */
async function refreshDownloads() {
  try {
    const data = await apiGet(API.list);
    state.downloads = Array.isArray(data.items) ? data.items : [];
    renderDownloads();
  } catch (e) {
    toast("No se pudo cargar descargas: " + e.message);
  }
}

function renderDownloads() {
  const wrap = el("downloads");
  wrap.innerHTML = "";

  if (!state.downloads.length) {
    wrap.innerHTML = `<div class="empty">Sin descargas</div>`;
    updateDownloadStats();
    return;
  }

  for (const d of state.downloads) {
    const p = typeof d.progress === "number" ? Math.max(0, Math.min(100, d.progress)) : 0;

    const name = d.title || d.name || "Sin nombre";
    const size = typeof d.sizeBytes === "number" ? fmtBytes(d.sizeBytes) : "—";
    const created = d.createdAt ? fmtDate(d.createdAt) : "—";

    const div = document.createElement("div");
    div.className = "dl";
    div.innerHTML = `
      <div class="dl-top">
        <div>
          <div class="dl-title">${escapeHtml(name)}</div>
          <div class="dl-sub">Tamaño: ${escapeHtml(size)} — Añadido: ${escapeHtml(created)}</div>
        </div>
        <div class="dl-actions">
          <button class="btn-play" data-play-id="${d.id}" title="Reproducir video">▶️</button>
          <button class="btn-copy" data-copy-id="${d.id}" title="Copiar enlaces de video">📋</button>
          <button class="btn-delete" data-id="${d.id}" title="Eliminar descarga">🗑️</button>
        </div>
      </div>
      <div class="progress">
        <div style="width:${p}%"></div>
      </div>
    `;
    wrap.appendChild(div);
    
    // Agregar eventos
    const playBtn = div.querySelector(".btn-play");
    const copyBtn = div.querySelector(".btn-copy");
    const deleteBtn = div.querySelector(".btn-delete");
    
    playBtn.onclick = () => playVideo(d.id, name);
    copyBtn.onclick = () => copyDownloadLinks(d.id, name);
    deleteBtn.onclick = () => deleteDownload(d.id);
  }
  
  updateDownloadStats();
}

function updateDownloadStats() {
  const totalCount = state.downloads.length;
  const totalSize = state.downloads.reduce((sum, d) => sum + (d.sizeBytes || 0), 0);
  
  const statsTotal = el("statsTotal");
  const statsSize = el("statsSize");
  
  if (statsTotal) statsTotal.textContent = `Total: ${totalCount}`;
  if (statsSize) statsSize.textContent = `Espacio: ${fmtBytes(totalSize)}`;
}

async function deleteDownload(magnetId) {
  if (!confirm("¿Estás seguro de que quieres eliminar esta descarga?")) {
    return;
  }
  
  try {
    const res = await fetch(API.delete, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: magnetId }),
      credentials: "include",
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error al eliminar");
    
    toast("Descarga eliminada");
    await refreshDownloads();
  } catch (err) {
    console.error("Error eliminando descarga:", err);
    toast("Error eliminando descarga: " + err.message);
  }
}

async function copyDownloadLinks(magnetId, title) {
  try {
    // Mostrar indicador de carga
    const btn = document.querySelector(`[data-copy-id="${magnetId}"]`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = "⏳";
    }

    const res = await fetch(API.downloadLinks, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: magnetId }),
      credentials: "include",
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error obteniendo links");

    if (!data.links || !data.links.length) {
      throw new Error("No se encontraron archivos de video");
    }

    // Restaurar botón
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📋";
    }

    // Si hay más de 1 enlace, mostrar modal
    if (data.links.length > 1) {
      showLinksModal(data.links, title);
    } else {
      // Si solo hay 1, copiar directamente
      await copyToClipboard(data.links[0].url);
      toast("Enlace copiado");
    }
  } catch (err) {
    console.error("Error copiando links:", err);
    toast("Error: " + err.message);
    
    const btn = document.querySelector(`[data-copy-id="${magnetId}"]`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "📋";
    }
  }
}

function showLinksModal(links, title) {
  const modal = el("linksModal");
  const linksTitle = el("linksTitle");
  const linksList = el("linksList");
  
  linksTitle.textContent = title || "Archivos disponibles";
  linksList.innerHTML = "";
  
  links.forEach((link, index) => {
    const linkItem = document.createElement("div");
    linkItem.className = "link-item";
    
    const linkName = document.createElement("div");
    linkName.className = "link-name";
    linkName.textContent = link.filename;
    
    const copyBtn = document.createElement("button");
    copyBtn.className = "btn-copy-link";
    copyBtn.textContent = "📋 Copiar";
    copyBtn.onclick = async () => {
      try {
        await copyToClipboard(link.url);
        toast(`Copiado: ${link.filename}`);
      } catch (err) {
        toast("Error al copiar");
      }
    };
    
    linkItem.appendChild(linkName);
    linkItem.appendChild(copyBtn);
    linksList.appendChild(linkItem);
  });
  
  modal.classList.remove("hidden");
}

function closeLinksModal() {
  const modal = el("linksModal");
  modal.classList.add("hidden");
}

async function copyToClipboard(text) {
  let copied = false;
  
  // Método 1: navigator.clipboard (HTTPS o localhost)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
    } catch (err) {
      console.warn("Clipboard API fallida, usando método alternativo:", err);
    }
  }
  
  // Método 2: Fallback con document.execCommand (HTTP)
  if (!copied) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    
    try {
      document.execCommand("copy");
      copied = true;
    } catch (err) {
      console.error("execCommand fallida:", err);
    }
    
    document.body.removeChild(textarea);
  }
  
  if (!copied) {
    throw new Error("No se pudo copiar al portapapeles");
  }
}

function fmtDate(v) {
  // Accept timestamps (seconds or ms) or ISO strings
  if (!v) return null;
  let d;
  if (typeof v === "number") {
    d = v > 1e12 ? new Date(v) : new Date(v * 1000);
  } else {
    d = new Date(v);
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString();
}

/* ===========================
   VIDEO PLAYER
=========================== */
let playerInstance = null;

async function playVideo(magnetId, title) {
  try {
    const modal = el("videoModal");
    const videoTitle = el("videoTitle");
    const videoPlayer = el("videoPlayer");
    const videoSource = el("videoSource");
    const videoLinks = el("videoLinks");
    
    // Destruir instancia anterior de Plyr si existe
    if (playerInstance) {
      playerInstance.destroy();
      playerInstance = null;
    }
    
    // Resetear completamente el reproductor antes de cargar nuevo contenido
    videoPlayer.pause();
    videoPlayer.removeAttribute("src");
    videoSource.removeAttribute("src");
    videoPlayer.load();
    
    // Mostrar modal y loading
    modal.classList.remove("hidden");
    videoTitle.textContent = "Cargando...";
    videoLinks.innerHTML = '<div class="loading"><div class="spinner"></div><span>Obteniendo enlaces...</span></div>';
    
    // Obtener los enlaces de descarga
    const res = await fetch(API.downloadLinks, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: magnetId }),
      credentials: "include",
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Error obteniendo links");
    
    if (!data.links || !data.links.length) {
      throw new Error("No se encontraron archivos de video");
    }
    
    // Actualizar título
    videoTitle.textContent = title;
    
    // Reproducir el primer video automáticamente
    const firstVideo = data.links[0];
    videoSource.src = firstVideo.url;
    videoPlayer.load();
    
    // Inicializar Plyr
    playerInstance = new Plyr(videoPlayer, {
      controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'settings', 'fullscreen'],
      settings: ['quality', 'speed'],
      autoplay: false,
      muted: false,
      volume: 1
    });
    
    // Mostrar lista de videos si hay más de uno
    videoLinks.innerHTML = "";
    if (data.links.length > 1) {
      const linksTitle = document.createElement("div");
      linksTitle.className = "video-links-title";
      linksTitle.textContent = "Otros archivos:";
      videoLinks.appendChild(linksTitle);
      
      data.links.forEach((link, index) => {
        const linkBtn = document.createElement("button");
        linkBtn.className = "video-link-btn";
        linkBtn.textContent = link.filename;
        linkBtn.onclick = () => {
          videoSource.src = link.url;
          videoPlayer.load();
          videoTitle.textContent = link.filename;
          if (playerInstance) {
            playerInstance.source = {
              type: 'video',
              sources: [{ src: link.url }]
            };
          }
        };
        videoLinks.appendChild(linkBtn);
      });
    }
    
  } catch (err) {
    console.error("Error reproduciendo video:", err);
    toast("Error: " + err.message);
    el("videoModal").classList.add("hidden");
  }
}

function closeVideoModal() {
  const modal = el("videoModal");
  const videoPlayer = el("videoPlayer");
  const videoSource = el("videoSource");
  
  // Destruir instancia de Plyr
  if (playerInstance) {
    playerInstance.destroy();
    playerInstance = null;
  }
  
  // Parar y limpiar completamente el reproductor
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoSource.removeAttribute("src");
  videoPlayer.load();
  
  modal.classList.add("hidden");
}

/* ===========================
   UTILS
=========================== */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  }[m]));
}

/* ===========================
   LOAD LINKS
   Obtiene URLs dinámicamente del backend
=========================== */
async function loadLinks() {
  try {
    const data = await apiGet(API.links);
    state.links = { ...state.links, ...data };
    
    // Si el link de Jackett contiene localhost, reemplazarlo con el hostname actual
    if (state.links.jackett && state.links.jackett.includes('localhost')) {
      state.links.jackett = state.links.jackett.replace('localhost', window.location.hostname);
    }
    
    // Actualiza los href de los enlaces dinámicamente
    const jackettLink = el("linkJackett");
    const alldebridLink = el("linkAlldebrid");
    
    if (jackettLink) jackettLink.href = state.links.jackett;
    if (alldebridLink) alldebridLink.href = state.links.alldebrid;
  } catch (err) {
    console.warn("No se pudieron cargar los links:", err.message);
  }
}

/* ===========================
   INIT
=========================== */
function wireUI() {
  el("btnReloadTrackers").onclick = refreshTrackers;
  el("btnSearch").onclick = doSearch;
  el("btnClearResults").onclick = () => {
    state.results = [];
    renderResults();
  };
  el("btnSelectAll").onclick = () => {
    document.querySelectorAll('input[name="tracker"]').forEach(i => (i.checked = true));
  };
  el("btnSelectNone").onclick = () => {
    document.querySelectorAll('input[name="tracker"]').forEach(i => (i.checked = false));
  };
  el("btnRefreshDownloads").onclick = refreshDownloads;
  
  // Modal de video
  el("closeModal").onclick = closeVideoModal;
  el("videoModal").onclick = (e) => {
    if (e.target.id === "videoModal") closeVideoModal();
  };
  
  // Modal de enlaces
  el("closeLinksModal").onclick = closeLinksModal;
  el("linksModal").onclick = (e) => {
    if (e.target.id === "linksModal") closeLinksModal();
  };
  
  // Auto refresh handled by interval started in init
  el("q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
}

(async function init() {
  wireUI();
  await loadLinks();
  await refreshHealth();
  await refreshTrackers();
  await refreshDownloads();
  // Start auto-refresh loop
  setInterval(() => {
    const auto = el("autoRefresh");
    if (auto && auto.checked) {
      refreshDownloads().catch(() => {});
    }
  }, 15000);
})();
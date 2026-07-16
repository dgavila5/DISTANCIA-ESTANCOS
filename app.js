// App logic for Estancos Influence Zone Visualizer

function safeCreateIcons() {
  try {
    if (typeof lucide !== 'undefined') {
      lucide.createIcons();
    }
  } catch (e) {
    console.error("Lucide icon generation failed:", e);
  }
}

let db = null;
let isFallbackDB = false;

if (typeof Dexie !== 'undefined') {
  try {
    db = new Dexie("EstancosDB");
    db.version(1).stores({
      client: 'id, name, lat, lon',
      competitors: '++id, name, lat, lon'
    });
  } catch (e) {
    isFallbackDB = true;
  }
} else {
  isFallbackDB = true;
}

if (isFallbackDB) {
  db = {
    client: {
      get: async (id) => { const val = localStorage.getItem(`estancos_client_${id}`); return val ? JSON.parse(val) : null; },
      put: async (data) => { localStorage.setItem(`estancos_client_${data.id}`, JSON.stringify(data)); return data.id; },
      delete: async (id) => { localStorage.removeItem(`estancos_client_${id}`); }
    },
    competitors: {
      toArray: async () => { return JSON.parse(localStorage.getItem('estancos_competitors') || '[]'); },
      add: async (data) => {
        const list = JSON.parse(localStorage.getItem('estancos_competitors') || '[]');
        const nextId = list.reduce((max, item) => Math.max(max, item.id || 0), 0) + 1;
        data.id = nextId; list.push(data);
        localStorage.setItem('estancos_competitors', JSON.stringify(list)); return nextId;
      },
      put: async (data) => {
        const list = JSON.parse(localStorage.getItem('estancos_competitors') || '[]');
        const idx = list.findIndex(item => item.id === data.id);
        if (idx !== -1) list[idx] = data; else list.push(data);
        localStorage.setItem('estancos_competitors', JSON.stringify(list)); return data.id;
      },
      delete: async (id) => {
        const list = JSON.parse(localStorage.getItem('estancos_competitors') || '[]');
        localStorage.setItem('estancos_competitors', JSON.stringify(list.filter(item => item.id !== id)));
      },
      clear: async () => { localStorage.removeItem('estancos_competitors'); }
    }
  };
}

let map = null;
let clientMarker = null;
let competitorMarkersMap = new Map();
let clientEstanco = null;
let competitorEstancos = [];
let influenceLayer = null;
let currentCaptureMode = 'client';
let queryMarker = null;

const DEFAULT_CENTER = [40.9701, -5.6635];
const DEFAULT_ZOOM = 14;

async function preloadDatabaseIfEmpty() {
  try {
    const APP_VERSION = 'v1.1'; // Incrementing version triggers database update
    const savedVersion = localStorage.getItem('app_db_version');
    
    if (savedVersion !== APP_VERSION) {
      console.log("New version detected, clearing database and forcing preload...");
      await db.client.delete('main');
      await db.competitors.clear();
      localStorage.setItem('app_db_version', APP_VERSION);
    }
    
    const clientCount = await db.client.get('main');
    const competitors = await db.competitors.toArray();
    
    if (!clientCount && competitors.length === 0) {
      console.log("Database is empty, preloading from backup...");
      const response = await fetch('ESTANCOS/estancos_backup_2026-07-16.json');
      if (response.ok) {
        const data = await response.json();
        if (data.client) {
          await db.client.put(data.client);
        }
        if (data.competitors && data.competitors.length > 0) {
          for (const comp of data.competitors) {
            await db.competitors.add({
              name: comp.name,
              lat: comp.lat,
              lon: comp.lon
            });
          }
        }
        console.log("Preloading completed successfully!");
      } else {
        console.error("Failed to fetch backup JSON:", response.statusText);
      }
    }
  } catch (e) {
    console.error("Error during database preloading:", e);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  safeCreateIcons();
  
  // Initialize general UI event handlers and load DB cache first (for offline robustness)
  initUIHandlers();
  await preloadDatabaseIfEmpty();
  await loadDatabaseCache();
  
  if (typeof L === 'undefined') {
    // Show user-friendly connection/library failure modal
    const warningModal = document.getElementById('no-leaflet-warning');
    if (warningModal) {
      warningModal.classList.remove('hidden');
      warningModal.classList.add('flex');
    }
    return;
  }
  
  initMap();
  
  // Re-run map-dependent updates once map & Leaflet are fully ready
  if (clientEstanco) renderClientMarker();
  renderCompetitorMarkers();
  if (influenceLayer) influenceLayer.redraw();

  setTimeout(() => { if (map) map.invalidateSize(); }, 250);
});

function initMap() {
  map = L.map('map', {
    zoomControl: false,
    zoomSnap: 0.25,
    zoomDelta: 0.25,
    wheelPxPerZoomLevel: 150
  }).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  initInfluenceLayer();
  map.on('click', handleMapClick);

  // Set default crosshair cursor on capture mode
  const mapContainer = document.getElementById('map');
  if (mapContainer) {
    mapContainer.classList.add('capture-mode-active');
  }
}

function initInfluenceLayer() {
  const InfluenceGridLayer = L.GridLayer.extend({
    createTile: function (coords) {
      const tile = L.DomUtil.create('canvas', 'leaflet-tile');
      const size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      
      const ctx = tile.getContext('2d');
      if (!clientEstanco || !map) return tile;
      
      ctx.fillStyle = 'rgba(34, 197, 94, 0.32)'; // emerald-500 @ 32%
      
      let resolution = 2;
      if (coords.z < 9) return tile;
      else if (coords.z < 13) resolution = 4;
      else resolution = 2;
      
      if (competitorEstancos.length < 3) {
        ctx.fillRect(0, 0, size.x, size.y);
        return tile;
      }
      
      const tileNwPoint = coords.scaleBy(size);
      
      // Project client to pixel coordinates at this zoom
      const clientPt = map.project([clientEstanco.lat, clientEstanco.lon], coords.z);
      
      // Project all competitors to pixel coordinates at this zoom
      const compPts = competitorEstancos.map(c => map.project([c.lat, c.lon], coords.z));
      const numComp = compPts.length;
      
      for (let y = 0; y < size.y; y += resolution) {
        const py = tileNwPoint.y + y + resolution / 2;
        const dyClient = py - clientPt.y;
        const dyClientSq = dyClient * dyClient;
        
        // Cache Y distances for competitors
        const dyCompSq = new Float64Array(numComp);
        for (let i = 0; i < numComp; i++) {
          const dy = py - compPts[i].y;
          dyCompSq[i] = dy * dy;
        }
        
        for (let x = 0; x < size.x; x += resolution) {
          const px = tileNwPoint.x + x + resolution / 2;
          
          // Client distance squared
          const dxClient = px - clientPt.x;
          const dClient = dxClient * dxClient + dyClientSq;
          
          // Find 3 closest competitors
          let c1 = Infinity, c2 = Infinity, c3 = Infinity;
          for (let i = 0; i < numComp; i++) {
            const dx = px - compPts[i].x;
            const dComp = dx * dx + dyCompSq[i];
            
            if (dComp < c3) {
              if (dComp < c2) {
                if (dComp < c1) { c3 = c2; c2 = c1; c1 = dComp; }
                else { c3 = c2; c2 = dComp; }
              } else c3 = dComp;
            }
          }
          
          if (dClient < c3) {
            ctx.fillRect(x, y, resolution, resolution);
          }
        }
      }
      
      return tile;
    }
  });

  influenceLayer = new InfluenceGridLayer({
    attribution: 'Zonas de Influencia',
    opacity: 1.0,
    zIndex: 100,
    updateWhenIdle: false
  });
  influenceLayer.addTo(map);
}


// Actual Haversine distance in kilometers for sidebar representation
function calcularDistanciaHaversine(lat1, lon1, lat2, lon2) {
  const TO_RAD = Math.PI / 180;
  const R = 6371; // Earth radius in km
  
  const dLat = (lat2 - lat1) * TO_RAD;
  const dLon = (lon2 - lon1) * TO_RAD;
  
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * TO_RAD) * Math.cos(lat2 * TO_RAD) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function formatDistance(distKm) {
  if (distKm < 1) {
    return `${Math.round(distKm * 1000)} m`;
  } else {
    return `${distKm.toFixed(2)} km`;
  }
}

async function loadDatabaseCache() {
  const TO_RAD = Math.PI / 180;
  
  const clientObj = await db.client.get('main');
  if (clientObj) {
    clientEstanco = {
      ...clientObj,
      latRad: clientObj.lat * TO_RAD,
      lonRad: clientObj.lon * TO_RAD,
      cosLat: Math.cos(clientObj.lat * TO_RAD),
      sinLat: Math.sin(clientObj.lat * TO_RAD)
    };
    updateClientUIState(true);
    if (typeof L !== 'undefined' && map) renderClientMarker();
  } else {
    clientEstanco = null;
    updateClientUIState(false);
    if (typeof L !== 'undefined' && map && clientMarker) { map.removeLayer(clientMarker); clientMarker = null; }
  }

  const list = await db.competitors.toArray();
  competitorEstancos = list.map(comp => ({
    ...comp,
    latRad: comp.lat * TO_RAD,
    lonRad: comp.lon * TO_RAD,
    cosLat: Math.cos(comp.lat * TO_RAD),
    sinLat: Math.sin(comp.lat * TO_RAD)
  }));
  
  if (typeof L !== 'undefined' && map) renderCompetitorMarkers();
  renderCompetitorsList();

  if (typeof L !== 'undefined' && map && influenceLayer) influenceLayer.redraw();
}

function renderClientMarker() {
  if (!clientEstanco || typeof L === 'undefined' || !map) return;
  const latlng = [clientEstanco.lat, clientEstanco.lon];
  
  const clientIcon = L.divIcon({
    className: 'client-marker-container',
    html: `<div class="client-marker-pulse"></div><div class="client-marker-core"><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" class="lucide lucide-star"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>`,
    iconSize: [32, 32], iconAnchor: [16, 16]
  });

  if (clientMarker) {
    clientMarker.setLatLng(latlng);
  } else {
    clientMarker = L.marker(latlng, { icon: clientIcon, draggable: true }).addTo(map);
    clientMarker.bindPopup(`<strong>${clientEstanco.name} (Mi Estanco)</strong><br><span class="text-zinc-400 text-xs">Arrastra para mover</span>`);
    clientMarker.bindTooltip(clientEstanco.name, { className: 'custom-tooltip', direction: 'top', offset: [0, -12] });

    clientMarker.on('dragend', async (event) => {
      const position = event.target.getLatLng();
      if (confirm(`¿Estás seguro de que deseas mover "${clientEstanco.name}" a esta nueva posición?`)) {
        clientEstanco.lat = position.lat;
        clientEstanco.lon = position.lng;
        await db.client.put(clientEstanco);
        await loadDatabaseCache();
        const coordEl = document.getElementById('client-saved-coords');
        if (coordEl) coordEl.textContent = `${position.lat.toFixed(5)}, ${position.lng.toFixed(5)}`;
      } else {
        event.target.setLatLng([clientEstanco.lat, clientEstanco.lon]);
      }
    });
  }
}

function renderCompetitorMarkers() {
  if (typeof L === 'undefined' || !map) return;

  // Reconcile Markers: Add, Update or Delete markers from map instead of rebuilding all.
  const currentIds = new Set(competitorEstancos.map(c => c.id));
  
  competitorMarkersMap.forEach((marker, id) => {
    if (!currentIds.has(id)) {
      map.removeLayer(marker);
      competitorMarkersMap.delete(id);
    }
  });

  competitorEstancos.forEach(comp => {
    const latlng = [comp.lat, comp.lon];
    const existingMarker = competitorMarkersMap.get(comp.id);

    if (existingMarker) {
      const currentPos = existingMarker.getLatLng();
      if (currentPos.lat !== comp.lat || currentPos.lng !== comp.lon) {
        existingMarker.setLatLng(latlng);
      }
    } else {
      const competitorIcon = L.divIcon({
        className: 'client-marker-container',
        html: `<div class="competitor-marker-pulse"></div><div class="competitor-marker-core"></div>`,
        iconSize: [24, 24], iconAnchor: [12, 12]
      });

      const marker = L.marker(latlng, { icon: competitorIcon, draggable: true }).addTo(map);
      marker.bindPopup(`<strong>${comp.name}</strong><br><span class="text-zinc-400 text-xs">Competidor • Arrastra para mover</span>`);
      marker.bindTooltip(comp.name, { className: 'custom-tooltip', direction: 'top', offset: [0, -8] });

      marker.on('dragend', async (event) => {
        const newPos = event.target.getLatLng();
        if (confirm(`¿Estás seguro de que deseas mover "${comp.name}" a esta nueva posición?`)) {
          comp.lat = newPos.lat; comp.lon = newPos.lng;
          await db.competitors.put(comp);
          await loadDatabaseCache();
        } else {
          event.target.setLatLng([comp.lat, comp.lon]);
        }
      });

      competitorMarkersMap.set(comp.id, marker);
    }
  });
}

function renderCompetitorsList() {
  const listContainer = document.getElementById('competitors-list');
  const emptyState = document.getElementById('competitors-empty');
  const countBadge = document.getElementById('competitors-count');
  
  if (!listContainer || !emptyState || !countBadge) return;

  countBadge.textContent = `${competitorEstancos.length} añadidos`;
  
  if (competitorEstancos.length === 0) {
    emptyState.classList.remove('hidden');
    listContainer.classList.add('hidden');
    listContainer.innerHTML = '';
    return;
  }

  emptyState.classList.add('hidden');
  listContainer.classList.remove('hidden');

  let listHtml = '';
  competitorEstancos.forEach((comp) => {
    listHtml += `
      <div class="bg-zinc-900/60 border border-zinc-800/80 p-3 rounded-xl flex items-center justify-between transition-all duration-200 hover:border-rose-500/30">
        <div class="space-y-0.5 min-w-0 pr-2 flex-1">
          <div class="flex items-center gap-2 justify-between">
            <h4 class="font-semibold text-white text-xs truncate flex-1" title="${comp.name}">${comp.name}</h4>
          </div>
          <p class="text-[10px] text-zinc-500 font-mono truncate">${comp.lat.toFixed(5)}, ${comp.lon.toFixed(5)}</p>
        </div>
        <div class="flex space-x-1 shrink-0 ml-2">
          <button onclick="makeMainEstanco(${comp.id})" class="p-1 bg-zinc-800 hover:bg-emerald-500/20 text-zinc-300 hover:text-emerald-400 rounded-lg border border-zinc-700/50" title="Establecer como mi estanco principal">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="fill-none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </button>
          <button onclick="zoomToEstanco(${comp.lat}, ${comp.lon})" class="p-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg border border-zinc-700/50" title="Centrar mapa">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
          </button>
          <button onclick="deleteCompetitor(${comp.id})" class="p-1 bg-zinc-800 hover:bg-rose-500/20 text-zinc-300 hover:text-rose-400 rounded-lg border border-zinc-700/50" title="Eliminar competidor">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>
          </button>
        </div>
      </div>
    `;
  });

  listContainer.innerHTML = listHtml;
}

window.zoomToEstanco = function (lat, lon) {
  if (map) map.setView([lat, lon], 16, { animate: true, duration: 1.0 });
};

function handleMapClick(e) {
  const lat = e.latlng.lat;
  const lon = e.latlng.lng;
  
  if (currentCaptureMode === 'query') {
    showClosestEstancosPopup(lat, lon);
    return;
  }
  
  const latInput = document.getElementById('modal-lat');
  const lonInput = document.getElementById('modal-lon');
  const coordsDisplay = document.getElementById('modal-coords-display');
  const targetTypeInput = document.getElementById('modal-target-type');
  
  if (latInput) latInput.value = lat;
  if (lonInput) lonInput.value = lon;
  if (coordsDisplay) coordsDisplay.textContent = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
  if (targetTypeInput) targetTypeInput.value = currentCaptureMode;
  
  const modal = document.getElementById('capture-modal');
  const nameInput = document.getElementById('modal-name');
  if (nameInput) nameInput.value = '';

  const modalTitle = document.getElementById('modal-title');
  if (currentCaptureMode === 'client') {
    if (modalTitle) modalTitle.textContent = 'Registrar Mi Estanco';
    if (clientEstanco && nameInput) nameInput.value = clientEstanco.name;
  } else {
    if (modalTitle) modalTitle.textContent = 'Registrar Competidor';
  }
  
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    setTimeout(() => { 
      if (modal.firstElementChild) {
        modal.firstElementChild.classList.remove('scale-95'); 
        modal.firstElementChild.classList.add('scale-100'); 
      }
      if (nameInput) nameInput.focus(); 
    }, 50);
  }
}

function showClosestEstancosPopup(lat, lon) {
  if (!map) return;
  
  // Custom pulsing divIcon for query point
  const queryIcon = L.divIcon({
    html: `
      <div class="relative w-8 h-8 flex items-center justify-center">
        <span class="absolute inline-flex h-full w-full rounded-full bg-sky-400 opacity-30 animate-ping"></span>
        <div class="w-3.5 h-3.5 bg-sky-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
          <div class="w-1 h-1 bg-white rounded-full"></div>
        </div>
      </div>
    `,
    className: 'custom-query-marker',
    iconSize: [32, 32],
    iconAnchor: [16, 16]
  });
  
  if (queryMarker) {
    queryMarker.setLatLng([lat, lon]);
  } else {
    queryMarker = L.marker([lat, lon], { icon: queryIcon, zIndexOffset: 200 }).addTo(map);
  }
  
  const allEstancos = [];
  if (clientEstanco) {
    allEstancos.push({
      name: clientEstanco.name,
      lat: clientEstanco.lat,
      lon: clientEstanco.lon,
      isClient: true
    });
  }
  
  competitorEstancos.forEach(comp => {
    allEstancos.push({
      name: comp.name,
      lat: comp.lat,
      lon: comp.lon,
      isClient: false
    });
  });
  
  if (allEstancos.length === 0) {
    const popup = L.popup({ className: 'custom-query-popup' })
      .setLatLng([lat, lon])
      .setContent('<div class="p-1.5 text-xs text-zinc-400 text-center">No hay estancos registrados en el mapa.</div>')
      .openOn(map);
      
    popup.on('remove', () => {
      if (queryMarker) {
        map.removeLayer(queryMarker);
        queryMarker = null;
      }
    });
    return;
  }
  
  // Calculate distance
  allEstancos.forEach(est => {
    est.distance = calcularDistanciaHaversine(lat, lon, est.lat, est.lon);
  });
  
  // Sort by distance ascending
  allEstancos.sort((a, b) => a.distance - b.distance);
  
  // Get top 4
  const closest = allEstancos.slice(0, 4);
  
  let html = `
    <div class="p-1 space-y-2 text-xs" style="min-width: 210px;">
      <div class="font-bold text-zinc-200 border-b border-zinc-800 pb-1.5 mb-1.5 flex items-center gap-1.5">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="text-sky-400"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
        <span>Estancos más cercanos (Top 4)</span>
      </div>
      <div class="space-y-1.5">
  `;
  
  closest.forEach((est, idx) => {
    const distText = formatDistance(est.distance);
    const badgeColor = est.isClient ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-rose-500/10 text-rose-400 border-rose-500/20';
    const labelSuffix = est.isClient ? ' (Mío)' : '';
    
    html += `
      <div class="flex justify-between items-center gap-3">
        <span class="truncate font-medium text-zinc-300 flex items-center" title="${est.name}${labelSuffix}">
          <span class="inline-block w-1.5 h-1.5 rounded-full ${est.isClient ? 'bg-emerald-400' : 'bg-rose-500'} mr-1.5 shrink-0"></span>
          <span class="truncate">${est.name}${labelSuffix}</span>
        </span>
        <span class="font-mono text-[10px] px-1.5 py-0.5 rounded border ${badgeColor} shrink-0">${distText}</span>
      </div>
    `;
  });
  
  html += `
      </div>
    </div>
  `;
  
  const popup = L.popup({ className: 'custom-query-popup', offset: [0, -5] })
    .setLatLng([lat, lon])
    .setContent(html)
    .openOn(map);
    
  popup.on('remove', () => {
    if (queryMarker) {
      map.removeLayer(queryMarker);
      queryMarker = null;
    }
  });
}


function closeModal() {
  const modal = document.getElementById('capture-modal');
  if (modal) {
    if (modal.firstElementChild) {
      modal.firstElementChild.classList.remove('scale-100');
      modal.firstElementChild.classList.add('scale-95');
    }
    setTimeout(() => { modal.classList.add('hidden'); modal.classList.remove('flex'); }, 150);
  }
}

function updateClientUIState(hasClient) {
  const savedState = document.getElementById('client-saved-state');
  const formState = document.getElementById('client-form');
  
  if (hasClient && clientEstanco) {
    if (savedState) savedState.classList.remove('hidden');
    if (formState) formState.classList.add('hidden');
    const savedName = document.getElementById('client-saved-name');
    const savedCoords = document.getElementById('client-saved-coords');
    if (savedName) savedName.textContent = clientEstanco.name;
    if (savedCoords) savedCoords.textContent = `${clientEstanco.lat.toFixed(5)}, ${clientEstanco.lon.toFixed(5)}`;
  } else {
    if (savedState) savedState.classList.add('hidden');
    if (formState) formState.classList.remove('hidden');
  }
}

window.deleteClient = async function() {
  if (confirm("¿Estás seguro de que deseas eliminar tu estanco?")) {
    await db.client.delete('main');
    await loadDatabaseCache();
  }
};

window.deleteCompetitor = async function(id) {
  if (confirm("¿Estás seguro de que deseas eliminar este competidor?")) {
    await db.competitors.delete(id);
    await loadDatabaseCache();
  }
};

window.makeMainEstanco = async function(id) {
  const competitor = competitorEstancos.find(c => c.id === id);
  if (!competitor) return;
  
  if (confirm(`¿Deseas establecer "${competitor.name}" como tu estanco principal?`)) {
    const oldMain = clientEstanco;
    
    // Add old main as a competitor if it exists
    if (oldMain) {
      await db.competitors.add({
        name: oldMain.name,
        lat: oldMain.lat,
        lon: oldMain.lon
      });
    }
    
    // Save new main
    await db.client.put({
      id: 'main',
      name: competitor.name,
      lat: competitor.lat,
      lon: competitor.lon
    });
    
    // Delete promoted competitor from the list
    await db.competitors.delete(id);
    
    await loadDatabaseCache();
  }
};

function initUIHandlers() {
  const btnModeClient = document.getElementById('btn-mode-client');
  const btnModeCompetitor = document.getElementById('btn-mode-competitor');
  const btnModeQuery = document.getElementById('btn-mode-query');
  const captureBannerText = document.getElementById('capture-banner-text');
  const captureBanner = document.getElementById('capture-banner');

  function updateModeUI() {
    if (!btnModeClient || !btnModeCompetitor || !btnModeQuery) return;
    
    // Reset all buttons to default state
    btnModeClient.className = 'flex flex-col items-center justify-center py-2 px-0.5 rounded-lg text-[10px] font-semibold transition-all duration-300 text-zinc-400 border border-transparent hover:text-zinc-200';
    btnModeCompetitor.className = 'flex flex-col items-center justify-center py-2 px-0.5 rounded-lg text-[10px] font-semibold transition-all duration-300 text-zinc-400 border border-transparent hover:text-zinc-200';
    btnModeQuery.className = 'flex flex-col items-center justify-center py-2 px-0.5 rounded-lg text-[10px] font-semibold transition-all duration-300 text-zinc-400 border border-transparent hover:text-zinc-200';
    
    if (currentCaptureMode === 'client') {
      btnModeClient.className = 'flex flex-col items-center justify-center py-2 px-0.5 rounded-lg text-[10px] font-semibold transition-all duration-300 bg-emerald-500/10 border border-emerald-500/40 text-emerald-400 shadow-sm shadow-emerald-500/5';
      if (captureBannerText) captureBannerText.textContent = 'Capturando posición de: Mi Estanco (Estrella)';
      if (captureBanner) {
        captureBanner.className = 'absolute top-4 left-1/2 transform -translate-x-1/2 z-20 pointer-events-none flex items-center gap-2 bg-zinc-900/90 border border-emerald-500/30 text-emerald-400 px-4 py-2 rounded-full shadow-lg backdrop-blur-md text-xs font-semibold transition-all duration-300 opacity-100 scale-100';
        const indicator = captureBanner.querySelector('span:first-child');
        if (indicator) {
          indicator.className = 'inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-ping';
        }
      }
    } else if (currentCaptureMode === 'competitor') {
      btnModeCompetitor.className = 'flex flex-col items-center justify-center py-2 px-0.5 rounded-lg text-[10px] font-semibold transition-all duration-300 bg-rose-500/10 border border-rose-500/40 text-rose-400 shadow-sm shadow-rose-500/5';
      if (captureBannerText) captureBannerText.textContent = 'Capturando posición de: Competidor (Punto Rojo)';
      if (captureBanner) {
        captureBanner.className = 'absolute top-4 left-1/2 transform -translate-x-1/2 z-20 pointer-events-none flex items-center gap-2 bg-zinc-900/90 border border-rose-500/30 text-rose-400 px-4 py-2 rounded-full shadow-lg backdrop-blur-md text-xs font-semibold transition-all duration-300 opacity-100 scale-100';
        const indicator = captureBanner.querySelector('span:first-child');
        if (indicator) {
          indicator.className = 'inline-block w-2.5 h-2.5 rounded-full bg-rose-400 animate-ping';
        }
      }
    } else if (currentCaptureMode === 'query') {
      btnModeQuery.className = 'flex flex-col items-center justify-center py-2 px-0.5 rounded-lg text-[10px] font-semibold transition-all duration-300 bg-sky-500/10 border border-sky-500/40 text-sky-400 shadow-sm shadow-sky-500/5';
      if (captureBannerText) captureBannerText.textContent = 'Consulta: Clic en el mapa para ver los 4 estancos más cercanos';
      if (captureBanner) {
        captureBanner.className = 'absolute top-4 left-1/2 transform -translate-x-1/2 z-20 pointer-events-none flex items-center gap-2 bg-zinc-900/90 border border-sky-500/30 text-sky-400 px-4 py-2 rounded-full shadow-lg backdrop-blur-md text-xs font-semibold transition-all duration-300 opacity-100 scale-100';
        const indicator = captureBanner.querySelector('span:first-child');
        if (indicator) {
          indicator.className = 'inline-block w-2.5 h-2.5 rounded-full bg-sky-400 animate-ping';
        }
      }
    }
  }

  if (btnModeClient) btnModeClient.addEventListener('click', () => { currentCaptureMode = 'client'; updateModeUI(); });
  if (btnModeCompetitor) btnModeCompetitor.addEventListener('click', () => { currentCaptureMode = 'competitor'; updateModeUI(); });
  if (btnModeQuery) btnModeQuery.addEventListener('click', () => { currentCaptureMode = 'query'; updateModeUI(); });

  const clientForm = document.getElementById('client-form');
  if (clientForm) {
    clientForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const lat = parseFloat(document.getElementById('client-lat').value);
      const lon = parseFloat(document.getElementById('client-lon').value);
      const name = document.getElementById('client-name').value;
      
      if (isNaN(lat) || isNaN(lon)) return;
      
      await db.client.put({ id: 'main', name, lat, lon });
      await loadDatabaseCache();
      if (map) map.setView([lat, lon], 16);
    });
  }

  const competitorManualForm = document.getElementById('competitor-manual-form');
  if (competitorManualForm) {
    competitorManualForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('competitor-manual-name').value;
      const lat = parseFloat(document.getElementById('competitor-manual-lat').value);
      const lon = parseFloat(document.getElementById('competitor-manual-lon').value);
      
      if (isNaN(lat) || isNaN(lon)) return;
      
      await db.competitors.add({ name, lat, lon });
      await loadDatabaseCache();
      
      // Reset form fields
      document.getElementById('competitor-manual-name').value = '';
      document.getElementById('competitor-manual-lat').value = '';
      document.getElementById('competitor-manual-lon').value = '';
      
      if (map) map.setView([lat, lon], 16);
    });
  }

  const modalForm = document.getElementById('modal-form');
  if (modalForm) {
    modalForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const type = document.getElementById('modal-target-type').value;
      const lat = parseFloat(document.getElementById('modal-lat').value);
      const lon = parseFloat(document.getElementById('modal-lon').value);
      const name = document.getElementById('modal-name').value || (type === 'client' ? 'Mi Estanco' : 'Competidor');
      
      if (type === 'client') {
        await db.client.put({ id: 'main', name, lat, lon });
      } else {
        await db.competitors.add({ name, lat, lon });
      }
      
      await loadDatabaseCache();
      closeModal();
    });
  }

  const btnCloseModal = document.getElementById('btn-close-modal');
  if (btnCloseModal) btnCloseModal.addEventListener('click', closeModal);

  const btnDeleteClient = document.getElementById('btn-delete-client');
  if (btnDeleteClient) btnDeleteClient.addEventListener('click', window.deleteClient);
  
  const clearBtn = document.getElementById('btn-clear-all-competitors');
  if (clearBtn) clearBtn.addEventListener('click', async () => {
    if (confirm("¿Borrar todos los competidores?")) {
      await db.competitors.clear();
      await loadDatabaseCache();
    }
  });

  const btnEditClient = document.getElementById('btn-edit-client');
  if (btnEditClient) {
    btnEditClient.addEventListener('click', () => {
      const savedState = document.getElementById('client-saved-state');
      const formState = document.getElementById('client-form');
      if (savedState) savedState.classList.add('hidden');
      if (formState) {
        formState.classList.remove('hidden');
        if (clientEstanco) {
          const clientNameInput = document.getElementById('client-name');
          const clientLatInput = document.getElementById('client-lat');
          const clientLonInput = document.getElementById('client-lon');
          if (clientNameInput) clientNameInput.value = clientEstanco.name;
          if (clientLatInput) clientLatInput.value = clientEstanco.lat;
          if (clientLonInput) clientLonInput.value = clientEstanco.lon;
        }
      }
    });
  }

  const toggleBtn = document.getElementById('toggle-sidebar-mobile');
  const closeBtn = document.getElementById('close-sidebar-mobile');
  const floatBtn = document.getElementById('floating-sidebar-mobile');
  const sidebar = document.getElementById('sidebar');

  function toggleSidebar() {
    if (!sidebar) return;
    const isClosed = sidebar.classList.contains('-translate-x-full');
    if (isClosed) {
      sidebar.classList.remove('-translate-x-full');
      if (floatBtn) floatBtn.classList.add('hidden');
    } else {
      sidebar.classList.add('-translate-x-full');
      setTimeout(() => { if (floatBtn) floatBtn.classList.remove('hidden'); }, 300);
    }
  }

  if (toggleBtn) toggleBtn.addEventListener('click', toggleSidebar);
  if (closeBtn) closeBtn.addEventListener('click', toggleSidebar);
  if (floatBtn) floatBtn.addEventListener('click', toggleSidebar);

  // Backup Import/Export JSON Actions
  const btnExportJson = document.getElementById('btn-export-json');
  if (btnExportJson) btnExportJson.addEventListener('click', exportDataToJSON);

  const importJsonFile = document.getElementById('import-json-file');
  if (importJsonFile) importJsonFile.addEventListener('change', importDataFromJSON);

  const btnRestoreBase = document.getElementById('btn-restore-base');
  if (btnRestoreBase) btnRestoreBase.addEventListener('click', restoreBaseData);
}

// Export active data to JSON backup file
async function exportDataToJSON() {
  try {
    const client = await db.client.get('main');
    const competitors = await db.competitors.toArray();
    
    const dataStr = JSON.stringify({ client, competitors }, null, 2);
    const blob = new Blob([dataStr], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const exportFileDefaultName = `estancos_backup_${new Date().toISOString().slice(0,10)}.json`;
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', url);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    
    setTimeout(() => URL.revokeObjectURL(url), 100);
  } catch (error) {
    alert("Error al exportar los datos: " + error.message);
  }
}

// Import data from JSON backup file, overwriting database state
async function importDataFromJSON(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      
      if (confirm("Al importar, se sobrescribirán los datos actuales. ¿Deseas continuar?")) {
        await db.client.delete('main');
        await db.competitors.clear();
        
        if (data.client) {
          await db.client.put({ id: 'main', name: data.client.name, lat: data.client.lat, lon: data.client.lon });
        }
        
        if (data.competitors && Array.isArray(data.competitors)) {
          for (const comp of data.competitors) {
            await db.competitors.add({ name: comp.name, lat: comp.lat, lon: comp.lon });
          }
        }
        
        alert("Datos importados con éxito.");
        await loadDatabaseCache();
        
        if (clientEstanco && map) {
          map.setView([clientEstanco.lat, clientEstanco.lon], 14);
        }
      }
    } catch (error) {
      alert("Error al leer el archivo JSON: " + error.message);
    }
    event.target.value = '';
  };
  reader.readAsText(file);
}

// Restore base estancos (Salamanca) from backup file
async function restoreBaseData() {
  if (confirm("¿Estás seguro de que deseas restaurar los estancos base de Salamanca a su posición original? Esto reemplazará las ubicaciones actuales.")) {
    try {
      await db.client.delete('main');
      await db.competitors.clear();
      
      const response = await fetch('ESTANCOS/estancos_backup_2026-07-16.json');
      if (response.ok) {
        const data = await response.json();
        if (data.client) {
          await db.client.put({ id: 'main', name: data.client.name, lat: data.client.lat, lon: data.client.lon });
        }
        if (data.competitors && Array.isArray(data.competitors)) {
          for (const comp of data.competitors) {
            await db.competitors.add({ name: comp.name, lat: comp.lat, lon: comp.lon });
          }
        }
        alert("Estancos base restaurados con éxito.");
        await loadDatabaseCache();
        if (clientEstanco && map) {
          map.setView([clientEstanco.lat, clientEstanco.lon], 14);
        }
        if (typeof lucide !== 'undefined') lucide.createIcons();
      } else {
        alert("Error: no se pudo cargar el archivo base de Salamanca.");
      }
    } catch (error) {
      alert("Error al restaurar estancos base: " + error.message);
    }
  }
}

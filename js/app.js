/**
 * app.js — Bullinger Correspondence Network visualisation
 *
 * Views:   Letters (sigma force graph) | Persons (sigma) | Map (leaflet)
 * Filters: windowed timeline, topic, church father, score threshold, ego network
 * Data:    all loaded from /data/** JSON files, lazy where possible
 */

// ── State ─────────────────────────────────────────────────────────────────────


const STATE = {
  view:            "letters",   // "letters" | "persons" | "map"
  windowDays:      180,
  sliderPos:       50,         // 0-100 position on timeline
  activeTopics:    new Set(),   // topic IDs that are ON
  cfFilter:        "",          // CF id or ""
  threshold:       0.5,
  egoNode:         null,        // node id or null
  egoKind:         null,        // "letter" or "person"
  playing:         false,
  showTopicColors: true,        // toggle: color nodes by dominant topic
  showCFEdges:     false,       // toggle: draw edges between letters sharing a CF
  referenceK:       5,           // number of reference items to show in letter detail
  _lastLetterDetail: null,        // for caching last shown letter in detail view
  selectedLetter: null,   // letter id currently shown in detail
};

// ── Raw data ──────────────────────────────────────────────────────────────────

const DETAIL_BASE_URL = "https://huggingface.co/datasets/len-rtz/bullinger-topic-citations/resolve/main";

const DATA = {
  letters:      [],   // letters_index.json
  persons:      {},   // persons_index.json keyed by id
  places:       {},   // places_index.json keyed by id
  personEdges:  [],   // person_edges.json
  locationArcs: [],   // location_arcs.json
  topicsMeta:   [],   // topics_meta.json .topics array
  pscIndex:     {},   // psc_index.json .fathers keyed by cf_id
  minDate:      null, // Date
  maxDate:      null, // Date
};

// ── Sigma instances ────────────────────────────────────────────────────────────

let sigmaInstance = null;
let leafletMap    = null;
let playTimer     = null;
let currentGraph = null;

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(renderCurrentView, 50);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function parseDate(str) {
  if (!str) return null;
  return new Date(str);
}

function fmtDate(d) {
  if (!d) return "?";
  return d.toISOString().slice(0, 10);
}

function setStatus(msg) {
  document.getElementById("status").textContent = msg;
}

function setLoading(on) {
  document.getElementById("loading").style.display = on ? "flex" : "none";
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function fetchJSON(path) {
  const r = await fetch(path + "?v=" + Date.now());
  if (!r.ok) throw new Error(`Failed to load ${path}: ${r.status}`);
  return r.json();
}

async function loadCoreData() {
  setStatus("loading…");
  const [letters, personsArr, placesArr, personEdges, locationArcs, topicsFile, pscFile] =
    await Promise.all([
      fetchJSON("data/graph/letters_index.json"),
      fetchJSON("data/graph/persons_index.json"),
      fetchJSON("data/graph/places_index.json"),
      fetchJSON("data/graph/person_edges.json"),
      fetchJSON("data/graph/location_arcs.json"),
      fetchJSON("data/topics/topics_meta.json"),
      fetchJSON("data/graph/psc_index.json"),
    ]);

  DATA.letters      = letters;
  DATA.personEdges  = personEdges;
  DATA.locationArcs = locationArcs;
  DATA.topicsMeta   = topicsFile.topics || [];

  personsArr.forEach(p => DATA.persons[p.id] = p);
  placesArr.forEach(p  => DATA.places[p.id]  = p);
  (pscFile.fathers || []).forEach(f => DATA.pscIndex[f.id] = f);

  // Compute date range across all letters with a valid date
  const dates = DATA.letters.map(l => parseDate(l.date)).filter(Boolean);
  DATA.minDate = new Date(Math.min(...dates));
  DATA.maxDate = new Date(Math.max(...dates));

  // Initialise active topics to all
  DATA.topicsMeta.forEach(t => STATE.activeTopics.add(t.id));

  setStatus(`${DATA.letters.length} letters loaded (as of 05/2026)`);
}

// ── Timeline helpers ──────────────────────────────────────────────────────────

function sliderToWindowEnd() {
  if (!DATA.minDate || !DATA.maxDate) return null;
  const span = DATA.maxDate - DATA.minDate;
  const pos  = STATE.sliderPos / 100;
  return new Date(DATA.minDate.getTime() + span * pos);
}

function windowRange() {
  const end   = sliderToWindowEnd();
  if (!end) return [null, null];
  const start = new Date(end.getTime() - STATE.windowDays * 86400000);
  return [start, end];
}

function letterInWindow(letter) {
  const d = parseDate(letter.date);
  if (!d) return false;
  const [start, end] = windowRange();
  if (!start) return true;
  return d >= start && d <= end;
}

function updateTimelineLabel() {
  const [start, end] = windowRange();
  if (!start) { document.getElementById("timeline-label").textContent = "—"; return; }
  document.getElementById("timeline-label").textContent =
    `${fmtDate(start)} → ${fmtDate(end)}`;
}

// ── Filter: which letters are visible ─────────────────────────────────────────

function visibleLetters() {
  return DATA.letters.filter(l => {
    if (!letterInWindow(l)) return false;
    if (STATE.activeTopics.size < DATA.topicsMeta.length) {
      if (!STATE.activeTopics.has(l.dominant_topic)) return false;
    }
    if (STATE.cfFilter) {
      const hasCF = (l.top_citations || []).some(
        c => c.cf_id === STATE.cfFilter && c.ce_score >= STATE.threshold
      );
      if (!hasCF) return false;
    }
    // Cross-view: person ego filters letters to that person's correspondence
    if (STATE.egoNode && STATE.egoKind === "person") {
      const involves = l.sender_id === STATE.egoNode ||
        (l.recipient_ids || []).includes(STATE.egoNode);
      if (!involves) return false;
    }
    // Cross-view: letter ego in map/person view — keep only that letter
    if (STATE.egoNode && STATE.egoKind === "letter" && STATE.view !== "letters") {
      if (l.id !== STATE.egoNode) return false;
    }
    return true;
  });
}

// ── Graph layout helpers ───────────────────────────────────────────────────────

// Deterministic hash so the same letter always seeds to the same position
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h;
}

function layoutLetters(letters) {
  const positions = {};
  const R = 300;
  letters.forEach(l => {
    const h1 = hashStr(String(l.id));
    const h2 = hashStr(String(l.id) + "y");
    const angle = (h1 / 0xFFFFFFFF) * 2 * Math.PI;
    const r     = R * (0.3 + 0.7 * (h2 / 0xFFFFFFFF));
    positions[l.id] = {
      x: r * Math.cos(angle),
      y: r * Math.sin(angle),
    };
  });
  return positions;
}

function applyForceAtlas2(graph, iterations) {
  const fa2 = window.forceAtlas2
    || window.layoutForceAtlas2
    || (window.graphologyLibrary && window.graphologyLibrary.layoutForceAtlas2);
  if (!fa2) { console.warn("[FA2] not found on window"); return; }
  fa2.assign(graph, {
    iterations,
    settings: {
      gravity:           1,
      scalingRatio:      graph.order < 100 ? 8 : 4,
      strongGravityMode: true,
      barnesHutOptimize: graph.order > 300,
      adjustSizes:       false,
      slowDown:          3,
    },
  });
}

// Aggregate topic_dist across a list of letters → dominant topic id
function aggregateDominantTopic(letters) {
  const K = DATA.topicsMeta.length;
  if (K === 0) return null;
  const sums = new Float32Array(K);
  let hasAny = false;
  letters.forEach(l => {
    const dist = l.topic_dist;
    if (dist && dist.length === K) {
      for (let i = 0; i < K; i++) sums[i] += dist[i];
      hasAny = true;
    }
  });
  if (!hasAny) {
    const counts = {};
    letters.forEach(l => {
      if (l.dominant_topic != null)
        counts[l.dominant_topic] = (counts[l.dominant_topic] || 0) + 1;
    });
    const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return best ? parseInt(best[0]) : null;
  }
  let best = 0;
  for (let i = 1; i < K; i++) if (sums[i] > sums[best]) best = i;
  return best;
}

let cachedPersonPositions = null;

function layoutPersons() {
  if (cachedPersonPositions) return cachedPersonPositions;

  const persons = Object.values(DATA.persons).filter(p => p.letter_count > 0);
  const positions = {};
  const BULLINGER = "p495";
  const others = persons.filter(p => p.id !== BULLINGER);
  const R = 400;

  positions[BULLINGER] = { x: 0, y: 0 };
  others.forEach((p, i) => {
    const angle = (i / others.length) * 2 * Math.PI;
    positions[p.id] = {
      x: R * Math.cos(angle),
      y: R * Math.sin(angle),
    };
  });

  cachedPersonPositions = positions;
  return positions;
}

function topicColor(topicId) {
  const t = DATA.topicsMeta.find(t => t.id === topicId);
  return t ? t.color : "#aaa";
}

// ── Sigma: Letters view ────────────────────────────────────────────────────────

function buildLetterGraph() {
  const letters = visibleLetters();
  const letterSet = new Set(letters.map(l => l.id));

  // Build letter graph
  const graph = new graphology.Graph({ multi: false, type: "undirected" });

  const positions = layoutLetters(letters);
  letters.forEach(l => {
    const sender = (DATA.persons[l.sender_id] && DATA.persons[l.sender_id].name) || l.sender_id || "?";
    const nodeColor = STATE.showTopicColors ? topicColor(l.dominant_topic) : "#888";
    graph.addNode(l.id, {
      label:  `${l.id} — ${sender}`,
      x:      positions[l.id]?.x ?? 0,
      y:      positions[l.id]?.y ?? 0,
      size:   4,
      color:  nodeColor,
      type:   "circle",
      _data:  l,
      _kind:  "letter",
    });
  });

  // Epistolary edges — only between visible letters
  // two letters are connected if same non-Bullinger person AND within 60 days
  const BULLINGER = "p495";
  const byPerson = {};
  letters.forEach(l => {
    [...(l.recipient_ids || []), l.sender_id].forEach(pid => {
      if (!pid || pid === BULLINGER) return;
      if (!byPerson[pid]) byPerson[pid] = [];
      byPerson[pid].push(l);
    });
  });

  Object.values(byPerson).forEach(group => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i], b = group[j];
        const da = parseDate(a.date), db = parseDate(b.date);
        if (da && db && Math.abs(da - db) <= 60 * 86400000) {
          const eid = `${a.id}-${b.id}`;
          if (!graph.hasEdge(a.id, b.id)) {
            graph.addEdge(a.id, b.id, { size: 0.5, color: "#ccc" });
          }
        }
      }
    }
  });

  // Shared church father citation edges (orange)
  // Two letters share an edge if they both cite the same CF work above threshold
  if (STATE.showCFEdges) {
    const lettersByCF = {};
    letters.forEach(l => {
      (l.top_citations || []).forEach(c => {
        if (c.ce_score < STATE.threshold) return;
        const key = c.cf_id + "|" + (c.work_id || "");
        if (!lettersByCF[key]) lettersByCF[key] = [];
        lettersByCF[key].push(l.id);
      });
    });
    Object.values(lettersByCF).forEach(group => {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i], b = group[j];
          if (graph.hasNode(a) && graph.hasNode(b) && !graph.hasEdge(a, b)) {
            graph.addEdge(a, b, { size: 1, color: "#e67e22"});
          }
        }
      }
    });
  }

  return graph;
}

// ── Sigma: Persons view ────────────────────────────────────────────────────────

function buildPersonGraph() {
  const graph = new graphology.Graph({ multi: false, type: "directed" });

  // Only persons active in the current window
  const activePersons = new Set();
  DATA.letters.filter(l => letterInWindow(l)).forEach(l => {
    if (l.sender_id) activePersons.add(l.sender_id);
    (l.recipient_ids || []).forEach(r => activePersons.add(r));
  });

  // Bullinger in centre
  const BULLINGER = "p495";
  const others = [...activePersons].filter(id => id !== BULLINGER);
  const R = 400;

  const positions = {};
  if (activePersons.has(BULLINGER)) {
    positions[BULLINGER] = { x: 0, y: 0 };
  }
  others.forEach((id, i) => {
    const angle = (i / others.length) * 2 * Math.PI;
    positions[id] = {
      x: R * Math.cos(angle),
      y: R * Math.sin(angle),
    };
  });

  activePersons.forEach(pid => {
    const p = DATA.persons[pid];
    if (!p) return;
    const isBullinger = pid === BULLINGER;

    let nodeColor = "#888";
    if (!isBullinger && STATE.showTopicColors) {
      const personLetters = DATA.letters.filter(l =>
        letterInWindow(l) &&
        (l.sender_id === pid || (l.recipient_ids || []).includes(pid))
      );
      const tid = aggregateDominantTopic(personLetters);
      if (tid != null) nodeColor = topicColor(tid);
    }
    if (isBullinger) nodeColor = "#000";

    graph.addNode(pid, {
      label:  p.name,
      x:      positions[pid]?.x ?? 0,
      y:      positions[pid]?.y ?? 0,
      size:   isBullinger ? 20 : Math.max(4, Math.min(16, Math.sqrt(p.letter_count) * 1.2)),
      color:  nodeColor,
      type:   "circle",
      _data:  p,
      _kind:  "person",
    });
  });

  // only edges for current time window
// Build edges only from letters in the current window
  const windowLetterPairs = new Map(); // "src|tgt" → weight

  DATA.letters.filter(l => letterInWindow(l)).forEach(l => {
    if (!l.sender_id) return;
    (l.recipient_ids || []).forEach(rid => {
      if (!rid || rid === l.sender_id) return;
      const key = l.sender_id + "|" + rid;
      windowLetterPairs.set(key, (windowLetterPairs.get(key) || 0) + 1);
    });
  });

  windowLetterPairs.forEach((weight, key) => {
    const [src, tgt] = key.split("|");
    if (!graph.hasNode(src) || !graph.hasNode(tgt)) return;
    graph.addEdge(src, tgt, {
      size:   Math.max(0.5, Math.log(weight) * 0.5),
      color:  "#bbb",
      weight: weight,
    });
  });

  return graph;
}

// ── Ego filter ────────────────────────────────────────────────────────────────

function applyEgoFilter(graph) {
  if (!STATE.egoNode) return;
  // Only apply if ego kind matches current view
  if (STATE.egoKind === "person" && STATE.view !== "persons") return;
  if (STATE.egoKind === "letter" && STATE.view !== "letters") return;
  if (!graph.hasNode(STATE.egoNode)) return;

  const neighbours = new Set([STATE.egoNode]);
  graph.neighbors(STATE.egoNode).forEach(n => neighbours.add(n));
  const toRemove = [];
  graph.forEachNode(n => { if (!neighbours.has(n)) toRemove.push(n); });
  toRemove.forEach(n => graph.dropNode(n));
}

// ── Sigma rendering ────────────────────────────────────────────────────────────

function renderSigma(graph) {
  if (sigmaInstance) {
    sigmaInstance.kill();
    sigmaInstance = null;
  }

  const container = document.getElementById("sigma-container");
  currentGraph = graph;

  // Track hover state
  let hoveredNode = null;
  let hoveredNeighbours = null;

  sigmaInstance = new Sigma(graph, container, {
    renderEdgeLabels: false,
    defaultEdgeColor: "#ccc",
    defaultNodeColor: "#555",
    minCameraRatio:   0.05,
    maxCameraRatio:   10,

    // Node reducer — dim nodes that aren't hovered or neighbours
    nodeReducer(node, data) {
      // Highlight currently selected letter
      if (node === STATE.selectedLetter) {
        return { ...data, color: "#000", size: data.size * 2.5, zIndex: 2 };
      }
      if (!hoveredNode) return data;
      if (node === hoveredNode) {
        return { ...data, highlighted: true, zIndex: 1 };
      }
      // dim evreything that's not the hovered node or its neighbours
      if (hoveredNeighbours && hoveredNeighbours.has(node)) {
        return { ...data, highlighted: true, zIndex: 1 };
      }
      return { ...data, color: "#e0e0e0", zIndex: 0, label: "" };
    },

    // Edge reducer — highlight edges connected to hovered node, dim rest
    edgeReducer(edge, data) {
      if (!hoveredNode) return data;
      if (graph.hasExtremity(edge, hoveredNode)) {
        return { ...data, color: "#000", size: 1.5, zIndex: 1 };
      }
      return { ...data, color: "#f0f0f0", size: 0.3, zIndex: 0 };
    },
  });

  // Hover handlers
  sigmaInstance.on("enterNode", ({ node }) => {
    hoveredNode       = node;
    hoveredNeighbours = new Set(graph.neighbors(node));
    sigmaInstance.refresh();
  });

  sigmaInstance.on("leaveNode", () => {
    hoveredNode       = null;
    hoveredNeighbours = null;
    sigmaInstance.refresh();
  });

  // Click handler
  sigmaInstance.on("clickNode", ({ node }) => {
  const attrs = graph.getNodeAttributes(node);
  if (attrs._kind === "letter") {
    showLetterDetail(attrs._data);
  } else if (attrs._kind === "person") {
    showPersonDetail(attrs._data);
  }

  if (STATE.egoNode === node) {
    clearEgo();
  } else {
    STATE.egoNode = node;
    STATE.egoKind = attrs._kind;
    document.getElementById("ego-clear").style.display = "inline";
    document.getElementById("ego-info").textContent =
      attrs.label ? attrs.label : "ego: " + node;
  }
  renderCurrentView();
});
}

function clearEgo() {
  STATE.egoNode = null;
  STATE.egoKind = null;
  document.getElementById("ego-clear").style.display = "none";
  document.getElementById("ego-info").textContent = "click a node to focus";
  document.getElementById("detail-content").innerHTML =
    "<div class='detail-placeholder'>Click a node to inspect.</div>";
}
window.clearEgo = clearEgo;

// ── Map view ──────────────────────────────────────────────────────────────────

function renderMap() {
  const container = document.getElementById("map-container");
  container.style.display = "block";
  document.getElementById("sigma-container").style.display = "none";

  if (!leafletMap) {
      leafletMap = L.map(container).setView([47.5, 10.0], 5);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 16,
      }).addTo(leafletMap);
    } else {
      leafletMap.invalidateSize();
    }

  // Clear existing layers (keep tile layer)
  leafletMap.eachLayer(layer => {
    if (!(layer instanceof L.TileLayer)) leafletMap.removeLayer(layer);
  });

  // Active letter set for filtering
  const activeLetterIds = new Set(visibleLetters().map(l => l.id));

  // Place circles — count active letters per place, aggregate topic
  const placeCounts  = {};
  const placeLetters = {};
  visibleLetters().forEach(l => {
    if (!l.place_id) return;
    placeCounts[l.place_id] = (placeCounts[l.place_id] || 0) + 1;
    if (!placeLetters[l.place_id]) placeLetters[l.place_id] = [];
    placeLetters[l.place_id].push(l);
  });

  Object.entries(placeCounts).forEach(([pid, count]) => {
      const place = DATA.places[pid];
      if (!place || !place.lat || !place.lon) return;
      const r = Math.max(5, Math.min(30, Math.sqrt(count) * 2.5));

      let fillColor = "#666";
      if (STATE.showTopicColors) {
        const tid = aggregateDominantTopic(placeLetters[pid] || []);
        if (tid != null) fillColor = topicColor(tid);
      }

      const circle = L.circleMarker([place.lat, place.lon], {
        radius:      r,
        color:       "#000",
        weight:      1,
        fillColor:   fillColor,
        fillOpacity: 0.7,
      }).addTo(leafletMap);

      circle.on("click", () => showPlaceDetail(pid, count));
      circle.bindTooltip(`${place.name} (${count} letters)`);
    });

  // Location arcs — sending place → receiving place, filtered to active letters
  DATA.locationArcs.forEach(arc => {
    const src = DATA.places[arc.source_place];
    const tgt = DATA.places[arc.target_place];
    if (!src?.lat || !tgt?.lat) return;

    // Count how many of this arc's letters are in the current window
    const activeCount = arc.letter_ids.filter(id => activeLetterIds.has(id)).length;
    if (activeCount === 0) return;

    const opacity = Math.min(0.8, 0.15 + activeCount / arc.weight * 0.65);
    L.polyline([[src.lat, src.lon], [tgt.lat, tgt.lon]], {
      color:   "#000",
      weight:  Math.max(1, Math.log(activeCount + 1)),
      opacity: opacity,
    }).bindTooltip(`${src.name} → ${tgt.name} (${activeCount})`).addTo(leafletMap);
  });
}

// Detail Location

function showPlaceDetail(placeId, count) {
  const place = DATA.places[placeId] || {};
  const panel = document.getElementById("detail-content");

  STATE._lastPlaceDetailId = placeId;
  const windowLetters = DATA.letters.filter(l =>
    letterInWindow(l) && l.place_id === placeId
  ).sort((a, b) => (a.date || "").localeCompare(b.date || ""));

  if (count === undefined) count = windowLetters.length;

  let html = `
    <div class="detail-meta">
      <div class="detail-row"><span class="dk">Place</span><span>${place.name || placeId}</span></div>
      <div class="detail-row"><span class="dk">Country</span><span>${place.country || "?"}</span></div>
      <div class="detail-row"><span class="dk">Letters</span><span>${count} in selected time</span></div>
    </div>
    <hr style="border:none;border-top:1px solid #eee;margin:4px 0">
    <strong style="font-size:11px">Letters sent from here (${windowLetters.length})</strong>
  `;

  windowLetters.forEach(l => {
    const sender    = (DATA.persons[l.sender_id] && DATA.persons[l.sender_id].name) || l.sender_id || "?";
    const recipId   = (l.recipient_ids || [])[0];
    const recipient = (DATA.persons[recipId] && DATA.persons[recipId].name) || recipId || "?";
    html += `<div style="font-size:10px;padding:2px 0;border-bottom:1px solid #f0f0f0;cursor:pointer"
                  onclick="selectLetterById('${l.id}')">
               <span style="color:#999">${l.date || "?"}</span>
               ${sender} → ${recipient}
               <a href="${l.bd_url}" target="_blank" style="color:#00f;margin-left:4px" onclick="event.stopPropagation()">↗</a>
             </div>`;
  });

  if (windowLetters.length === 0) {
    html += `<div class="detail-placeholder">no letters in current window</div>`;
  }

  panel.innerHTML = html;
}


// ── Detail panel: letter ──────────────────────────────────────────────────────

async function showLetterDetail(letter) {
  const panel = document.getElementById("detail-content");
  const person = DATA.persons[letter.sender_id] || {};
  const place  = DATA.places[letter.place_id]   || {};
  STATE._lastLetterDetail = letter;
  STATE.selectedLetter = letter.id;

  let html = `
    <div class="detail-meta">
      <div class="detail-row"><span class="dk">Letter</span><span>${letter.id}</span></div>
      <div class="detail-row"><span class="dk">Date</span><span>${letter.date || "?"}</span></div>
      <div class="detail-row"><span class="dk">Sender</span><span style="cursor:pointer;text-decoration:underline;text-underline-offset:2px" onclick="showPersonById('${letter.sender_id}')">${person.name || letter.sender_id || "?"}</span></div>
      <div class="detail-row"><span class="dk">Recipient</span><span>${(letter.recipient_ids || []).map(id => {
        const name = (DATA.persons[id] && DATA.persons[id].name) || id;
        return `<span style="cursor:pointer;text-decoration:underline;text-underline-offset:2px" onclick="showPersonById('${id}')">${name}</span>`;
      }).join(", ") || "?"}</span></div>
      </div>
    <a class="bd-link" href="${letter.bd_url}" target="_blank">→ open in Bullinger Digital</a>
    <hr style="border:none;border-top:1px solid #eee;margin:8px 0">
  `;

  // Try to load detail file lazily
  let detail = null;
  try {
    detail = await fetchJSON(`${DETAIL_BASE_URL}/${letter.id}.json`);
  } catch(e) {
    // no detail file yet — show placeholder
  }

  if (detail && detail.citations && detail.citations.length > 0) {
    const filtered = detail.citations.filter(c =>
      c.max_score >= STATE.threshold &&
      (!STATE.cfFilter || c.cf_id === STATE.cfFilter)
    );
    html += `<strong style="font-size:11px;display:block;margin-top:10px;margin-bottom:4px">Patristic candidates (score ≥ ${STATE.threshold.toFixed(2)})</strong>`;
    if (filtered.length === 0) {
      html += `<div class="detail-placeholder">none above threshold</div>`;
    } else {
      filtered.forEach((c, i) => {
  // Resolve from psc_index by work_id alone
  let father = null;
  let work   = null;
  for (const f of Object.values(DATA.pscIndex)) {
    const w = (f.works || []).find(w => w.work_id === c.work_id);
    if (w) { father = f; work = w; break; }
  }
  const cfName    = father ? father.name  : c.work_id;
  const workTitle = work   ? work.title   : c.work_id;
  const sourceUrl = work   ? work.source_url : null;
  const sourceLink = sourceUrl
    ? '<a href="' + sourceUrl + '" target="_blank" style="color:#00f;margin-left:4px">→ open source</a>'
    : "";

  const referenceId = "ev-" + letter.id + "-" + i;
  html += "<div class='citation-entry'>"
    + "<div><strong>" + cfName + "</strong></div>"
    + "<div style='font-size:10px;color:#555'>" + workTitle + " " + sourceLink + "</div>"
    + "<div class='citation-score'>max score: " + c.max_score.toFixed(3) + "</div>"
    + "<button class='reference-toggle' onclick=\"togglereference('" + referenceId + "')\">show text chunk</button>"
    + "<div class='reference-block' id='" + referenceId + "'>"
    + (c.evidence || []).slice(0, STATE.referenceK).map(function(ev) {
    return "<b>Letter:</b> " + ev.bdc_chunk_id + "\n" + ev.bdc_text
      + "\n\n<b>Source:</b> " + ev.psc_chunk_id + "\n" + ev.psc_text
      + "\n\nbi-encoder score: " + (ev.candidate_score != null ? ev.candidate_score.toFixed(3) : "—")
      + "\nce score: " + (ev.ce_score != null ? ev.ce_score.toFixed(3) : "not available");
  }).join("\n\n---\n")
    + "</div></div>";
});
    }
  } else if (!detail) {
    html += `<div class="detail-placeholder">detail file not yet generated</div>`;
  } else {
    html += `<div class="detail-placeholder">no citations detected</div>`;
  }

  // Topic distribution
  const topicDist = (detail && detail.topic_dist) || letter.topic_dist;
  if (topicDist && topicDist.length > 0) {
    html += `<hr style="border:none;border-top:1px solid #eee;margin:4px 0">`;
    html += `<strong style="font-size:11px">Topic distribution</strong>`;
    const dist = topicDist;
    const total = dist.reduce((a, b) => a + b, 0);
    dist
      .map((v, i) => ({ i, v, pct: total > 0 ? (v / total * 100) : 0 }))
      .sort((a, b) => b.pct - a.pct)
    .forEach(({ i, pct }) => {
      const label   = topicLabel(i);
      const color   = topicColor(i);
      const w       = pct.toFixed(1);
      const topic   = DATA.topicsMeta.find(t => t.id === i);
      const words   = topic ? topic.top_words.join(", ") : "";
      const wordId  = `tw-${letter.id}-${i}`;
      html += `<div style="font-size:10px;margin:4px 0">
                <div style="display:flex;justify-content:space-between;margin-bottom:2px">
                  <span style="cursor:pointer;text-decoration:underline;text-underline-offset:2px"
                        onclick="var el=document.getElementById('${wordId}');el.style.display=el.style.display==='block'?'none':'block'"
                  >${label}</span>
                  <span>${w}%</span>
                </div>
                <div id="${wordId}" style="display:none;color:#777;font-style:italic;margin-bottom:2px">${words}</div>
                <div style="background:#eee;height:4px;width:100%">
                  <div style="background:${color};height:4px;width:${w}%"></div>
                </div>
              </div>`;
    });
  }

  panel.innerHTML = html;
}

function showPersonById(id) {
  const person = DATA.persons[id];
  if (person) showPersonDetail(person);
}
window.showPersonById = showPersonById;

function topicLabel(id) {
  const t = DATA.topicsMeta.find(t => t.id === id);
  return t ? t.label : (id != null ? `Topic ${id}` : "—");
}

// ── Detail panel: person ──────────────────────────────────────────────────────

function showPersonDetail(person) {
  const panel = document.getElementById("detail-content");
  let html = "";
  if (person.portrait) {
    html += `<img class="person-portrait" src="${person.portrait}" onerror="this.style.display='none'" alt="${person.name}">`;
  }
  html += `
    <div class="detail-meta">
      <div class="detail-row"><span class="dk">Name</span><span>${person.name}</span></div>
      <div class="detail-row"><span class="dk">Total letters</span><span>${person.letter_count}</span></div>
    </div>`;
  if (person.wiki) html += `<a class="bd-link" href="${person.wiki}" target="_blank">→ Wikipedia</a>`;
  if (person.gnd)  html += `<br><a class="bd-link" href="${person.gnd}" target="_blank">→ GND / DNB</a>`;

  // Letters in current window involving this person — always recomputed live
  STATE._lastPersonDetail = person;
  const windowLetters = DATA.letters.filter(l =>
    letterInWindow(l) &&
    (l.sender_id === person.id || (l.recipient_ids || []).includes(person.id))
  );

  if (windowLetters.length > 0) {
    html += `<hr style="border:none;border-top:1px solid #eee;margin:4px 0">`;
    html += `<strong style="font-size:11px">Letters in selected time (${windowLetters.length})</strong>`;
    windowLetters
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""))
      .forEach(l => {
        const isSender = l.sender_id === person.id;
        const direction = isSender ? "→" : "←";
        const otherIds = isSender
          ? (l.recipient_ids || [])
          : [l.sender_id];
        const otherNames = otherIds
          .map(id => (DATA.persons[id] && DATA.persons[id].name) || id || "?")
          .join(", ");
        html += `<div style="font-size:10px;padding:2px 0;border-bottom:1px solid #f0f0f0;cursor:pointer"
                      onclick="selectLetterById('${l.id}')">
                  <span style="color:#999">${l.date || "?"}</span>
                  ${direction} ${otherNames}
                  <a href="${l.bd_url}" target="_blank" style="color:#00f;margin-left:4px" onclick="event.stopPropagation()">↗</a>
                </div>`;
      });
  } else {
    html += `<div class="detail-placeholder" style="margin-top:6px">no letters in current window</div>`;
  }

  panel.innerHTML = html;
}

function highlightLetterInGraph(letterId) {
  if (STATE.view !== "letters") {
    STATE.view = "letters";
    document.querySelectorAll(".view-btn").forEach(b => {
      b.classList.toggle("active", b.dataset.view === "letters");
    });
  }

  const letter = DATA.letters.find(l => l.id === letterId);
  if (!letter) return;

  if (letter.date && !letterInWindow(letter)) {
    const d = parseDate(letter.date);
    const span = DATA.maxDate - DATA.minDate;
    const pos = ((d - DATA.minDate) / span) * 100;
    STATE.sliderPos = Math.min(100, Math.max(0, pos));
    document.getElementById("timeline-slider").value = STATE.sliderPos;
    updateTimelineLabel();
  }

  STATE.egoNode = letterId;
  document.getElementById("ego-clear").style.display = "inline";
  document.getElementById("ego-info").textContent = "ego: " + letterId;
  renderCurrentView();
}
window.highlightLetterInGraph = highlightLetterInGraph;

function selectLetterById(id) {
  const letter = DATA.letters.find(l => l.id === id);
  if (letter) {
    selectLetter(letter);
  }
}
window.selectLetterById = selectLetterById;

function togglereference(id) {
  const el = document.getElementById(id);
  if (el) el.classList.toggle("open");
}
window.togglereference = togglereference; // expose for inline onclick

// ── Render dispatcher ─────────────────────────────────────────────────────────

function renderCurrentView() {
  if (STATE.view === "map") {
    document.getElementById("sigma-container").style.display = "none";
    document.getElementById("map-container").style.display  = "block";
    renderMap();
    if (STATE._lastPlaceDetailId) showPlaceDetail(STATE._lastPlaceDetailId);
    updateTimelineLabel();
    return;
  }

  document.getElementById("sigma-container").style.display = "block";
  document.getElementById("map-container").style.display   = "none";

  let graph;
  if (STATE.view === "letters") {
    graph = buildLetterGraph();
  } else {
    graph = buildPersonGraph();
    if (STATE._lastPersonDetail) showPersonDetail(STATE._lastPersonDetail);
  }

  if (STATE.egoNode) applyEgoFilter(graph);

  const n     = graph.order;
  const iters = n < 80 ? 400 : n < 200 ? 300 : 180;
  applyForceAtlas2(graph, iters);

  renderSigma(graph);
  updateTimelineLabel();
}

// ── UI wiring ─────────────────────────────────────────────────────────────────

function buildTopicFilters() {
  const container = document.getElementById("topic-filters");
  container.innerHTML = "";

  const themes = [
    { key: "confessional", label: "Confessional" },
    { key: "political",    label: "Political" },
    { key: "everyday",     label: "Everyday" },
    { key: "noise",        label: "Noise" },
  ];

  themes.forEach(theme => {
    const topicsInTheme = DATA.topicsMeta.filter(t => t.theme === theme.key);
    if (topicsInTheme.length === 0) return;

    // Category header
    const header = document.createElement("div");
    header.style.cssText = "font-size:10px;text-transform:uppercase;color:#999;margin-top:6px;margin-bottom:2px;letter-spacing:0.05em";
    header.textContent = theme.label;
    container.appendChild(header);

    topicsInTheme.forEach(t => {
      const row = document.createElement("div");
      row.className = "topic-row";
      row.innerHTML = `
        <div class="topic-swatch" style="background:${t.color}"></div>
        <input type="checkbox" id="tp${t.id}" ${STATE.activeTopics.has(t.id) ? "checked" : ""}>
        <label for="tp${t.id}">${t.label}</label>`;
      const cb = row.querySelector("input");
      cb.addEventListener("change", () => {
        if (cb.checked) STATE.activeTopics.add(t.id);
        else            STATE.activeTopics.delete(t.id);
        renderCurrentView();
      });
      container.appendChild(row);
    });
  });
}

function buildCFFilter() {
  const sel = document.getElementById("cf-select");
  Object.values(DATA.pscIndex).forEach(f => {
    const opt = document.createElement("option");
    opt.value       = f.id;
    opt.textContent = f.name;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => {
    STATE.cfFilter = sel.value;
    renderCurrentView();
    if (STATE._lastLetterDetail) showLetterDetail(STATE._lastLetterDetail);
  });
}

function wireControls() {
  // View buttons
  document.querySelectorAll(".view-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".view-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.view = btn.dataset.view;
      renderCurrentView();
    });
  });

  // Window presets
  document.querySelectorAll(".preset-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".preset-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.windowDays = parseInt(btn.dataset.days);
      renderCurrentView();
    });
  });

  // Timeline slider
  const slider = document.getElementById("timeline-slider");
  slider.addEventListener("input", () => {
    STATE.sliderPos = parseInt(slider.value);
    updateTimelineLabel();
    scheduleRender();
  });

    // reference presets
  document.querySelectorAll("#reference-presets .ev-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#reference-presets .ev-btn")
        .forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      STATE.referenceK = parseInt(btn.dataset.k);
      if (STATE._lastLetterDetail) showLetterDetail(STATE._lastLetterDetail);
    });
  });

  // Play button
  const playBtn = document.getElementById("play-btn");
  playBtn.addEventListener("click", () => {
    if (STATE.playing) {
      clearInterval(playTimer);
      STATE.playing = false;
      playBtn.textContent = "▶ Start";
    } else {
      STATE.playing = true;
      playBtn.textContent = "⏸ Pause";
      // Start from beginning if at end
      if (STATE.sliderPos >= 100) {
        STATE.sliderPos = 0;
        slider.value = 0;
      }
      playTimer = setInterval(() => {
        STATE.sliderPos = Math.min(100, STATE.sliderPos + 1);
        slider.value = STATE.sliderPos;
        updateTimelineLabel();
        scheduleRender();
        if (STATE.sliderPos >= 100) {
          clearInterval(playTimer);
          STATE.playing = false;
          playBtn.textContent = "▶ Start";
        }
      }, 800);
    }
  });

  // Threshold slider
  const thSlider = document.getElementById("threshold-slider");
  const thVal    = document.getElementById("threshold-val");
  thSlider.addEventListener("input", () => {
  STATE.threshold = parseFloat(thSlider.value);
  thVal.textContent = `≥ ${STATE.threshold.toFixed(2)}`;
  scheduleRender();
  if (STATE._lastLetterDetail) showLetterDetail(STATE._lastLetterDetail);
});

  // Topic color toggle
  document.getElementById("topic-color-btn").addEventListener("click", () => {
    STATE.showTopicColors = !STATE.showTopicColors;
    document.getElementById("topic-color-btn").classList.toggle("active", STATE.showTopicColors);
    document.getElementById("topic-color-btn").textContent =
      STATE.showTopicColors ? "topics: on" : "topics: off";
    scheduleRender();
  });

  // Shared CF edge toggle
  document.getElementById("cf-edge-btn").addEventListener("click", () => {
    STATE.showCFEdges = !STATE.showCFEdges;
    document.getElementById("cf-edge-btn").classList.toggle("active", STATE.showCFEdges);
    document.getElementById("cf-edge-btn").textContent =
      STATE.showCFEdges ? "shared citations: on" : "shared citations: off";
    renderCurrentView();  
  });

  // Ego clear
  document.getElementById("ego-clear").addEventListener("click", () => {
    clearEgo();
    renderCurrentView();
  });
}

// Search function
function wireSearch() {
  var input   = document.getElementById("search-input");
  var results = document.getElementById("search-results");
  if (!input || !results) { console.error("search elements not found"); return; }

  input.addEventListener("input", function() {
    var q = input.value.trim().toLowerCase();
    results.innerHTML = "";
    if (q.length < 2) { results.style.display = "none"; return; }

    var hits = [];

    DATA.letters.forEach(function(l) {
      if (String(l.id).startsWith(q)) {
        var sender = (DATA.persons[l.sender_id] && DATA.persons[l.sender_id].name) || l.sender_id || "?";
        var label  = "Letter " + l.id + " — " + sender + " (" + (l.date || "?") + ")";
        hits.push({ label: label, action: function(ll) { return function() { selectLetter(ll); }; }(l) });
      }
    });

    Object.values(DATA.persons).forEach(function(p) {
      if (p.name.toLowerCase().includes(q) && p.letter_count > 0) {
        var label = "Person: " + p.name + " (" + p.letter_count + " letters)";
        hits.push({ label: label, action: function(pp) { return function() { selectPerson(pp); }; }(p) });
      }
    });

    if (hits.length === 0) {
      results.innerHTML = "<div style='padding:4px 8px;color:#999'>no results</div>";
    } else {
      hits.slice(0, 20).forEach(function(hit) {
        var row = document.createElement("div");
        row.textContent = hit.label;
        row.style.cssText = "padding:3px 8px;cursor:pointer;border-bottom:1px solid #eee";
        row.addEventListener("mouseenter", function() { row.style.background = "#f0f0f0"; });
        row.addEventListener("mouseleave", function() { row.style.background = "#fff"; });
        row.addEventListener("click", function() {
          hit.action();
          results.style.display = "none";
          input.value = "";
        });
        results.appendChild(row);
      });
    }
    results.style.display = "block";
  });

  document.addEventListener("click", function(e) {
    if (!input.contains(e.target) && !results.contains(e.target)) {
      results.style.display = "none";
    }
  });
}

function selectLetter(letter) {
  STATE.view = "letters";
  document.querySelectorAll(".view-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === "letters");
  });
  // Move timeline window to include this letter if needed
  if (letter.date && !letterInWindow(letter)) {
    const d = parseDate(letter.date);
    const span = DATA.maxDate - DATA.minDate;
    const pos = ((d - DATA.minDate) / span) * 100;
    STATE.sliderPos = Math.min(100, Math.max(0, pos));
    document.getElementById("timeline-slider").value = STATE.sliderPos;
    updateTimelineLabel();
  }
  // Set ego to this letter so it's highlighted in the graph
  STATE.egoNode = letter.id;
  STATE.egoKind = "letter";
  document.getElementById("ego-clear").style.display = "inline";
  document.getElementById("ego-info").textContent = "ego: " + letter.id;
  showLetterDetail(letter);
  renderCurrentView();
}


function selectPerson(person) {
  STATE.view = "persons";
  document.querySelectorAll(".view-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.view === "persons");
  });
  STATE.egoNode = person.id;
  STATE.egoKind = "person";
  document.getElementById("ego-clear").style.display = "inline";
  document.getElementById("ego-info").textContent = "ego: " + person.name;
  showPersonDetail(person);
  renderCurrentView();
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    await loadCoreData();
    buildTopicFilters();
    buildCFFilter();
    wireControls();
    wireSearch();
    setLoading(false);
    renderCurrentView();
  } catch(err) {
    setStatus("error: " + err.message);
    console.error(err);
    setLoading(false);
  }
}

boot();
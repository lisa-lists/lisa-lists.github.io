/* LISA// v2 — application logic. Pure DOM + fetch + localStorage. No build step, no framework.
   Perf model: a tiny manifest (metadata only) loads first and paints the UI instantly.
   Each category's items are fetched lazily, on demand, the first time it's opened.
   Rows render in small requestAnimationFrame batches so opening even a 2,000+ item
   category never blocks the main thread. Full data quietly preloads in the background
   (low concurrency, idle time) so search covers everything within a few seconds. */
(function () {
  "use strict";

  var STORE_KEY = "lisa_v2_store";
  var THEME_KEY = "lisa_v2_theme";
  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------- manifest-driven data model ---------------- */
  var MANIFEST = [];               // [{id, slug, title, cluster, methodology, count, p1, p2, p3, ranges:[[lo,hi],...]}]
  var manifestById = {};
  var idSegments = [];              // flat, sorted, non-overlapping [{lo,hi,catId}] built from every category's ranges
  var TOTAL_ITEMS = 0, P1 = 0, P2 = 0, P3 = 0;
  var clusterOrder = [];
  var clusterMap = {};

  var catCache = {};               // id -> items[] (loaded on demand)
  var catLoadPromises = {};        // id -> Promise
  var preloadedCount = 0;
  var preloadDone = false;

  var CLUSTER_LABELS = {
    "Access Control": "Access Control", "Identity": "Identity & Auth", "Injection": "Injection & Input",
    "Client-Side": "Client-Side & Browser", "Server-Side": "Server-Side", "Business Logic": "Business Logic & Commerce",
    "API": "APIs & Protocols", "Integrations": "Integrations", "Data Protection": "Data Protection",
    "Availability": "Availability & DoS", "Infrastructure": "Infrastructure & Cloud", "Emerging": "Emerging & Specialized",
    "Attack Chains": "Attack Chains (Multi-Step)"
  };

  /* ---------------- persisted store ---------------- */
  function loadStore() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        return { done: p.done || {}, flagged: p.flagged || {}, notes: p.notes || {} };
      }
    } catch (e) {}
    return { done: {}, flagged: {}, notes: {} };
  }
  var store = loadStore();
  var doneCount = Object.keys(store.done).length;
  var saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) {}
    }, 200);
  }

  /* ---------------- state ---------------- */
  var state = {
    query: "",
    sevFilter: new Set(),
    flaggedOnly: false,
    openCatId: null,
    searchLimit: 150,
    catItemLimit: 300
  };

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) { return s.replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function makeActivatable(el, handler) {
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); handler(e); }
    });
  }
  function escAttr(s) { return s.replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function renderPlaybook(pb) {
    if (!pb) return "";
    var html = '<div class="playbook">';
    if (pb.tools && pb.tools.length) {
      html += '<div class="playbook-row"><span class="playbook-label">Tools</span><div class="tool-chips">';
      pb.tools.forEach(function (t) { html += '<span class="tool-chip">' + esc(t) + '</span>'; });
      html += '</div></div>';
    }
    if (pb.steps && pb.steps.length) {
      html += '<div class="playbook-row"><span class="playbook-label">How to test</span><ol class="playbook-steps">';
      pb.steps.forEach(function (s) { html += '<li>' + esc(s) + '</li>'; });
      html += '</ol></div>';
    }
    if (pb.payloads && pb.payloads.length) {
      html += '<div class="playbook-row"><span class="playbook-label">Example payloads</span><div class="payload-list">';
      pb.payloads.forEach(function (p) {
        html += '<div class="payload-block"><code>' + esc(p) + '</code>' +
          '<button class="copy-payload-btn" data-payload="' + escAttr(p) + '" aria-label="Copy payload">' +
          '<svg class="icon-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>' +
          '<svg class="icon-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg>' +
          '</button></div>';
      });
      html += '</div></div>';
    }
    html += '</div>';
    return html;
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest(".copy-payload-btn");
    if (!btn) return;
    var text = btn.getAttribute("data-payload") || "";
    var mark = function () { btn.classList.add("copied"); setTimeout(function () { btn.classList.remove("copied"); }, 1100); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(mark).catch(function () {});
    }
  });
  function highlight(text, q) {
    if (!q) return esc(text);
    var idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return esc(text);
    return esc(text.slice(0, idx)) + "<mark>" + esc(text.slice(idx, idx + q.length)) + "</mark>" + esc(text.slice(idx + q.length));
  }
  var toastTimer = null;
  function toast(msg) {
    var t = $("toast"); t.textContent = msg; t.setAttribute("data-show", "true");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.setAttribute("data-show", "false"); }, 2200);
  }

  /* ---------------- animated counters ---------------- */
  var countState = new WeakMap();
  function animateCount(el, to) {
    if (!el) return;
    to = Math.round(to);
    if (reduced) { el.textContent = to.toLocaleString(); return; }
    var from = countState.get(el);
    if (from === undefined) from = 0;
    if (from === to) { el.textContent = to.toLocaleString(); return; }
    countState.set(el, to);
    var start = null, dur = 420;
    cancelAnimationFrame(el._raf || 0);
    function tick(ts) {
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = Math.round(from + (to - from) * eased);
      el.textContent = val.toLocaleString();
      if (p < 1) el._raf = requestAnimationFrame(tick);
    }
    el._raf = requestAnimationFrame(tick);
  }

  /* ---------------- ripple effect (delegated) ---------------- */
  document.addEventListener("click", function (e) {
    if (reduced) return;
    var el = e.target.closest(".icon-btn, .btn, .chip, .load-more button, .cat-nav-item");
    if (!el) return;
    var r = el.getBoundingClientRect();
    var size = Math.max(r.width, r.height) * 1.4;
    var span = document.createElement("span");
    span.className = "ripple";
    span.style.width = span.style.height = size + "px";
    span.style.left = (e.clientX - r.left - size / 2) + "px";
    span.style.top = (e.clientY - r.top - size / 2) + "px";
    var cs = getComputedStyle(el);
    if (cs.position === "static") el.style.position = "relative";
    el.style.overflow = el.style.overflow || "hidden";
    el.appendChild(span);
    setTimeout(function () { span.remove(); }, 600);
  }, true);

  /* ---------------- fast per-category done counts (id-segment based, no item fetch needed) ---------------- */
  var catDoneCounts = {};
  function recomputeCatDoneCounts() {
    catDoneCounts = {};
    var ids = Object.keys(store.done).map(Number).sort(function (a, b) { return a - b; });
    if (!ids.length || !idSegments.length) return;
    var si = 0;
    for (var i = 0; i < ids.length; i++) {
      var v = ids[i];
      while (si < idSegments.length - 1 && v > idSegments[si].hi) si++;
      var seg = idSegments[si];
      if (v >= seg.lo && v <= seg.hi) catDoneCounts[seg.catId] = (catDoneCounts[seg.catId] || 0) + 1;
    }
  }
  function catDoneCount(catEntry) { return catDoneCounts[catEntry.id] || 0; }

  /* ---------------- stats / progress ---------------- */
  function renderStats() {
    animateCount($("statTotal"), TOTAL_ITEMS);
    animateCount($("statDone"), doneCount);
    animateCount($("statP1"), P1);
    animateCount($("statP2"), P2);
    animateCount($("statP3"), P3);
    $("statCats").textContent = MANIFEST.length;
    var pct = TOTAL_ITEMS ? Math.round((doneCount / TOTAL_ITEMS) * 1000) / 10 : 0;
    $("progressPct").textContent = pct + "%";
    var fill = $("progressFill");
    fill.style.width = pct + "%";
    fill.classList.toggle("complete", pct >= 100);
    $("mProgressPct").textContent = Math.round(pct) + "%";
    updateHeroGauge(pct);
    updateTopbarProgress(pct);
  }

  function updateTopbarProgress(pct) {
    var f = $("topbarProgressFill");
    if (f) f.style.width = pct + "%";
  }

  /* ---------------- severity donut — real proportional chart from live totals ---------------- */
  function renderSeverityDonut() {
    var svg = $("sevDonut"), legend = $("donutLegend");
    if (!svg || !TOTAL_ITEMS) return;
    var segs = [
      { label: "P1 · Critical", n: P1, color: "var(--p1)" },
      { label: "P2 · High", n: P2, color: "var(--p2)" },
      { label: "P3 · Medium", n: P3, color: "var(--p3)" }
    ];
    var r = 42, c = 2 * Math.PI * r, offset = 0, circles = "";
    segs.forEach(function (s) {
      var frac = s.n / TOTAL_ITEMS;
      var len = frac * c;
      circles += '<circle class="donut-seg" cx="50" cy="50" r="' + r + '" stroke="' + s.color + '" ' +
        'stroke-dasharray="' + len + ' ' + (c - len) + '" stroke-dashoffset="' + (-offset) + '"/>';
      offset += len;
    });
    svg.innerHTML = '<circle cx="50" cy="50" r="' + r + '" stroke="var(--border-soft)"/>' + circles;
    legend.innerHTML = segs.map(function (s) {
      var pct = TOTAL_ITEMS ? Math.round((s.n / TOTAL_ITEMS) * 100) : 0;
      return '<div class="row"><span class="sw" style="background:' + s.color + '"></span>' + s.label + ' <b>' + pct + '%</b></div>';
    }).join("");
  }

  function updateHeroGauge(pct) {
    var fg = $("heroGaugeFg");
    if (!fg) return;
    var c = 2 * Math.PI * 52;
    fg.style.strokeDasharray = c;
    fg.style.strokeDashoffset = c - (pct / 100) * c;
    $("heroGaugePct").textContent = pct + "%";
  }

  function ringSvg(pct, size) {
    size = size || 30;
    var r = size / 2 - 3, c = 2 * Math.PI * r, off = c - (pct / 100) * c;
    return '<svg class="ring" data-complete="' + (pct >= 100) + '" viewBox="0 0 ' + size + ' ' + size + '"><circle class="bg" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '"/>' +
      '<circle class="fg" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + r + '" stroke-dasharray="' + c + '" stroke-dashoffset="' + off + '"/></svg>';
  }

  /* ---------------- completion celebration (tiny confetti burst) ---------------- */
  function burstConfetti(el) {
    if (reduced || !el) return;
    var colors = ["#35e0c4", "#8b7cf6", "#ffb648", "#5aa9ff"];
    for (var i = 0; i < 10; i++) {
      var p = document.createElement("span");
      p.className = "confetti-piece";
      var angle = Math.random() * Math.PI * 2, dist = 24 + Math.random() * 24;
      p.style.setProperty("--tx", Math.cos(angle) * dist + "px");
      p.style.setProperty("--ty", Math.sin(angle) * dist + "px");
      p.style.setProperty("--rot", Math.round(Math.random() * 360) + "deg");
      p.style.background = colors[i % colors.length];
      el.appendChild(p);
      (function (piece) { setTimeout(function () { piece.remove(); }, 800); })(p);
    }
  }

  /* ---------------- smooth cross-fade for major view switches ---------------- */
  function withViewTransition(fn) {
    if (reduced || typeof document.startViewTransition !== "function") { fn(); return; }
    document.startViewTransition(fn);
  }

  /* ---------------- cursor-reactive card spotlight + subtle 3D tilt (rAF-throttled, single element at a time) ---------------- */
  (function initSpotlight() {
    if (reduced) return;
    var raf = null, px = 0, py = 0, target = null;
    document.addEventListener("pointermove", function (e) {
      var el = e.target.closest(".category-card, .stat-card");
      if (!el) return;
      target = el; px = e.clientX; py = e.clientY;
      if (raf) return;
      raf = requestAnimationFrame(function () {
        raf = null;
        if (!target) return;
        var r = target.getBoundingClientRect();
        var relX = px - r.left, relY = py - r.top;
        target.style.setProperty("--mx", relX + "px");
        target.style.setProperty("--my", relY + "px");
        var isOpenCard = target.classList.contains("category-card") && target.getAttribute("data-open") === "true";
        if (!isOpenCard) {
          var cx = relX / r.width - 0.5, cy = relY / r.height - 0.5;
          target.style.setProperty("--ry", (cx * 6).toFixed(2) + "deg");
          target.style.setProperty("--rx", (cy * -6).toFixed(2) + "deg");
        }
      });
    }, { passive: true });
    document.addEventListener("pointerout", function (e) {
      var el = e.target.closest(".category-card, .stat-card");
      if (el && !el.contains(e.relatedTarget)) {
        el.style.setProperty("--rx", "0deg");
        el.style.setProperty("--ry", "0deg");
      }
    }, { passive: true });
  })();

  /* ---------------- scroll-in reveal for item rows (silky stagger beyond the initial 40-row cap) ---------------- */
  var rowRevealObserver = (!reduced && "IntersectionObserver" in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("row-revealed");
        rowRevealObserver.unobserve(entry.target);
      }
    });
  }, { rootMargin: "80px 0px" }) : null;

  /* ---------------- sidebar nav ---------------- */
  function renderSidebarNav() {
    var wrap = $("clusterNav");
    wrap.innerHTML = "";
    clusterOrder.forEach(function (cluster) {
      var cats = clusterMap[cluster];
      var head = document.createElement("div");
      head.className = "cluster-head";
      head.setAttribute("data-open", "true");
      head.setAttribute("aria-expanded", "true");
      head.innerHTML = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3l3 3 3-3"/></svg>' +
        '<span>' + (CLUSTER_LABELS[cluster] || cluster) + ' · ' + cats.length + '</span>';
      var body = document.createElement("div");
      body.className = "cluster-cats";
      body.setAttribute("data-open", "true");
      var inner = document.createElement("div");
      cats.forEach(function (cat) {
        var row = document.createElement("div");
        row.className = "cat-nav-item";
        row.setAttribute("data-cat-id", cat.id);
        var done = catDoneCount(cat);
        var pct = cat.count ? Math.round((done / cat.count) * 100) : 0;
        row.innerHTML = '<span class="bar"></span>' + ringSvg(pct, 16) +
          '<span class="title">' + esc(cat.title) + '</span><span class="count">' + cat.count + '</span>';
        row.addEventListener("click", function () { focusCategory(cat.id); });
        makeActivatable(row, function () { focusCategory(cat.id); });
        inner.appendChild(row);
      });
      body.appendChild(inner);
      head.addEventListener("click", function () {
        var open = body.getAttribute("data-open") === "true";
        body.setAttribute("data-open", open ? "false" : "true");
        head.setAttribute("data-open", open ? "false" : "true");
        head.setAttribute("aria-expanded", open ? "false" : "true");
      });
      makeActivatable(head, function () { head.click(); });
      wrap.appendChild(head);
      wrap.appendChild(body);
    });
  }

  function updateNavActive() {
    document.querySelectorAll(".cat-nav-item").forEach(function (el) {
      el.setAttribute("data-active", String(Number(el.getAttribute("data-cat-id")) === state.openCatId));
    });
  }

  function focusCategory(catId) {
    withViewTransition(function () {
      clearSearchAndFilters(true);
      state.openCatId = catId;
      render();
    });
    requestAnimationFrame(function () {
      var el = document.querySelector('.category-card[data-cat-id="' + catId + '"]');
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    closeSidebarOnMobile();
  }

  /* ---------------- lazy per-category data loading ---------------- */
  function ensureCategoryLoaded(id) {
    if (catCache[id]) return Promise.resolve(catCache[id]);
    if (catLoadPromises[id]) return catLoadPromises[id];
    var p = fetch("data/categories/" + id + ".json")
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (chunk) {
        catCache[id] = chunk.items;
        preloadedCount++;
        return chunk.items;
      })
      .catch(function (err) { delete catLoadPromises[id]; throw err; });
    catLoadPromises[id] = p;
    return p;
  }

  function backgroundPreload() {
    var ids = MANIFEST.map(function (c) { return c.id; }).filter(function (id) { return !catCache[id]; });
    var idx = 0, concurrency = 8, active = 0, total = ids.length;
    if (!total) { preloadDone = true; updatePreloadIndicator(); return; }
    updatePreloadIndicator();
    function next() {
      if (idx >= ids.length) {
        if (active === 0) { preloadDone = true; updatePreloadIndicator(); }
        return;
      }
      var id = ids[idx++]; active++;
      ensureCategoryLoaded(id).then(function () {
        active--; updatePreloadIndicator(); maybeRerenderSearchLive(); next();
      }).catch(function () { active--; next(); });
    }
    for (var k = 0; k < concurrency; k++) next();
  }

  function updatePreloadIndicator() {
    var el = $("preloadStatus");
    if (!el) return;
    if (preloadDone) { el.setAttribute("data-show", "false"); return; }
    el.setAttribute("data-show", "true");
    el.textContent = "Indexing search data… " + preloadedCount + "/" + MANIFEST.length;
  }

  var liveRerenderTimer = null;
  function maybeRerenderSearchLive() {
    if (!isFlatMode()) return;
    clearTimeout(liveRerenderTimer);
    liveRerenderTimer = setTimeout(render, 500);
  }

  /* ---------------- item row ---------------- */
  function itemRow(item, cat, showCatTag, rowIndex) {
    var row = document.createElement("div");
    row.className = "item-row";
    row.setAttribute("data-id", item.id);
    row.setAttribute("data-done", String(!!store.done[item.id]));
    row.setAttribute("data-has-note", String(!!(store.notes[item.id] && store.notes[item.id].trim())));
    if (!reduced && typeof rowIndex === "number") row.style.setProperty("--ri", rowIndex);
    var catTag = showCatTag ? '<div class="item-cat-tag">' + esc(cat.title) + '</div>' : "";
    row.innerHTML =
      '<button class="chk" aria-label="Mark done"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6 9 17l-5-5"/></svg></button>' +
      '<span class="sev-tag ' + item.severity + '">' + item.severity + '</span>' +
      '<div class="item-main"><div class="item-text">' + highlight(item.text, state.query) + '</div>' + catTag + '</div>' +
      '<button class="note-btn" aria-label="Add note" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button>' +
      '<button class="flag-btn" data-flagged="' + !!store.flagged[item.id] + '" aria-label="Flag for review"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 3v18l7-4 7 4V3z"/></svg></button>';

    var chkEl = row.querySelector(".chk");
    chkEl.addEventListener("click", function (e) {
      var was = !!store.done[item.id];
      var pctBefore = cat.count ? Math.round((catDoneCount(cat) / cat.count) * 100) : 0;
      if (was) { delete store.done[item.id]; doneCount--; catDoneCounts[cat.id] = (catDoneCounts[cat.id] || 0) - 1; }
      else { store.done[item.id] = 1; doneCount++; catDoneCounts[cat.id] = (catDoneCounts[cat.id] || 0) + 1; }
      row.setAttribute("data-done", String(!was));
      chkEl.classList.add("pop");
      row.classList.add("just-toggled");
      setTimeout(function () { chkEl.classList.remove("pop"); row.classList.remove("just-toggled"); }, 550);
      persist(); renderStats(); updateCategoryProgress(cat.id);

      var pctAfter = cat.count ? Math.round((catDoneCount(cat) / cat.count) * 100) : 0;
      if (pctAfter === 100 && pctBefore !== 100) {
        var headEl = document.querySelector('.category-card[data-cat-id="' + cat.id + '"] .category-head');
        if (headEl) burstConfetti(headEl);
        toast("✓ " + cat.title + " complete!");
      }
      if (doneCount === TOTAL_ITEMS && TOTAL_ITEMS > 0) {
        burstConfetti($("heroGauge"));
        toast("🎯 Full scope complete — all " + TOTAL_ITEMS.toLocaleString() + " test cases checked!");
      }
    });
    var noteBtn = row.querySelector(".note-btn");
    var notePanel = null, noteSaveTimer = null;
    noteBtn.addEventListener("click", function () {
      if (!notePanel) {
        notePanel = document.createElement("div");
        notePanel.className = "note-panel";
        var ta = document.createElement("textarea");
        ta.placeholder = "Private note (saved locally in your browser)…";
        ta.value = store.notes[item.id] || "";
        ta.addEventListener("input", function () {
          clearTimeout(noteSaveTimer);
          noteSaveTimer = setTimeout(function () {
            var v = ta.value.trim();
            if (v) store.notes[item.id] = v; else delete store.notes[item.id];
            persist();
            row.setAttribute("data-has-note", String(!!v));
          }, 350);
        });
        notePanel.appendChild(ta);
        row.querySelector(".item-main").appendChild(notePanel);
      }
      var opening = !row.classList.contains("note-open");
      row.classList.toggle("note-open", opening);
      noteBtn.setAttribute("aria-expanded", String(opening));
      if (opening) requestAnimationFrame(function () { notePanel.querySelector("textarea").focus(); });
    });
    var flagEl = row.querySelector(".flag-btn");
    flagEl.addEventListener("click", function (e) {
      var was = !!store.flagged[item.id];
      if (was) delete store.flagged[item.id]; else store.flagged[item.id] = 1;
      flagEl.setAttribute("data-flagged", String(!was));
      flagEl.classList.add("pop");
      setTimeout(function () { flagEl.classList.remove("pop"); }, 400);
      persist();
    });
    if (rowRevealObserver) rowRevealObserver.observe(row); else row.classList.add("row-revealed");
    return row;
  }

  function updateCategoryProgress(catId) {
    var catEntry = manifestById[catId];
    if (!catEntry) return;
    var done = catDoneCount(catEntry), pct = catEntry.count ? Math.round((done / catEntry.count) * 100) : 0;
    var card = document.querySelector('.category-card[data-cat-id="' + catId + '"]');
    if (card) {
      var ring = card.querySelector(".category-head .ring");
      if (ring) ring.outerHTML = ringSvg(pct, 30);
    }
    var nav = document.querySelector('.cat-nav-item[data-cat-id="' + catId + '"]');
    if (nav) {
      var navRing = nav.querySelector(".ring");
      if (navRing) navRing.outerHTML = ringSvg(pct, 16);
    }
  }

  /* ---------------- chunked, non-blocking DOM insertion ---------------- */
  function chunkAppend(container, items, buildFn, batchSize, onDone) {
    var i = 0;
    function step() {
      var frag = document.createDocumentFragment();
      var end = Math.min(items.length, i + batchSize);
      for (; i < end; i++) frag.appendChild(buildFn(items[i], i));
      container.appendChild(frag);
      if (i < items.length) requestAnimationFrame(step);
      else if (onDone) onDone();
    }
    step();
  }

  function skeletonHTML(n) {
    var s = "";
    for (var i = 0; i < n; i++) s += '<div class="skeleton-row"></div>';
    return s;
  }

  /* ---------------- category card (browse mode) ---------------- */
  function categoryCard(catEntry, index) {
    var isOpen = state.openCatId === catEntry.id;
    var card = document.createElement("div");
    card.className = "category-card";
    card.setAttribute("data-cat-id", catEntry.id);
    card.setAttribute("data-open", String(isOpen));
    if (!reduced && typeof index === "number") card.style.setProperty("--i", Math.min(index, 24));

    var done = catDoneCount(catEntry), pct = catEntry.count ? Math.round((done / catEntry.count) * 100) : 0;

    var head = document.createElement("div");
    head.className = "category-head";
    head.innerHTML =
      '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 6l6 6-6 6"/></svg>' +
      '<div class="titles"><div class="cluster-tag">' + esc(CLUSTER_LABELS[catEntry.cluster] || catEntry.cluster) + '</div><h3>' + esc(catEntry.title) + '</h3></div>' +
      '<div class="meta"><div class="sev-mini"><b class="p1">' + catEntry.p1 + '</b><b class="p2">' + catEntry.p2 + '</b><b class="p3">' + catEntry.p3 + '</b></div>' +
      ringSvg(pct, 30) + '</div>';
    head.addEventListener("click", function () { toggleCategory(card, catEntry); });
    head.setAttribute("aria-expanded", String(isOpen));
    makeActivatable(head, function () { head.click(); });
    card.appendChild(head);

    var methodology = document.createElement("div");
    methodology.className = "methodology";
    methodology.innerHTML = '<b>Methodology</b>' + esc(catEntry.methodology) + renderPlaybook(catEntry.playbook);
    card.appendChild(methodology);

    var list = document.createElement("div");
    list.className = "item-list";
    var inner = document.createElement("div");
    inner.className = "item-list-inner";
    list.appendChild(inner);
    card.appendChild(list);
    if (isOpen) openList(card, catEntry, inner);

    return card;
  }

  function toggleCategory(card, catEntry) {
    var nowOpen = card.getAttribute("data-open") !== "true";
    // close others for perf (avoid huge DOM)
    document.querySelectorAll(".category-card[data-open=true]").forEach(function (c) {
      if (c !== card) {
        c.setAttribute("data-open", "false");
        c.removeAttribute("data-loading");
        var h = c.querySelector(".category-head");
        if (h) h.setAttribute("aria-expanded", "false");
        var l = c.querySelector(".item-list-inner");
        if (l) l.innerHTML = "";
      }
    });
    card.setAttribute("data-open", String(nowOpen));
    var headEl = card.querySelector(".category-head");
    if (headEl) headEl.setAttribute("aria-expanded", String(nowOpen));
    state.openCatId = nowOpen ? catEntry.id : null;
    updateNavActive();
    var inner = card.querySelector(".item-list-inner");
    if (nowOpen && !inner.childElementCount) openList(card, catEntry, inner);
  }

  function openList(card, catEntry, inner) {
    card.setAttribute("data-loading", "true");
    inner.innerHTML = skeletonHTML(Math.min(catEntry.count, 8));
    ensureCategoryLoaded(catEntry.id).then(function (items) {
      if (state.openCatId !== catEntry.id) return; // user moved on before this resolved
      card.removeAttribute("data-loading");
      inner.innerHTML = "";
      state.catItemLimit = 300;
      renderCategoryItems(inner, catEntry, items);
    }).catch(function () {
      card.removeAttribute("data-loading");
      inner.innerHTML = '<div class="empty-state" style="display:block;margin:24px auto;">Couldn\u2019t load this category — check your connection and reopen it.</div>';
    });
  }

  function renderCategoryItems(inner, catEntry, items) {
    var limit = Math.min(items.length, state.catItemLimit);
    chunkAppend(inner, items.slice(0, limit), function (item, idx) { return itemRow(item, catEntry, false, idx); }, 120, function () {
      if (items.length > limit) appendCatLoadMore(inner, catEntry, items);
    });
  }

  function appendCatLoadMore(inner, catEntry, items) {
    var wrap = document.createElement("div");
    wrap.className = "load-more cat-load-more";
    var remaining = items.length - state.catItemLimit;
    var btn = document.createElement("button");
    btn.textContent = "Load " + Math.min(300, remaining).toLocaleString() + " more (" + remaining.toLocaleString() + " remaining in this category)";
    btn.addEventListener("click", function () {
      wrap.remove();
      var start = state.catItemLimit;
      state.catItemLimit += 300;
      var nextEnd = Math.min(items.length, state.catItemLimit);
      chunkAppend(inner, items.slice(start, nextEnd), function (item, idx) { return itemRow(item, catEntry, false, idx); }, 120, function () {
        if (items.length > state.catItemLimit) appendCatLoadMore(inner, catEntry, items);
      });
    });
    wrap.appendChild(btn);
    inner.appendChild(wrap);
  }

  /* ---------------- search / filter flat results (over whatever's loaded so far) ---------------- */
  function buildFilteredResults() {
    var q = state.query.trim().toLowerCase();
    var results = [];
    for (var ci = 0; ci < MANIFEST.length; ci++) {
      var catEntry = MANIFEST[ci];
      var items = catCache[catEntry.id];
      if (!items) continue;
      for (var ii = 0; ii < items.length; ii++) {
        var it = items[ii];
        if (state.sevFilter.size && !state.sevFilter.has(it.severity)) continue;
        if (state.flaggedOnly && !store.flagged[it.id]) continue;
        if (q && it.text.toLowerCase().indexOf(q) === -1 && catEntry.title.toLowerCase().indexOf(q) === -1) continue;
        results.push({ item: it, cat: catEntry });
      }
    }
    return results;
  }

  function isFlatMode() {
    return !!(state.query.trim() || state.sevFilter.size || state.flaggedOnly);
  }

  /* ---------------- main render ---------------- */
  function render() {
    var catList = $("catList");
    var loadMoreWrap = $("loadMoreWrap");
    var emptyState = $("emptyState");
    catList.innerHTML = "";

    if (isFlatMode()) {
      // searching/filtering needs item text — make sure background preload is running
      if (!preloadDone && !state._preloadKicked) { state._preloadKicked = true; backgroundPreload(); }

      var results = buildFilteredResults();
      var countTxt = results.length.toLocaleString() + " matching test case" + (results.length === 1 ? "" : "s");
      if (!preloadDone) countTxt += " so far — " + preloadedCount + "/" + MANIFEST.length + " categories indexed";
      $("resultsCount").textContent = countTxt;
      var bits = [];
      if (state.query.trim()) bits.push('query "' + state.query.trim() + '"');
      if (state.sevFilter.size) bits.push([...state.sevFilter].join("+"));
      if (state.flaggedOnly) bits.push("flagged");
      $("filterState").textContent = bits.length ? bits.join(" · ") : "";

      if (!results.length) { emptyState.style.display = "block"; loadMoreWrap.style.display = "none"; return; }
      emptyState.style.display = "none";

      var slice = results.slice(0, state.searchLimit);
      var flatCard = document.createElement("div");
      flatCard.className = "category-card flat-results";
      var innerList = document.createElement("div");
      innerList.className = "item-list";
      innerList.style.display = "block";
      chunkAppend(innerList, slice, function (r, idx) { return itemRow(r.item, r.cat, true, idx); }, 150);
      flatCard.appendChild(innerList);
      catList.appendChild(flatCard);

      if (results.length > state.searchLimit) {
        loadMoreWrap.style.display = "block";
        $("loadMoreBtn").textContent = "Load 150 more (" + (results.length - state.searchLimit).toLocaleString() + " remaining)";
      } else {
        loadMoreWrap.style.display = "none";
      }
      return;
    }

    loadMoreWrap.style.display = "none";
    emptyState.style.display = "none";
    $("filterState").textContent = "";
    $("resultsCount").textContent = MANIFEST.length + " categories · " + TOTAL_ITEMS.toLocaleString() + " test cases";

    var frag2 = document.createDocumentFragment();
    MANIFEST.forEach(function (cat, idx) { frag2.appendChild(categoryCard(cat, idx)); });
    catList.appendChild(frag2);
    updateNavActive();
  }

  /* ---------------- controls ---------------- */
  function clearSearchAndFilters(keepOpenCat) {
    state.query = ""; $("searchInput").value = "";
    state.sevFilter.clear();
    state.flaggedOnly = false;
    state.searchLimit = 150;
    document.querySelectorAll(".chip").forEach(function (c) { c.setAttribute("data-active", "false"); });
    $("flaggedBtn").textContent = "☆ Show flagged only";
    if (!keepOpenCat) state.openCatId = null;
  }

  var searchDebounce = null;
  $("searchInput").addEventListener("input", function (e) {
    clearTimeout(searchDebounce);
    var v = e.target.value;
    searchDebounce = setTimeout(function () {
      state.query = v; state.searchLimit = 150; render();
    }, 140);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && document.activeElement !== $("searchInput")) {
      e.preventDefault(); openSidebarSearchMobile(); $("searchInput").focus();
    }
    if (e.key === "Escape" && document.activeElement === $("searchInput")) {
      $("searchInput").blur();
    }
  });

  document.querySelectorAll(".chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      var sev = chip.getAttribute("data-sev");
      var active = chip.getAttribute("data-active") === "true";
      if (active) { state.sevFilter.delete(sev); chip.setAttribute("data-active", "false"); }
      else { state.sevFilter.add(sev); chip.setAttribute("data-active", "true"); }
      state.searchLimit = 150;
      withViewTransition(render);
    });
  });

  $("flaggedBtn").addEventListener("click", function () {
    state.flaggedOnly = !state.flaggedOnly;
    this.textContent = state.flaggedOnly ? "★ Showing flagged only" : "☆ Show flagged only";
    state.searchLimit = 150;
    withViewTransition(render);
  });

  $("resetBtn").addEventListener("click", function () {
    if (!confirm("Reset ALL progress and flags? This cannot be undone.")) return;
    store = { done: {}, flagged: {}, notes: {} };
    doneCount = 0;
    recomputeCatDoneCounts();
    persist(); renderStats(); renderSidebarNav(); render();
    toast("Progress reset.");
  });

  $("loadMoreBtn").addEventListener("click", function () {
    state.searchLimit += 150; render();
  });

  $("brandBtn").addEventListener("click", function () {
    withViewTransition(function () { clearSearchAndFilters(); render(); });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  /* ---------------- theme ---------------- */
  function applyTheme(t) {
    document.body.classList.toggle("light", t === "light");
    try { localStorage.setItem(THEME_KEY, t); } catch (e) {}
  }
  var savedTheme = "dark";
  try { savedTheme = localStorage.getItem(THEME_KEY) || "dark"; } catch (e) {}
  applyTheme(savedTheme);
  $("themeBtn").addEventListener("click", function () {
    var next = document.body.classList.contains("light") ? "dark" : "light";
    withViewTransition(function () { applyTheme(next); });
  });

  /* ---------------- mobile drawer ---------------- */
  function openSidebar() { $("sidebar").setAttribute("data-show", "true"); $("overlay").setAttribute("data-show", "true"); }
  function closeSidebar() { $("sidebar").setAttribute("data-show", "false"); $("overlay").setAttribute("data-show", "false"); }
  function closeSidebarOnMobile() { if (window.innerWidth <= 920) closeSidebar(); }
  function openSidebarSearchMobile() { if (window.innerWidth <= 920) openSidebar(); }

  $("menuBtn").addEventListener("click", function () {
    var showing = $("sidebar").getAttribute("data-show") === "true";
    showing ? closeSidebar() : openSidebar();
  });
  $("overlay").addEventListener("click", closeSidebar);
  $("mCatBtn").addEventListener("click", function () { openSidebar(); setMobileActive("mCatBtn"); });
  $("mSearchBtn").addEventListener("click", function () { openSidebar(); $("searchInput").focus(); setMobileActive("mSearchBtn"); });
  $("mProgressBtn").addEventListener("click", function () { openSidebar(); setMobileActive("mProgressBtn"); });
  $("mExportBtn").addEventListener("click", function () { openExportModal(); });
  function setMobileActive(id) {
    ["mCatBtn", "mSearchBtn", "mProgressBtn", "mExportBtn"].forEach(function (b) { $(b).setAttribute("data-active", String(b === id)); });
  }

  /* ---------------- export ---------------- */
  function openExportModal() { $("exportModal").setAttribute("data-show", "true"); }
  function closeExportModal() { $("exportModal").setAttribute("data-show", "false"); }
  $("modalCancel").addEventListener("click", closeExportModal);
  $("exportBtn").addEventListener("click", openExportModal);
  $("exportModal").addEventListener("click", function (e) { if (e.target === $("exportModal")) closeExportModal(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && $("exportModal").getAttribute("data-show") === "true") closeExportModal();
  });
  $("modalExport").addEventListener("click", function () {
    var payload = {
      exportedAt: new Date().toISOString(),
      totalItems: TOTAL_ITEMS,
      doneCount: doneCount,
      done: Object.keys(store.done).map(Number),
      flagged: Object.keys(store.flagged).map(Number),
      notes: store.notes
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "lisa-checklist-progress-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a); a.click(); a.remove();
    closeExportModal();
    toast("Progress exported.");
  });

  /* ---------------- typed intro line ---------------- */
  function typeIntro() {
    var el = $("typedLine");
    var text = "root@recon:~$ checklist --scope=webapp --items=" + TOTAL_ITEMS.toLocaleString() + " --p1=" + P1 + " --p2=" + P2 + " --p3=" + P3;
    if (reduced) { el.textContent = text; return; }
    var i = 0;
    el.innerHTML = '<span class="caret"></span>';
    (function tick() {
      i++;
      el.innerHTML = esc(text.slice(0, i)) + '<span class="caret"></span>';
      if (i < text.length) setTimeout(tick, 10);
    })();
  }

  /* ---------------- animated particle constellation background ---------------- */
  function initParticles() {
    var canvas = $("particles");
    if (!canvas || reduced) return;
    var ctx = canvas.getContext("2d");
    var w, h, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var pts = [];
    var accent = "53,224,196";
    var isLight = false;
    var running = true;
    var mouseX = -9999, mouseY = -9999;
    window.addEventListener("pointermove", function (e) { mouseX = e.clientX; mouseY = e.clientY; }, { passive: true });
    window.addEventListener("pointerleave", function () { mouseX = -9999; mouseY = -9999; });

    function resize() {
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var count = Math.max(18, Math.min(60, Math.round((w * h) / 26000)));
      pts = [];
      for (var i = 0; i < count; i++) {
        pts.push({
          x: Math.random() * w, y: Math.random() * h,
          vx: (Math.random() - 0.5) * 0.28, vy: (Math.random() - 0.5) * 0.28,
          r: Math.random() * 1.6 + 0.6
        });
      }
    }

    function step() {
      if (!running) return;
      ctx.clearRect(0, 0, w, h);
      isLight = document.body.classList.contains("light");
      var col = isLight ? "20,60,55" : accent;
      var maxDist = 140;
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i];
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > w) p.vx *= -1;
        if (p.y < 0 || p.y > h) p.vy *= -1;
        var mdx = p.x - mouseX, mdy = p.y - mouseY, mdist = Math.sqrt(mdx * mdx + mdy * mdy);
        if (mdist < 120 && mdist > 0.01) {
          var push = (120 - mdist) / 120 * 0.9;
          p.x += (mdx / mdist) * push;
          p.y += (mdy / mdist) * push;
        }
        ctx.beginPath();
        ctx.fillStyle = "rgba(" + col + "," + (isLight ? 0.35 : 0.55) + ")";
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        for (var j = i + 1; j < pts.length; j++) {
          var q = pts[j];
          var dx = p.x - q.x, dy = p.y - q.y;
          var dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < maxDist) {
            ctx.beginPath();
            ctx.strokeStyle = "rgba(" + col + "," + ((1 - dist / maxDist) * (isLight ? 0.12 : 0.18)) + ")";
            ctx.lineWidth = 1;
            ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
            ctx.stroke();
          }
        }
      }
      requestAnimationFrame(step);
    }

    document.addEventListener("visibilitychange", function () {
      running = !document.hidden;
      if (running) requestAnimationFrame(step);
    });
    window.addEventListener("resize", resize);
    resize();
    requestAnimationFrame(step);
  }

  /* ---------------- sticky topbar progress reveal ---------------- */
  function initScrollProgress() {
    var fillEl = $("topbarProgressFill");
    if (!fillEl) return;
    var ticking = false;
    function update() {
      ticking = false;
      fillEl.setAttribute("data-visible", String(window.scrollY > 260));
    }
    window.addEventListener("scroll", function () {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
  }

  /* ---------------- command palette (Ctrl/Cmd+K) — instant jump to any category ---------------- */
  function initCommandPalette() {
    var overlay = $("cmdkOverlay"), input = $("cmdkInput"), list = $("cmdkList"), empty = $("cmdkEmpty");
    var highlighted = 0, filtered = [], lastFocused = null;

    function fuzzyScore(title, q) {
      var idx = title.toLowerCase().indexOf(q);
      if (idx === -1) return -1;
      return 1000 - idx - (title.length - q.length) * 0.1;
    }

    function renderList() {
      var q = input.value.trim().toLowerCase();
      if (!q) {
        filtered = MANIFEST.slice(0, 40);
      } else {
        filtered = MANIFEST
          .map(function (c) { return { c: c, score: fuzzyScore(c.title, q) }; })
          .filter(function (x) { return x.score > -1; })
          .sort(function (a, b) { return b.score - a.score; })
          .slice(0, 40)
          .map(function (x) { return x.c; });
      }
      highlighted = 0;
      if (!filtered.length) { list.innerHTML = ""; empty.style.display = "block"; return; }
      empty.style.display = "none";
      list.innerHTML = filtered.map(function (c, i) {
        var done = catDoneCount(c), pct = c.count ? Math.round((done / c.count) * 100) : 0;
        var titleHtml = q ? highlight(c.title, q) : esc(c.title);
        return '<div class="cmdk-item" data-idx="' + i + '" data-highlighted="' + (i === 0) + '" role="option">' +
          ringSvg(pct, 22) +
          '<div class="meta"><div class="title">' + titleHtml + '</div><div class="cluster">' + esc(CLUSTER_LABELS[c.cluster] || c.cluster) + '</div></div>' +
          '<div class="count">' + c.count.toLocaleString() + '</div></div>';
      }).join("");
    }

    function updateHighlight(newIdx) {
      var els = list.querySelectorAll(".cmdk-item");
      if (!els.length) return;
      highlighted = Math.max(0, Math.min(newIdx, els.length - 1));
      els.forEach(function (el, i) { el.setAttribute("data-highlighted", String(i === highlighted)); });
      var target = els[highlighted];
      if (target) target.scrollIntoView({ block: "nearest" });
    }

    function selectHighlighted() {
      var c = filtered[highlighted];
      if (!c) return;
      close();
      focusCategory(c.id);
    }

    function open() {
      lastFocused = document.activeElement;
      overlay.setAttribute("data-show", "true");
      input.value = "";
      renderList();
      requestAnimationFrame(function () { input.focus(); });
    }
    function close() {
      overlay.setAttribute("data-show", "false");
      if (lastFocused && lastFocused.focus) lastFocused.focus();
    }

    input.addEventListener("input", renderList);
    list.addEventListener("click", function (e) {
      var el = e.target.closest(".cmdk-item");
      if (!el) return;
      highlighted = Number(el.getAttribute("data-idx"));
      selectHighlighted();
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); updateHighlight(highlighted + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); updateHighlight(highlighted - 1); }
      else if (e.key === "Enter") { e.preventDefault(); selectHighlighted(); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    $("cmdkBtn").addEventListener("click", open);
    document.addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        (overlay.getAttribute("data-show") === "true") ? close() : open();
      }
    });
  }

  /* ---------------- boot screen: terminal boot log + matrix rain ---------------- */
  function D(ms) { return reduced ? 0 : ms; }

  function initBootScreen() {
    var screen = $("bootScreen");
    if (!screen) return { addLine: function (a, b, c, d, cb) { if (cb) cb(); }, setProgress: function () {}, dismiss: function () {}, isDismissed: function () { return true; } };
    var logEl = $("bootLog"), fillEl = $("bootProgressFill"), pctEl = $("bootProgressPct");
    var dismissed = false;

    function addLine(tag, msg, ok, delayMs, cb) {
      setTimeout(function () {
        if (!dismissed) {
          var line = document.createElement("div");
          line.className = "boot-line";
          line.innerHTML = '<span class="tag">' + esc(tag) + '</span><span class="msg">' + esc(msg) + '</span>' + (ok ? '<span class="ok">OK</span>' : "");
          logEl.appendChild(line);
          logEl.scrollTop = logEl.scrollHeight;
          void line.offsetWidth; // force a synchronous style/layout flush so the opacity:0 start
                                  // state is committed before flipping to .in — reliable across
                                  // engines without depending on a rendering-loop callback.
          line.classList.add("in");
          // belt-and-suspenders: guarantee visibility even in an environment where the
          // transition somehow never commits, by force-setting the end state directly.
          setTimeout(function () { line.style.opacity = "1"; line.style.transform = "translateX(0)"; }, 60);
        }
        if (cb) cb();
      }, delayMs);
    }
    function setProgress(pct) {
      pct = Math.max(0, Math.min(100, pct));
      if (fillEl) fillEl.style.width = pct + "%";
      if (pctEl) pctEl.textContent = Math.round(pct) + "%";
    }
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      screen.setAttribute("data-exit", "true");
      setTimeout(function () { screen.style.display = "none"; }, D(650));
    }
    function skip() { dismiss(); }
    document.addEventListener("keydown", skip, { once: true });
    screen.addEventListener("click", skip, { once: true });
    screen.addEventListener("touchstart", skip, { once: true, passive: true });

    return { addLine: addLine, setProgress: setProgress, dismiss: dismiss, isDismissed: function () { return dismissed; } };
  }

  function initBootMatrix() {
    var canvas = $("bootMatrix");
    if (!canvas || reduced) return;
    var ctx = canvas.getContext("2d");
    var w, h, dpr = Math.min(window.devicePixelRatio || 1, 2);
    var fontSize = 15, columns, drops;
    var chars = "01アイウエオカキクケコサシスセソ$#@%&+=<>/\\{}[]".split("");
    var running = true;

    function resize() {
      w = window.innerWidth; h = window.innerHeight;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      columns = Math.ceil(w / fontSize);
      drops = [];
      for (var i = 0; i < columns; i++) drops.push(Math.random() * -40);
    }
    function step() {
      if (!running) return;
      ctx.fillStyle = "rgba(10,12,17,0.16)";
      ctx.fillRect(0, 0, w, h);
      ctx.font = fontSize + "px monospace";
      for (var i = 0; i < columns; i++) {
        var ch = chars[Math.floor(Math.random() * chars.length)];
        var y = drops[i] * fontSize;
        ctx.fillStyle = Math.random() > 0.94 ? "#c7fff2" : "rgba(53,224,196,0.7)";
        ctx.fillText(ch, i * fontSize, y);
        if (y > h && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
      requestAnimationFrame(step);
    }
    window.addEventListener("resize", resize);
    resize();
    requestAnimationFrame(step);
    var stopCheck = setInterval(function () {
      var s = $("bootScreen");
      if (!s || s.getAttribute("data-exit") === "true" || s.style.display === "none") {
        running = false;
        clearInterval(stopCheck);
      }
    }, 400);
  }

  function runBootLines(bootUI, lines, onDone) {
    var i = 0;
    function next() {
      if (i >= lines.length) { onDone(); return; }
      var L = lines[i++];
      bootUI.addLine(L.tag, L.msg, L.ok, D(L.delay), next);
    }
    next();
  }

  /* ---------------- boot ---------------- */
  function finishAppBoot(m) {
    MANIFEST = m;
    m.forEach(function (c) {
      TOTAL_ITEMS += c.count; P1 += c.p1; P2 += c.p2; P3 += c.p3;
      manifestById[c.id] = c;
      if (!clusterMap[c.cluster]) { clusterMap[c.cluster] = []; clusterOrder.push(c.cluster); }
      clusterMap[c.cluster].push(c);
      c.ranges.forEach(function (r) { idSegments.push({ lo: r[0], hi: r[1], catId: c.id }); });
    });
    idSegments.sort(function (a, b) { return a.lo - b.lo; });
    recomputeCatDoneCounts();

    renderStats();
    renderSeverityDonut();
    renderSidebarNav();
    render();
    typeIntro();
    initParticles();
    initCommandPalette();
    initScrollProgress();

    var idle = window.requestIdleCallback || function (fn) { setTimeout(fn, 400); };
    idle(backgroundPreload);
  }

  function reportBootError(err) {
    $("catList").innerHTML = '<div class="empty-state" style="display:block;">Couldn\u2019t load the checklist data. Please check your connection and refresh.</div>';
    console.error("LISA boot failed:", err);
  }

  function boot() {
    var bootUI = initBootScreen();
    initBootMatrix();

    var introDone = false, fetchDone = false, fetchResult = null, fetchError = null, appBooted = false;

    function finishOnce(m) {
      if (appBooted) return;
      appBooted = true;
      finishAppBoot(m);
    }

    function tryFinish() {
      if (bootUI.isDismissed()) {
        if (fetchDone) { fetchError ? reportBootError(fetchError) : finishOnce(fetchResult); }
        return;
      }
      if (!introDone || !fetchDone) return;
      if (fetchError) { bootUI.dismiss(); reportBootError(fetchError); return; }

      var m = fetchResult;
      var catCount = m.length;
      var totalItems = m.reduce(function (s, c) { return s + c.count; }, 0);
      bootUI.setProgress(70);
      bootUI.addLine("[data]", "manifest received \u2014 " + catCount + " categories", true, D(160), function () {
        bootUI.setProgress(88);
        bootUI.addLine("[data]", "indexing " + totalItems.toLocaleString() + " test cases\u2026", true, D(220), function () {
          bootUI.setProgress(100);
          bootUI.addLine("[boot]", "access granted.", true, D(200), function () {
            setTimeout(function () { bootUI.dismiss(); finishOnce(m); }, D(420));
          });
        });
      });
    }

    runBootLines(bootUI, [
      { tag: "[boot]", msg: "initializing secure runtime\u2026", ok: false, delay: 140 },
      { tag: "[boot]", msg: "mounting local encrypted store\u2026", ok: true, delay: 240 },
      { tag: "[net ]", msg: "opening checklist data channel\u2026", ok: false, delay: 200 }
    ], function () {
      introDone = true;
      bootUI.setProgress(45);
      tryFinish();
    });

    fetch("data/manifest.json")
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (m) { fetchResult = m; fetchDone = true; tryFinish(); })
      .catch(function (err) { fetchError = err; fetchDone = true; tryFinish(); });
  }

  boot();
})();

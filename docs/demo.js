/* svg2wkt interactive demo — vanilla JS, no dependencies. */
(function () {
  'use strict';

  var svgToWkt = window.svg2wkt && window.svg2wkt.svgToWkt;

  var DEFAULT_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">',
    '  <rect x="12" y="12" width="64" height="44" rx="0" />',
    '  <circle cx="152" cy="44" r="32" />',
    '  <ellipse cx="100" cy="150" rx="52" ry="26" />',
    '  <polygon points="20,118 64,118 42,172" />',
    '  <path d="M118 96 C 142 74, 184 80, 192 120 S 158 184, 116 162 Z" />',
    '  <line x1="8" y1="192" x2="192" y2="192" />',
    '</svg>',
  ].join('\n');

  // --- elements -----------------------------------------------------------
  var $ = function (id) {
    return document.getElementById(id);
  };
  var svgIn = $('svgIn');
  var svgPreview = $('svgPreview');
  var wktOut = $('wktOut');
  var canvas = $('wktCanvas');
  var stat = $('stat');
  var drop = $('drop');

  function options() {
    return {
      flipY: $('flipY').checked,
      applyViewBox: $('applyViewBox').checked,
      density: parseFloat($('density').value) || 0,
      precision: Math.max(0, parseInt($('precision').value, 10) || 0),
    };
  }

  // --- WKT parsing (subset emitted by svg2wkt) ----------------------------
  function splitTop(s) {
    var parts = [];
    var depth = 0;
    var start = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(s.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(s.slice(start));
    return parts;
  }

  function parseCoords(s) {
    return s
      .split(',')
      .map(function (p) {
        var xy = p.trim().split(/\s+/);
        return [parseFloat(xy[0]), parseFloat(xy[1])];
      })
      .filter(function (p) {
        return isFinite(p[0]) && isFinite(p[1]);
      });
  }

  function unwrap(token) {
    return token.slice(token.indexOf('(') + 1, token.lastIndexOf(')'));
  }

  function parseWkt(wkt) {
    var geoms = [];
    var body = wkt.trim();
    var m = body.match(/^GEOMETRYCOLLECTION\s*\(([\s\S]*)\)$/);
    if (m) body = m[1];
    splitTop(body).forEach(function (raw) {
      var t = raw.trim();
      if (!t) return;
      if (t.indexOf('POLYGON') === 0) {
        var rings = splitTop(unwrap(t)).map(function (r) {
          return parseCoords(unwrap(r.trim()));
        });
        geoms.push({ type: 'POLYGON', rings: rings });
      } else if (t.indexOf('LINESTRING') === 0) {
        geoms.push({ type: 'LINESTRING', rings: [parseCoords(unwrap(t))] });
      } else if (t.indexOf('POINT') === 0) {
        geoms.push({ type: 'POINT', rings: [parseCoords(unwrap(t))] });
      }
    });
    return geoms;
  }

  // --- WKT rendering (Y-up cartesian, with zoom & pan) --------------------
  // The view maps world (WKT) coords to CSS pixels:
  //   screenX = x * view.s + view.tx
  //   screenY = -y * view.s + view.ty   (Y-up: larger Y is higher on screen)
  var MIN_SCALE = 1e-4;
  var MAX_SCALE = 1e6;
  var state = { geoms: [], bounds: null, view: null, userZoomed: false };

  function computeBounds(geoms) {
    var b = {
      minX: Infinity,
      minY: Infinity,
      maxX: -Infinity,
      maxY: -Infinity,
      verts: 0,
    };
    geoms.forEach(function (g) {
      g.rings.forEach(function (ring) {
        b.verts += ring.length;
        ring.forEach(function (p) {
          if (p[0] < b.minX) b.minX = p[0];
          if (p[1] < b.minY) b.minY = p[1];
          if (p[0] > b.maxX) b.maxX = p[0];
          if (p[1] > b.maxY) b.maxY = p[1];
        });
      });
    });
    return isFinite(b.minX) ? b : null;
  }

  function canvasSize() {
    return {
      W: canvas.clientWidth || 300,
      H: canvas.clientHeight || 300,
      dpr: window.devicePixelRatio || 1,
    };
  }

  function fitView(bounds, W, H) {
    var pad = 18;
    var bw = Math.max(bounds.maxX - bounds.minX, 1e-6);
    var bh = Math.max(bounds.maxY - bounds.minY, 1e-6);
    var s = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
    var cx = (bounds.minX + bounds.maxX) / 2;
    var cy = (bounds.minY + bounds.maxY) / 2;
    return { s: s, tx: W / 2 - cx * s, ty: H / 2 + cy * s };
  }

  function draw() {
    var size = canvasSize();
    var W = size.W,
      H = size.H,
      dpr = size.dpr;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var v = state.view;
    if (!v) return;
    var sx = function (x) {
      return x * v.s + v.tx;
    };
    var sy = function (y) {
      return -y * v.s + v.ty;
    };
    function trace(ring) {
      ring.forEach(function (p, i) {
        if (i) ctx.lineTo(sx(p[0]), sy(p[1]));
        else ctx.moveTo(sx(p[0]), sy(p[1]));
      });
    }

    var style = getComputedStyle(document.documentElement);
    var POLY = style.getPropertyValue('--poly').trim() || '#6366f1';
    var LINE = style.getPropertyValue('--line').trim() || '#10b981';
    var POINT = style.getPropertyValue('--point').trim() || '#f59e0b';

    state.geoms.forEach(function (g) {
      if (g.type === 'POLYGON') {
        ctx.beginPath();
        g.rings.forEach(function (ring) {
          trace(ring);
          ctx.closePath();
        });
        ctx.fillStyle = 'rgba(99,102,241,0.22)';
        ctx.fill('evenodd');
        ctx.strokeStyle = POLY;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else if (g.type === 'LINESTRING') {
        ctx.beginPath();
        trace(g.rings[0]);
        ctx.strokeStyle = LINE;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else if (g.type === 'POINT' && g.rings[0][0]) {
        var p = g.rings[0][0];
        ctx.beginPath();
        ctx.arc(sx(p[0]), sy(p[1]), 3, 0, Math.PI * 2);
        ctx.fillStyle = POINT;
        ctx.fill();
      }
    });

    if ($('showPoints').checked) {
      ctx.fillStyle = POINT;
      state.geoms.forEach(function (g) {
        g.rings.forEach(function (ring) {
          ring.forEach(function (p) {
            ctx.beginPath();
            ctx.arc(sx(p[0]), sy(p[1]), 1.7, 0, Math.PI * 2);
            ctx.fill();
          });
        });
      });
    }
  }

  function setData(geoms) {
    state.geoms = geoms;
    state.bounds = computeBounds(geoms);
    stat.textContent =
      geoms.length + ' geom · ' + (state.bounds ? state.bounds.verts : 0) + ' vertices';
    if (state.bounds && (!state.view || !state.userZoomed)) {
      var size = canvasSize();
      state.view = fitView(state.bounds, size.W, size.H);
    }
    draw();
  }

  function resetView() {
    state.userZoomed = false;
    if (state.bounds) {
      var size = canvasSize();
      state.view = fitView(state.bounds, size.W, size.H);
    }
    draw();
  }

  // --- main update --------------------------------------------------------
  function update() {
    var src = svgIn.value;

    // Live SVG preview (sanitize away scripts; this is the user's own file).
    svgPreview.innerHTML = src.replace(/<script[\s\S]*?<\/script>/gi, '');

    if (!svgToWkt) {
      wktOut.value = 'Error: svg2wkt failed to load (svg2wkt.js missing?).';
      return;
    }

    try {
      var wkt = svgToWkt(src, options());
      wktOut.value = wkt;
      setData(parseWkt(wkt));
    } catch (e) {
      wktOut.value = 'Error: ' + (e && e.message ? e.message : e);
    }
  }

  // --- file loading -------------------------------------------------------
  function readFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      svgIn.value = String(reader.result);
      state.userZoomed = false; // fit the freshly loaded geometry
      update();
    };
    reader.readAsText(file);
  }

  // --- zoom & pan on the WKT canvas --------------------------------------
  function localPoint(e) {
    var r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  canvas.addEventListener(
    'wheel',
    function (e) {
      e.preventDefault();
      if (!state.view) return;
      var v = state.view;
      var p = localPoint(e);
      var factor = Math.pow(1.0015, -e.deltaY);
      var s2 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.s * factor));
      // Keep the world point under the cursor fixed while zooming.
      var wx = (p.x - v.tx) / v.s;
      var wy = (v.ty - p.y) / v.s;
      v.s = s2;
      v.tx = p.x - wx * s2;
      v.ty = p.y + wy * s2;
      state.userZoomed = true;
      draw();
    },
    { passive: false },
  );

  var dragging = false;
  var lastX = 0;
  var lastY = 0;
  canvas.addEventListener('pointerdown', function (e) {
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.classList.add('panning');
    if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!dragging || !state.view) return;
    state.view.tx += e.clientX - lastX;
    state.view.ty += e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    state.userZoomed = true;
    draw();
  });
  function endPan(e) {
    dragging = false;
    canvas.classList.remove('panning');
    if (canvas.releasePointerCapture && e.pointerId != null) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch (_) {}
    }
  }
  canvas.addEventListener('pointerup', endPan);
  canvas.addEventListener('pointercancel', endPan);
  canvas.addEventListener('dblclick', resetView);
  $('resetViewBtn').addEventListener('click', resetView);

  // --- wiring -------------------------------------------------------------
  ['flipY', 'applyViewBox', 'density', 'precision'].forEach(function (id) {
    $(id).addEventListener('input', update);
    $(id).addEventListener('change', update);
  });
  // Toggling point visibility is a pure redraw — no need to reconvert or refit.
  $('showPoints').addEventListener('change', draw);
  svgIn.addEventListener('input', update);

  $('loadBtn').addEventListener('click', function () {
    $('file').click();
  });
  $('file').addEventListener('change', function (e) {
    readFile(e.target.files[0]);
  });
  $('resetBtn').addEventListener('click', function () {
    svgIn.value = DEFAULT_SVG;
    state.userZoomed = false; // refit the new (default) geometry
    update();
  });
  $('copyBtn').addEventListener('click', function () {
    var btn = $('copyBtn');
    var done = function (ok) {
      btn.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(function () {
        btn.textContent = 'Copy';
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(wktOut.value).then(
        function () {
          done(true);
        },
        function () {
          done(false);
        },
      );
    } else {
      wktOut.select();
      done(document.execCommand && document.execCommand('copy'));
    }
  });

  // Drag & drop anywhere on the page.
  var dragDepth = 0;
  window.addEventListener('dragenter', function (e) {
    e.preventDefault();
    dragDepth++;
    drop.classList.add('active');
  });
  window.addEventListener('dragover', function (e) {
    e.preventDefault();
  });
  window.addEventListener('dragleave', function (e) {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) drop.classList.remove('active');
  });
  window.addEventListener('drop', function (e) {
    e.preventDefault();
    dragDepth = 0;
    drop.classList.remove('active');
    var dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) {
      readFile(dt.files[0]);
    } else if (dt) {
      var text = dt.getData('text');
      if (text) {
        svgIn.value = text;
        state.userZoomed = false;
        update();
      }
    }
  });

  // Keep the canvas mapping correct on resize: refit if untouched, else redraw.
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.bounds && !state.userZoomed) {
        var size = canvasSize();
        state.view = fitView(state.bounds, size.W, size.H);
      }
      draw();
    }, 120);
  });

  // --- init ---------------------------------------------------------------
  svgIn.value = DEFAULT_SVG;
  update();
})();

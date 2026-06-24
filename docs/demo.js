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

  // --- WKT rendering (Y-up cartesian, auto-fit) ---------------------------
  function renderWkt(geoms, showPoints) {
    var ctx = canvas.getContext('2d');
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth || 300;
    var H = canvas.clientHeight || 280;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity,
      verts = 0;
    geoms.forEach(function (g) {
      g.rings.forEach(function (ring) {
        verts += ring.length;
        ring.forEach(function (p) {
          if (p[0] < minX) minX = p[0];
          if (p[1] < minY) minY = p[1];
          if (p[0] > maxX) maxX = p[0];
          if (p[1] > maxY) maxY = p[1];
        });
      });
    });

    stat.textContent =
      geoms.length + ' geom · ' + verts + ' vertices';

    if (!isFinite(minX)) return;

    var pad = 18;
    var bw = Math.max(maxX - minX, 1e-6);
    var bh = Math.max(maxY - minY, 1e-6);
    var scale = Math.min((W - 2 * pad) / bw, (H - 2 * pad) / bh);
    var ox = (W - bw * scale) / 2;
    var oy = (H - bh * scale) / 2;
    var tx = function (x) {
      return ox + (x - minX) * scale;
    };
    // Render Y-up: larger Y maps higher on screen (WKT/geographic convention).
    var ty = function (y) {
      return H - oy - (y - minY) * scale;
    };

    function trace(ring) {
      ring.forEach(function (p, i) {
        var X = tx(p[0]),
          Y = ty(p[1]);
        if (i) ctx.lineTo(X, Y);
        else ctx.moveTo(X, Y);
      });
    }

    var style = getComputedStyle(document.documentElement);
    var POLY = style.getPropertyValue('--poly').trim() || '#6366f1';
    var LINE = style.getPropertyValue('--line').trim() || '#10b981';
    var POINT = style.getPropertyValue('--point').trim() || '#f59e0b';

    geoms.forEach(function (g) {
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
        ctx.arc(tx(p[0]), ty(p[1]), 3, 0, Math.PI * 2);
        ctx.fillStyle = POINT;
        ctx.fill();
      }
    });

    if (showPoints) {
      ctx.fillStyle = POINT;
      geoms.forEach(function (g) {
        g.rings.forEach(function (ring) {
          ring.forEach(function (p) {
            ctx.beginPath();
            ctx.arc(tx(p[0]), ty(p[1]), 1.7, 0, Math.PI * 2);
            ctx.fill();
          });
        });
      });
    }
  }

  // --- main update --------------------------------------------------------
  function update() {
    var src = svgIn.value;

    // Live SVG preview (sanitize away scripts; this is the user's own file).
    svgPreview.innerHTML = src.replace(
      /<script[\s\S]*?<\/script>/gi,
      '',
    );

    if (!svgToWkt) {
      wktOut.value = 'Error: svg2wkt failed to load (svg2wkt.js missing?).';
      return;
    }

    try {
      var wkt = svgToWkt(src, options());
      wktOut.value = wkt;
      renderWkt(parseWkt(wkt), $('showPoints').checked);
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
      update();
    };
    reader.readAsText(file);
  }

  // --- wiring -------------------------------------------------------------
  ['flipY', 'applyViewBox', 'density', 'precision', 'showPoints'].forEach(
    function (id) {
      $(id).addEventListener('input', update);
      $(id).addEventListener('change', update);
    },
  );
  svgIn.addEventListener('input', update);

  $('loadBtn').addEventListener('click', function () {
    $('file').click();
  });
  $('file').addEventListener('change', function (e) {
    readFile(e.target.files[0]);
  });
  $('resetBtn').addEventListener('click', function () {
    svgIn.value = DEFAULT_SVG;
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
        update();
      }
    }
  });

  // Re-fit the canvas when the window resizes.
  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(update, 120);
  });

  // --- init ---------------------------------------------------------------
  svgIn.value = DEFAULT_SVG;
  update();
})();

'use strict';

/**
 * Minimal dependency-free line chart on <canvas>.
 * points: [{ t: timestampMs, value: number|null }] — nulls create gaps.
 * Draws a grid, y-axis labels, an area+line, and a hover crosshair with a
 * tooltip. Emits nothing; caller passes an onHover callback.
 */
function createLineChart(canvas, points, { color = '#4f8cff', onHover = null, emptyText = 'No data in this period' } = {}) {
  const ctx = canvas.getContext('2d');
  let width = 0;
  let height = 0;
  let dpr = 1;
  let hoverIndex = -1;

  const pad = { top: 10, right: 12, bottom: 26, left: 52 };

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = window.devicePixelRatio || 1;
    width = rect.width;
    height = rect.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  const data = () => points.filter((p) => p.value !== null && p.value !== undefined);
  const hasData = () => data().length > 0;

  function niceMax(v) {
    if (v <= 0) return 100;
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / pow;
    const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return nice * pow;
  }

  function draw() {
    const pts = data();
    ctx.clearRect(0, 0, width, height);
    if (!hasData()) {
      ctx.fillStyle = getComputedStyle(canvas).getPropertyValue('--text-faint') || '#5c6b83';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(emptyText, width / 2, height / 2);
      return;
    }

    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const span = Math.max(t1 - t0, 1);

    const maxRaw = Math.max(...pts.map((p) => p.value));
    const yMax = niceMax(maxRaw * 1.1);
    const yMin = 0;

    const xFor = (t) => pad.left + ((t - t0) / span) * chartW;
    const yFor = (v) => pad.top + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

    // Grid + y labels
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const gridColor = 'rgba(255,255,255,0.06)';
    const tickCount = 4;
    for (let i = 0; i <= tickCount; i++) {
      const v = (yMax / tickCount) * i;
      const y = yFor(v);
      ctx.strokeStyle = gridColor;
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      const label = v >= 1000 ? `${(v / 1000).toFixed(v % 1000 === 0 ? 0 : 1)}s` : `${Math.round(v)}ms`;
      ctx.fillText(label, pad.left - 6, y);
    }

    // X labels (first, middle, last)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    const xLabels = [points[0], points[Math.floor((points.length - 1) / 2)], points[points.length - 1]];
    for (const p of xLabels) {
      ctx.fillText(fmtClock(p.t), xFor(p.t), pad.top + chartH + 8);
    }

    // Area fill
    const linePath = () => {
      let started = false;
      ctx.beginPath();
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.value === null) {
          started = false;
          continue;
        }
        const x = xFor(p.t);
        const y = yFor(p.value);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
    };

    const makeArea = () => {
      const cmds = [];
      let started = false;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p.value === null) {
          started = false;
          continue;
        }
        const x = xFor(p.t);
        const y = yFor(p.value);
        if (!started) {
          cmds.push(['move', x, y]);
          started = true;
        } else {
          cmds.push(['line', x, y]);
        }
      }
      return cmds;
    };

    // Fill segments
    const area = makeArea();
    if (area.length > 0) {
      ctx.beginPath();
      const runs = [];
      let run = [];
      for (const [op, x, y] of area) {
        if (op === 'move') {
          if (run.length > 0) runs.push(run);
          run = [[x, y]];
        } else {
          run.push([x, y]);
        }
      }
      if (run.length > 0) runs.push(run);
      for (const seg of runs) {
        ctx.beginPath();
        ctx.moveTo(seg[0][0], yFor(0));
        for (const [x, y] of seg) ctx.lineTo(x, y);
        ctx.lineTo(seg[seg.length - 1][0], yFor(0));
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, pad.top, 0, pad.top + chartH);
        grad.addColorStop(0, `${color}38`);
        grad.addColorStop(1, `${color}00`);
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    // Line
    linePath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    // Points
    for (const p of data()) {
      ctx.beginPath();
      ctx.arc(xFor(p.t), yFor(p.value), 2.2, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // Hover
    if (hoverIndex >= 0) drawHover();
  }

  function drawHover() {
    const p = points[hoverIndex];
    if (!p || p.value === null) return;
    const chartW = width - pad.left - pad.right;
    const chartH = height - pad.top - pad.bottom;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const span = Math.max(t1 - t0, 1);
    const maxRaw = Math.max(...data().map((q) => q.value));
    const yMax = niceMax(maxRaw * 1.1);
    const x = pad.left + ((p.t - t0) / span) * chartW;
    const y = pad.top + chartH - ((p.value - 0) / (yMax - 0)) * chartH;

    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(x, pad.top);
    ctx.lineTo(x, pad.top + chartH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < points.length; i++) {
      if (points[i].value === null) continue;
      const p = points[i];
      const t0 = points[0].t;
      const t1 = points[points.length - 1].t;
      const span = Math.max(t1 - t0, 1);
      const x = pad.left + ((p.t - t0) / span) * (rect.width - pad.left - pad.right);
      const d = Math.abs(x - mx);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    if (best !== hoverIndex) {
      hoverIndex = best;
      draw();
      if (onHover && best >= 0) onHover(points[best], e);
    }
  }

  function onMouseLeave() {
    hoverIndex = -1;
    draw();
    if (onHover) onHover(null);
  }

  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseleave', onMouseLeave);
  window.addEventListener('resize', resize);

  resize();

  return {
    update(newPoints) {
      points = newPoints;
      draw();
    },
    destroy() {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
    },
  };
}

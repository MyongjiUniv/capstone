/* 팔당호 수온 예측 대시보드
 * - data/*.json(scripts/build_data.py가 만든 자료)을 읽어 그린다.
 * - 지도는 최종 모형 E2-A(CatBoost 대칭 나무)를 브라우저에서 직접 계산한다.
 * - 선택 상태(날짜, 측정망 지점)는 주소의 #date=…&site=… 에 남아 링크로 공유할 수 있다.
 */
(() => {
  'use strict';

  const FILES = ['model_trees', 'model_info', 'lake_geometry', 'daily', 'station_daily', 'survey_cells', 'scores', 'test_diff', 'survey_scores', 'importance'];
  const DEFAULT = { date: '2025-07-11', site: '팔당댐4' };
  const RAMP = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026'];
  const ramp = d3.piecewise(d3.interpolateRgb, RAMP);
  const D = {};                       // 자료
  const S = { ...DEFAULT };           // 선택 상태

  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const has = (v) => v !== null && v !== undefined && v !== '';
  const dateLabel = (d) => d.replaceAll('-', '.');
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  // ---------------------------------------------------------------- 상태와 주소
  const readHash = () => {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('date')) S.date = p.get('date');
    if (p.get('site')) S.site = p.get('site');
  };
  const writeHash = () => {
    const p = new URLSearchParams({ date: S.date, site: S.site });
    history.replaceState(null, '', '#' + p.toString());
  };
  const setState = (patch) => {
    Object.assign(S, patch);
    if (D.daily) S.date = clampDate(S.date);
    writeHash();
    render();
  };
  const clampDate = (d) => {
    const a = D.daily[0].date, b = D.daily[D.daily.length - 1].date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return DEFAULT.date;
    return d < a ? a : d > b ? b : d;
  };
  const shift = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  // ---------------------------------------------------------------- 숫자 채우기
  const fmt = (v, f) => {
    if (f === 'text') return String(v);
    const n = num(v);
    if (!Number.isFinite(n)) return '—';
    if (f === ',') return d3.format(',')(n);
    if (f === '0') return d3.format('d')(n);
    if (f && f[0] === 's') return d3.format('+.' + f.slice(1) + 'f')(n);
    return d3.format('.' + (f || '2') + 'f')(n);
  };
  const pick = (rows, where, row) => {
    if (!rows) return undefined;
    if (has(row)) return rows[Number(row)];
    if (!where) return undefined;
    const conds = where.split('&').map((p) => p.split('=').map(decodeURIComponent));
    return rows.find((r) => conds.every(([k, v]) => String(r[k]) === v));
  };
  const fillValues = () => {
    $$('[data-src]').forEach((el) => {
      let where = el.dataset.where;
      if (el.dataset.tmpl) where = el.dataset.tmpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(S[k] ?? ''));
      const r = pick(D[el.dataset.src], where, el.dataset.row);
      const v = r ? r[el.dataset.field] : null;
      el.textContent = has(v) ? fmt(v, el.dataset.fmt) : '—';
    });
  };

  // ---------------------------------------------------------------- 모형(CatBoost 대칭 나무)
  const f32 = (v) => { const n = num(v); return Number.isFinite(n) ? Math.fround(n) : -Infinity; };   // 결측 = 가장 낮은 값
  const buildModel = () => {
    const rows = D.model_trees, info = D.model_info[0];
    const T = rows.length, depth = rows[0].f.length, L = 1 << depth;
    const F = new Int8Array(T * depth), B = new Float32Array(T * depth), V = new Float64Array(T * L);
    rows.forEach((r, k) => {
      for (let i = 0; i < depth; i++) { F[k * depth + i] = r.f[i]; B[k * depth + i] = r.b[i]; }
      for (let i = 0; i < L; i++) V[k * L + i] = r.v[i];
    });
    const scale = num(info.scale), bias = num(info.bias);
    const predict = (x) => {
      let s = 0;
      for (let k = 0; k < T; k++) {
        let idx = 0;
        for (let i = 0; i < depth; i++) if (x[F[k * depth + i]] > B[k * depth + i]) idx |= 1 << i;
        s += V[k * L + idx];
      }
      return bias + scale * s;
    };
    return { predict, hourFrom: num(info.hour_from), hourTo: num(info.hour_to), cache: new Map() };
  };
  const dayPhase = (date) => {
    const [y, m, d] = date.split('-').map(Number);
    const doy = (Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 864e5 + 1;
    const L = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365;
    const ph = 2 * Math.PI * (doy - 1) / L;
    return [Math.sin(ph), Math.cos(ph)];
  };
  const dayRow = () => D.daily.find((r) => r.date === S.date) || null;
  // 선택한 날짜의 예측장: 격자마다 hour_from~hour_to시 매시 예측의 평균
  const field = () => {
    const M = D.model, day = dayRow();
    if (!day) return null;
    if (M.cache.has(day.date)) return M.cache.get(day.date);
    const [ds, dc] = dayPhase(day.date), up = [f32(day.up_bukhan), f32(day.up_namhan), f32(day.up_gyeongan)];
    const cells = D.geo.cells, out = new Float64Array(cells.length), nh = M.hourTo - M.hourFrom + 1, x = new Float64Array(9);
    for (let h = M.hourFrom; h <= M.hourTo; h++) {
      const ph = 2 * Math.PI * h / 24;
      x[2] = f32(ds); x[3] = f32(dc); x[4] = f32(Math.sin(ph)); x[5] = f32(Math.cos(ph)); x[6] = up[0]; x[7] = up[1]; x[8] = up[2];
      for (let i = 0; i < cells.length; i++) { x[0] = f32(cells[i].x); x[1] = f32(cells[i].y); out[i] += M.predict(x) / nh; }
    }
    M.cache.set(day.date, out);
    return out;
  };
  const obsCells = () => D.survey_cells.filter((r) => r.date === S.date).map((r) => ({ x: num(r.x), y: num(r.y), v: num(r.obs), n: num(r.n) }));
  const colorDomain = (f, obs) => {
    const vals = Array.from(f).concat(obs.map((c) => c.v));
    const lo = Math.floor(d3.min(vals) * 2) / 2, hi = Math.ceil(d3.max(vals) * 2) / 2;
    return [lo, hi === lo ? lo + 0.5 : hi];
  };

  // ---------------------------------------------------------------- 공통: 말풍선
  const tipOf = (box) => {
    let t = box.querySelector('.pw-tip');
    if (!t) { t = document.createElement('div'); t.className = 'pw-tip'; t.hidden = true; box.appendChild(t); }
    return t;
  };
  const showTip = (box, tip, lines, mx, my) => {
    tip.replaceChildren(...lines.map((s, i) => { const d = document.createElement('div'); if (i === 0) d.className = 'pw-tip-h'; d.textContent = s; return d; }));
    tip.hidden = false;
    const bw = box.clientWidth, tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = mx + 12, top = my - th - 8;
    if (left + tw > bw) left = mx - tw - 12;
    if (left < 0) left = 0;
    if (top < 0) top = my + 14;
    tip.style.left = left + 'px'; tip.style.top = top + 'px';
  };
  const axisClean = (g) => g.attr('font-size', null).attr('font-family', null);

  // ---------------------------------------------------------------- 지도
  const drawMap = (el, cells, colorOf, label, stroke) => {
    const geo = D.geo, [x0, x1, y0, y1] = geo.ext, aspect = (y1 - y0) / (x1 - x0);
    let w = el.clientWidth || 300, h = w * aspect;
    if (h > 560) { h = 560; w = h / aspect; }
    const k = w / (x1 - x0), px = (x) => (x - x0) * k, py = (y) => (y1 - y) * k;
    const svg = d3.select(el).selectAll('svg').data([0]).join('svg')
      .attr('viewBox', `0 0 ${w} ${h}`).attr('width', '100%').attr('height', h)
      .style('max-width', w + 'px').style('display', 'block').style('margin-inline', 'auto')
      .attr('role', 'img').attr('aria-label', label);
    const line = d3.line().x((p) => px(p.x)).y((p) => py(p.y));
    svg.selectAll('path.pw-lakebg').data([geo.outline]).join('path').attr('class', 'pw-lakebg')
      .attr('d', (d) => line(d) + 'Z').style('fill', 'var(--bg)').style('stroke', 'none');
    const s = Math.max(1, 100 * k);
    svg.selectAll('rect.pw-cell').data(cells).join('rect').attr('class', 'pw-cell')
      .attr('x', (c) => px(c.x) - s / 2).attr('y', (c) => py(c.y) - s / 2).attr('width', s + 0.4).attr('height', s + 0.4)
      .style('fill', (c) => colorOf(c.v)).style('stroke', stroke ? 'var(--fg)' : 'none').style('stroke-width', stroke ? 0.3 : 0);
    svg.selectAll('path.pw-lake').data([geo.outline]).join('path').attr('class', 'pw-lake')
      .attr('d', (d) => line(d) + 'Z').style('fill', 'none').style('stroke', 'var(--muted)').style('stroke-width', 1).raise();
    svg.selectAll('path.pw-lakebg').lower();
    const tip = tipOf(el);
    svg.on('pointermove', (ev) => {
      const [mx, my] = d3.pointer(ev, el), [sx, sy] = d3.pointer(ev, svg.node());
      const vb = w / svg.node().getBoundingClientRect().width;
      const ux = sx * vb / k + x0, uy = y1 - sy * vb / k;
      let best = null, bd = Infinity;
      for (const c of cells) { const d = Math.abs(c.x - ux) + Math.abs(c.y - uy); if (d < bd) { bd = d; best = c; } }
      if (!best || bd > 160) { tip.hidden = true; return; }
      showTip(el, tip, [label, d3.format('.2f')(best.v) + ' °C' + (best.n ? ` · 기록 ${best.n}개` : '')], mx, my);
    }).on('pointerleave', () => { tip.hidden = true; });
  };
  const drawLegend = (el, dom) => {
    const w = Math.min(el.clientWidth || 300, 520), h = 40, m = { l: 12, r: 28 };
    const svg = d3.select(el).selectAll('svg').data([0]).join('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('width', '100%').attr('height', h)
      .style('max-width', w + 'px').style('display', 'block').attr('role', 'img').attr('aria-label', `색 범위 ${dom[0]}~${dom[1]} °C`);
    const grad = svg.selectAll('defs').data([0]).join('defs').selectAll('linearGradient').data([0]).join('linearGradient').attr('id', 'pw-ramp');
    grad.selectAll('stop').data(d3.range(11)).join('stop').attr('offset', (i) => i / 10).style('stop-color', (i) => ramp(i / 10));
    svg.selectAll('rect.pw-bar').data([0]).join('rect').attr('class', 'pw-bar').attr('x', m.l).attr('y', 4)
      .attr('width', w - m.l - m.r).attr('height', 10).attr('rx', 2).style('fill', 'url(#pw-ramp)');
    const x = d3.scaleLinear().domain(dom).range([m.l, w - m.r]);
    svg.selectAll('g.pw-axis').data([0]).join('g').attr('class', 'pw-axis').attr('transform', 'translate(0,16)')
      .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor((w - 40) / 70))).tickFormat((v) => d3.format('.1f')(v)).tickSizeOuter(0)).call(axisClean);
    svg.selectAll('text.pw-unit').data([0]).join('text').attr('class', 'pw-unit').attr('x', w - 2).attr('y', 13).attr('text-anchor', 'end').text('°C');
  };
  const renderMaps = () => {
    const f = field(), pred = document.getElementById('pw-map-pred'), obsEl = document.getElementById('pw-map-obs');
    if (!f) return;
    const obs = obsCells(), dom = colorDomain(f, obs);
    const scale = d3.scaleLinear().domain(dom).range([0, 1]).clamp(true), colorOf = (v) => ramp(scale(v));
    drawMap(pred, D.geo.cells.map((c, i) => ({ x: c.x, y: c.y, v: f[i] })), colorOf, '예측 · 09~17시 평균', false);
    if (obs.length) drawMap(obsEl, obs, colorOf, '관측 · 수표면 셀 평균', true);
    drawLegend(document.getElementById('pw-legend'), dom);
  };

  // ---------------------------------------------------------------- 측정망 지점
  const stationErrors = (rows) => {
    const g = new Map();
    for (const r of rows) {
      if (!has(r.obs)) continue;
      const period = r.stage === '최종시험' ? '최종시험' : '학습 기간';
      const key = r.site + '|' + period, e = num(r.pred_at_obs) - num(r.obs);
      const a = g.get(key) || { site: r.site, period, days: 0, se: 0, sb: 0 };
      a.days += 1; a.se += e * e; a.sb += e; g.set(key, a);
    }
    return Array.from(g.values()).map((a) => ({ site: a.site, period: a.period, days: a.days, rmse: Math.sqrt(a.se / a.days), bias: a.sb / a.days }));
  };
  const renderStation = () => {
    const el = document.getElementById('pw-station-chart');
    const rows = D.station_daily.filter((r) => r.site === S.site).map((r) => ({ t: new Date(r.date + 'T00:00:00Z'), date: r.date, stage: r.stage,
      p: num(r.pred_day), o: num(r.obs), po: num(r.pred_at_obs), miss: num(r.missing_inputs) }));
    if (!rows.length) { d3.select(el).selectAll('svg').remove(); return; }
    const W = el.clientWidth || 600, H = 288, m = { t: 22, r: 14, b: 26, l: 40 };
    const svg = d3.select(el).selectAll('svg').data([0]).join('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').attr('height', H)
      .style('display', 'block').attr('role', 'img').attr('aria-label', `${S.site} 예측과 관측 시계열`);
    const x = d3.scaleUtc(d3.extent(rows, (r) => r.t), [m.l, W - m.r]);
    const vals = rows.flatMap((r) => [r.p, r.o]).filter(Number.isFinite);
    const y = d3.scaleLinear(d3.extent(vals), [H - m.b, m.t]).nice();
    const train = rows.filter((r) => r.stage !== '최종시험'), t0 = train.length ? train[train.length - 1].t : null;
    svg.selectAll('rect.pw-band').data(t0 ? [0] : []).join('rect').attr('class', 'pw-band')
      .attr('x', m.l).attr('y', m.t).attr('width', Math.max(0, x(t0) - m.l)).attr('height', H - m.t - m.b).style('fill', 'var(--band)');
    svg.selectAll('text.pw-bandlab').data(t0 ? [['최종 모형 학습 기간', m.l + 4], ['최종시험', x(t0) + 4]] : []).join('text').attr('class', 'pw-bandlab')
      .attr('x', (d) => d[1]).attr('y', 14).text((d) => d[0]);
    svg.selectAll('g.pw-gridline').data([0]).join('g').attr('class', 'pw-gridline').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat('')).call(axisClean);
    svg.selectAll('g.pw-ax-x').data([0]).join('g').attr('class', 'pw-axis pw-ax-x').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).ticks(Math.max(2, Math.floor((W - m.l - m.r) / 80))).tickFormat(d3.utcFormat('%y.%m')).tickSizeOuter(0)).call(axisClean);
    svg.selectAll('g.pw-ax-y').data([0]).join('g').attr('class', 'pw-axis pw-ax-y').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0)).call(axisClean);
    const ln = d3.line().defined((r) => Number.isFinite(r.p) && !(r.miss > 0)).x((r) => x(r.t)).y((r) => y(r.p));
    svg.selectAll('path.pw-pred').data([rows]).join('path').attr('class', 'pw-pred').attr('d', ln)
      .style('fill', 'none').style('stroke', 'var(--accent)').style('stroke-width', 1.5).style('stroke-linejoin', 'round').style('stroke-linecap', 'round');
    svg.selectAll('circle.pw-obs').data(rows.filter((r) => Number.isFinite(r.o))).join('circle').attr('class', 'pw-obs')
      .attr('cx', (r) => x(r.t)).attr('cy', (r) => y(r.o)).attr('r', 2.6).style('fill', 'var(--fg)').style('stroke', 'var(--panel)').style('stroke-width', 0.8);
    const cur = rows.find((r) => r.date === S.date);
    svg.selectAll('line.pw-cur').data(cur ? [cur] : []).join('line').attr('class', 'pw-cur')
      .attr('x1', (r) => x(r.t)).attr('x2', (r) => x(r.t)).attr('y1', m.t).attr('y2', H - m.b)
      .style('stroke', 'var(--warn)').style('stroke-width', 1).style('stroke-dasharray', '3 3');
    const tip = tipOf(el);
    const near = (ev) => {
      const [sx] = d3.pointer(ev, svg.node()), vb = W / svg.node().getBoundingClientRect().width;
      return rows[d3.bisector((r) => r.t).center(rows, x.invert(sx * vb))];
    };
    svg.style('cursor', 'pointer').on('pointermove', (ev) => {
      const r = near(ev); if (!r) return;
      const [mx, my] = d3.pointer(ev, el);
      const lines = [`${dateLabel(r.date)} · ${r.stage}`, `예측(09~17시 평균) ${Number.isFinite(r.p) && !(r.miss > 0) ? d3.format('.2f')(r.p) + ' °C' : '상류 수온 결측'}`];
      if (Number.isFinite(r.o)) lines.push(`관측(층 평균) ${d3.format('.2f')(r.o)} °C`, `관측 시각 예측 ${d3.format('.2f')(r.po)} °C`);
      showTip(el, tip, lines, mx, my);
    }).on('pointerleave', () => { tip.hidden = true; })
      .on('click', (ev) => { const r = near(ev); if (r) setState({ date: r.date }); });
  };

  // ---------------------------------------------------------------- 조사일별 오차
  const renderSurveys = () => {
    const el = document.getElementById('pw-survey-chart');
    const rows = D.survey_scores.map((r) => ({ s: String(r.survey), date: r.date, check: r.check, e: num(r.e2a), gm: num(r.gam) }));
    const W = el.clientWidth || 600, H = 288, m = { t: 22, r: 10, b: 26, l: 36 };
    const svg = d3.select(el).selectAll('svg').data([0]).join('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').attr('height', H)
      .style('display', 'block').attr('role', 'img').attr('aria-label', '조사일별 균형 RMSE');
    const x = d3.scaleBand(rows.map((r) => r.s), [m.l, W - m.r]).paddingInner(0.25).paddingOuter(0.1);
    const xi = d3.scaleBand(['e', 'gm'], [0, x.bandwidth()]).padding(0.08);
    const y = d3.scaleLinear([0, d3.max(rows, (r) => Math.max(r.e, r.gm))], [H - m.b, m.t]).nice();
    const test = rows.filter((r) => r.check === '최종시험');
    const tx = test.length ? x(test[0].s) - x.step() * x.paddingInner() / 2 : null;
    svg.selectAll('rect.pw-band').data(tx ? [0] : []).join('rect').attr('class', 'pw-band').attr('x', tx).attr('y', m.t)
      .attr('width', W - m.r - tx).attr('height', H - m.t - m.b).style('fill', 'var(--band)');
    svg.selectAll('text.pw-bandlab').data(tx ? [['조사일 제외 검증(LOSO)', m.l + 2], ['최종시험', tx + 4]] : []).join('text').attr('class', 'pw-bandlab')
      .attr('x', (d) => d[1]).attr('y', 14).text((d) => d[0]);
    svg.selectAll('g.pw-gridline').data([0]).join('g').attr('class', 'pw-gridline').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)).tickFormat('')).call(axisClean);
    const every = x.bandwidth() < 16 ? 2 : 1;
    svg.selectAll('g.pw-ax-x').data([0]).join('g').attr('class', 'pw-axis pw-ax-x').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickValues(x.domain().filter((_, i) => i % every === 0)).tickFormat((s) => s + '차').tickSizeOuter(0)).call(axisClean);
    svg.selectAll('g.pw-ax-y').data([0]).join('g').attr('class', 'pw-axis pw-ax-y').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(5).tickSizeOuter(0)).call(axisClean);
    svg.selectAll('text.pw-ylab').data([0]).join('text').attr('class', 'pw-ylab').attr('x', m.l - 4).attr('y', m.t - 8).attr('text-anchor', 'end').text('°C');
    const isSurvey = rows.some((r) => r.date === S.date);
    const bars = rows.flatMap((r) => [{ r, k: 'e', v: r.e }, { r, k: 'gm', v: r.gm }]);
    svg.selectAll('rect.pw-sbar').data(bars).join('rect').attr('class', 'pw-sbar')
      .attr('x', (d) => x(d.r.s) + xi(d.k)).attr('width', xi.bandwidth()).attr('y', (d) => y(d.v)).attr('height', (d) => y(0) - y(d.v)).attr('rx', 1.5)
      .style('fill', (d) => (d.k === 'e' ? 'var(--accent)' : 'var(--muted-bar)'))
      .style('opacity', (d) => (isSurvey && d.r.date !== S.date ? 0.4 : 1)).style('cursor', 'pointer');
    const tip = tipOf(el);
    svg.selectAll('rect.pw-sbar').on('pointermove', (ev, d) => {
      const [mx, my] = d3.pointer(ev, el);
      showTip(el, tip, [`${d.r.s}차 · ${dateLabel(d.r.date)} · ${d.r.check}`, `E2-A ${d3.format('.2f')(d.r.e)} °C`, `GAM ${d3.format('.2f')(d.r.gm)} °C`], mx, my);
    }).on('pointerleave', () => { tip.hidden = true; }).on('click', (ev, d) => setState({ date: d.r.date }));
  };

  // ---------------------------------------------------------------- 중요도
  const renderImportance = () => {
    const el = document.getElementById('pw-importance');
    const rows = D.importance.map((r) => ({ k: String(r.variable), v: num(r.share) })).sort((a, b) => b.v - a.v);
    const W = el.clientWidth || 400, rowH = 24, H = rows.length * rowH + 8;
    const svg = d3.select(el).selectAll('svg').data([0]).join('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%').attr('height', H)
      .style('display', 'block').attr('role', 'img').attr('aria-label', '입력별 중요도');
    const labs = svg.selectAll('text.pw-ilab').data(rows).join('text').attr('class', 'pw-ilab').attr('y', (d, i) => i * rowH + 16).text((d) => d.k);
    const lw = d3.max(labs.nodes(), (n) => n.getComputedTextLength()) || 120;
    labs.attr('x', lw + 4).attr('text-anchor', 'end');
    const x = d3.scaleLinear([0, d3.max(rows, (d) => d.v)], [lw + 12, W - 44]);
    svg.selectAll('rect.pw-ibar').data(rows).join('rect').attr('class', 'pw-ibar').attr('x', x(0)).attr('y', (d, i) => i * rowH + 5)
      .attr('width', (d) => Math.max(1, x(d.v) - x(0))).attr('height', 14).attr('rx', 2)
      .style('fill', (d, i) => (i < 4 ? 'var(--accent)' : 'var(--muted-bar)'));
    svg.selectAll('text.pw-ival').data(rows).join('text').attr('class', 'pw-ival').attr('x', (d) => x(d.v) + 4).attr('y', (d, i) => i * rowH + 16)
      .text((d) => d3.format('.1f')(d.v));
  };

  // ---------------------------------------------------------------- 컨트롤과 전체 그리기
  const setupControls = () => {
    const dateEl = document.getElementById('pw-date');
    dateEl.min = D.daily[0].date; dateEl.max = D.daily[D.daily.length - 1].date;
    dateEl.addEventListener('change', () => { if (dateEl.value && dateEl.validity.valid) setState({ date: dateEl.value }); });
    dateEl.addEventListener('blur', () => { dateEl.value = S.date; });
    $$('.pw-step').forEach((b) => b.addEventListener('click', () => setState({ date: shift(S.date, Number(b.dataset.step)) })));
    const sv = document.getElementById('pw-survey');
    const surveys = D.daily.filter((r) => has(r.survey));
    sv.replaceChildren(new Option('조사일로 이동', ''), ...surveys.map((r) => new Option(`${r.survey}차 · ${dateLabel(r.date)} · ${r.stage}`, r.date)));
    sv.addEventListener('change', () => { if (sv.value) setState({ date: sv.value }); });
    const site = document.getElementById('pw-site');
    site.replaceChildren(...D.geo.stations.map((s) => new Option(s.id, s.id)));
    site.addEventListener('change', () => setState({ site: site.value }));
    window.addEventListener('hashchange', () => { readHash(); S.date = clampDate(S.date); render(); });
  };
  const render = () => {
    const day = dayRow(), isSurvey = !!(day && has(day.survey));
    const dateEl = document.getElementById('pw-date');
    if (dateEl !== document.activeElement) dateEl.value = S.date;
    const sv = document.getElementById('pw-survey');
    sv.value = isSurvey ? S.date : '';
    document.getElementById('pw-site').value = S.site;
    $$('[data-stage]').forEach((e) => { e.hidden = !day || e.dataset.stage !== day.stage; });
    document.getElementById('pw-missing').hidden = !day || !(num(day.missing_inputs) > 0);
    document.getElementById('pw-map-obs').hidden = !isSurvey;
    document.getElementById('pw-obs-none').hidden = isSurvey;
    fillValues();
    renderMaps();
    renderStation();
    renderSurveys();
  };
  const renderCharts = () => { renderMaps(); renderStation(); renderSurveys(); renderImportance(); };

  const fail = (msg) => {
    const e = document.getElementById('pw-error');
    e.textContent = msg; e.hidden = false;
  };

  const start = async () => {
    readHash();
    try {
      const got = await Promise.all(FILES.map((f) => fetch(`data/${f}.json`).then((r) => {
        if (!r.ok) throw new Error(`data/${f}.json (${r.status})`);
        return r.json();
      })));
      FILES.forEach((f, i) => { D[f] = got[i]; });
    } catch (err) {
      fail(location.protocol === 'file:'
        ? '파일을 직접 열면 브라우저가 자료(data/*.json)를 읽지 못한다. 이 폴더에서 python -m http.server 8000 을 실행한 뒤 http://localhost:8000 으로 연다.'
        : `자료를 읽지 못했다: ${err.message}`);
      return;
    }
    const pts = (k) => D.lake_geometry.filter((r) => r.kind === k).map((r) => ({ id: r.id, x: num(r.x), y: num(r.y) }));
    const outline = pts('outline'), xs = outline.map((p) => p.x), ys = outline.map((p) => p.y);
    D.geo = { cells: pts('grid'), outline, stations: pts('station'), ext: [d3.min(xs) - 150, d3.max(xs) + 150, d3.min(ys) - 150, d3.max(ys) + 150] };
    D.station_errors = stationErrors(D.station_daily);
    D.model = buildModel();
    if (!D.geo.stations.some((s) => s.id === S.site)) S.site = DEFAULT.site;
    S.date = clampDate(S.date);
    setupControls();
    render();
    renderImportance();
    writeHash();
    let w = document.querySelector('.pw').clientWidth, raf = 0;
    new ResizeObserver(() => {
      const nw = document.querySelector('.pw').clientWidth;
      if (nw === w) return;
      w = nw; cancelAnimationFrame(raf); raf = requestAnimationFrame(renderCharts);
    }).observe(document.querySelector('.pw'));
  };
  start();
})();

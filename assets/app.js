/* 팔당호 수온 예측 대시보드
 * - data/*.json(scripts/build_data.py가 만든 자료)을 읽어 그린다.
 * - 지도는 최종 모형 E2-A(CatBoost 대칭 나무)를 브라우저에서 직접 계산한다.
 * - 화면은 소개 · 예측 지도 · 모델 성능 · 유역·자료 네 탭이다.
 * - 선택 상태(탭, 날짜, 측정망 지점, 목표)는 주소의 #tab=…&date=…&site=…&target=… 에 남아 링크로 공유할 수 있다.
 * - 유역도 자료(data/basin.json, scripts/build_basin.py가 만듦)는 없어도 나머지 화면은 그대로 동작한다.
 */
(() => {
  'use strict';

  const FILES = ['model_trees', 'model_info', 'lake_geometry', 'daily', 'station_daily', 'scores', 'test_diff', 'survey_scores', 'importance', 'model_comparison'];
  // 현장 계측 셀 자료(survey_cells.json)는 model_info의 field_cells가 true일 때만 읽는다. 공개용에는 없고, 없으면 관측 패널을 숨긴다.
  const TABS = ['intro', 'map', 'models', 'basin'];
  const DEFAULT = { tab: 'intro', date: '2025-07-11', site: '팔당댐4', target: 'Temp' };
  const RAMP = ['#313695', '#4575b4', '#74add1', '#abd9e9', '#e0f3f8', '#ffffbf', '#fee090', '#fdae61', '#f46d43', '#d73027', '#a50026'];
  const ramp = d3.piecewise(d3.interpolateRgb, RAMP);
  const D = {};                       // 자료
  const S = { ...DEFAULT };           // 선택 상태

  const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
  const has = (v) => v !== null && v !== undefined && v !== '';
  const dateLabel = (d) => d.replaceAll('-', '.');
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

  // ---------------------------------------------------------------- 상태와 주소
  const readHash = () => {
    const p = new URLSearchParams(location.hash.slice(1));
    if (p.get('date')) S.date = p.get('date');
    if (p.get('site')) S.site = p.get('site');
    if (p.get('target') === 'EC' || p.get('target') === 'Temp') S.target = p.get('target');
    if (TABS.includes(p.get('tab'))) S.tab = p.get('tab');
    else if (p.get('date') || p.get('site')) S.tab = 'map';       // 탭이 없던 예전 공유 링크는 예측 지도로 연다
  };
  const writeHash = () => {
    const p = new URLSearchParams({ tab: S.tab, date: S.date, site: S.site, target: S.target });
    history.replaceState(null, '', '#' + p.toString());
  };
  const setState = (patch) => {
    const tabChanged = patch.tab && patch.tab !== S.tab;
    Object.assign(S, patch);
    if (D.daily) S.date = clampDate(S.date);
    writeHash();
    showTab(tabChanged);
    render();
  };
  const clampDate = (d) => {
    const a = D.daily[0].date, b = D.daily[D.daily.length - 1].date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '')) return DEFAULT.date;
    return d < a ? a : d > b ? b : d;
  };
  const shift = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

  // ---------------------------------------------------------------- 탭
  const showTab = (scroll) => {
    $$('.pw-tabs [data-tab]').forEach((b) => {
      const on = b.dataset.tab === S.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    $$('.pw-panel').forEach((p) => { p.hidden = p.dataset.panel !== S.tab; });
    if (scroll) {
      const nav = document.querySelector('.pw-tabs');
      if (nav.getBoundingClientRect().top < 0) nav.scrollIntoView({ block: 'start' });
    }
  };

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
    $$('[data-src]').forEach((e) => {
      let where = e.dataset.where;
      if (e.dataset.tmpl) where = e.dataset.tmpl.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(S[k] ?? ''));
      const r = pick(D[e.dataset.src], where, e.dataset.row);
      const v = r ? r[e.dataset.field] : null;
      e.textContent = has(v) ? fmt(v, e.dataset.fmt) : '—';
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
  const obsCells = () => (D.survey_cells || []).filter((r) => r.date === S.date).map((r) => ({ x: num(r.x), y: num(r.y), v: num(r.obs), n: num(r.n) }));
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
  const svgIn = (box, W, H, label) => d3.select(box).selectAll('svg').data([0]).join('svg').attr('viewBox', `0 0 ${W} ${H}`)
    .attr('width', '100%').attr('height', H).style('display', 'block').attr('role', 'img').attr('aria-label', label);

  // ---------------------------------------------------------------- 예측 지도
  const drawMap = (box, cells, colorOf, label, stroke) => {
    const geo = D.geo, [x0, x1, y0, y1] = geo.ext, aspect = (y1 - y0) / (x1 - x0);
    let w = box.clientWidth || 300, h = w * aspect;
    if (h > 560) { h = 560; w = h / aspect; }
    const k = w / (x1 - x0), px = (x) => (x - x0) * k, py = (y) => (y1 - y) * k;
    const svg = d3.select(box).selectAll('svg').data([0]).join('svg')
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
    const tip = tipOf(box);
    svg.on('pointermove', (ev) => {
      const [mx, my] = d3.pointer(ev, box), [sx, sy] = d3.pointer(ev, svg.node());
      const vb = w / svg.node().getBoundingClientRect().width;
      const ux = sx * vb / k + x0, uy = y1 - sy * vb / k;
      let best = null, bd = Infinity;
      for (const c of cells) { const d = Math.abs(c.x - ux) + Math.abs(c.y - uy); if (d < bd) { bd = d; best = c; } }
      if (!best || bd > 160) { tip.hidden = true; return; }
      showTip(box, tip, [label, d3.format('.2f')(best.v) + ' °C' + (best.n ? ` · 기록 ${best.n}개` : '')], mx, my);
    }).on('pointerleave', () => { tip.hidden = true; });
  };
  const drawLegend = (box, dom) => {
    const w = Math.min(box.clientWidth || 300, 520), h = 40, m = { l: 12, r: 28 };
    const svg = d3.select(box).selectAll('svg').data([0]).join('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('width', '100%').attr('height', h)
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
    const box = document.getElementById('pw-station-chart');
    const rows = D.station_daily.filter((r) => r.site === S.site).map((r) => ({ t: new Date(r.date + 'T00:00:00Z'), date: r.date, stage: r.stage,
      p: num(r.pred_day), o: num(r.obs), po: num(r.pred_at_obs), miss: num(r.missing_inputs) }));
    if (!rows.length) { d3.select(box).selectAll('svg').remove(); return; }
    const W = box.clientWidth || 600, H = 288, m = { t: 22, r: 14, b: 26, l: 40 };
    const svg = svgIn(box, W, H, `${S.site} 예측과 관측 시계열`);
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
    const tip = tipOf(box);
    const near = (ev) => {
      const [sx] = d3.pointer(ev, svg.node()), vb = W / svg.node().getBoundingClientRect().width;
      return rows[d3.bisector((r) => r.t).center(rows, x.invert(sx * vb))];
    };
    svg.style('cursor', 'pointer').on('pointermove', (ev) => {
      const r = near(ev); if (!r) return;
      const [mx, my] = d3.pointer(ev, box);
      const lines = [`${dateLabel(r.date)} · ${r.stage}`, `예측(09~17시 평균) ${Number.isFinite(r.p) && !(r.miss > 0) ? d3.format('.2f')(r.p) + ' °C' : '상류 수온 결측'}`];
      if (Number.isFinite(r.o)) lines.push(`관측(층 평균) ${d3.format('.2f')(r.o)} °C`, `관측 시각 예측 ${d3.format('.2f')(r.po)} °C`);
      showTip(box, tip, lines, mx, my);
    }).on('pointerleave', () => { tip.hidden = true; })
      .on('click', (ev) => { const r = near(ev); if (r) setState({ date: r.date }); });
  };

  // ---------------------------------------------------------------- 조사일별 오차
  const renderSurveys = () => {
    const box = document.getElementById('pw-survey-chart');
    const rows = D.survey_scores.map((r) => ({ s: String(r.survey), date: r.date, check: r.check, e: num(r.e2a), gm: num(r.gam) }));
    const W = box.clientWidth || 600, H = 288, m = { t: 22, r: 10, b: 26, l: 36 };
    const svg = svgIn(box, W, H, '조사일별 균형 RMSE');
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
    const tip = tipOf(box);
    svg.selectAll('rect.pw-sbar').on('pointermove', (ev, d) => {
      const [mx, my] = d3.pointer(ev, box);
      showTip(box, tip, [`${d.r.s}차 · ${dateLabel(d.r.date)} · ${d.r.check}`, `E2-A ${d3.format('.2f')(d.r.e)} °C`, `GAM ${d3.format('.2f')(d.r.gm)} °C`], mx, my);
    }).on('pointerleave', () => { tip.hidden = true; }).on('click', (ev, d) => setState({ date: d.r.date }));
  };

  // ---------------------------------------------------------------- 소개: 세 하천 계절 수온
  const RIVERS = [['up_bukhan', '북한강(가평)', 'var(--c1)'], ['up_namhan', '남한강(양평)', 'var(--c2)'], ['up_gyeongan', '경안천', 'var(--c3)']];
  const SEASONS = [['봄', [3, 4, 5]], ['여름', [6, 7, 8]], ['가을', [9, 10, 11]], ['겨울', [12, 1, 2]]];
  const riverStats = () => SEASONS.map(([s, ms]) => {
    const rows = D.daily.filter((r) => ms.includes(Number(r.date.slice(5, 7))));
    const full = rows.filter((r) => RIVERS.every(([k]) => Number.isFinite(num(r[k]))));
    return { s, means: RIVERS.map(([k]) => d3.mean(rows, (r) => num(r[k]))), spread: d3.mean(full, (r) => d3.max(RIVERS, ([k]) => num(r[k])) - d3.min(RIVERS, ([k]) => num(r[k]))) };
  });
  const renderRivers = () => {
    const box = document.getElementById('pw-rivers');
    const st = riverStats();
    const W = box.clientWidth || 360, H = 230, m = { t: 26, r: 8, b: 24, l: 32 };
    const svg = svgIn(box, W, H, '상류 세 하천의 계절별 평균 전일 수온');
    const x = d3.scaleBand(st.map((d) => d.s), [m.l, W - m.r]).paddingInner(0.28).paddingOuter(0.08);
    const xi = d3.scaleBand(RIVERS.map((r) => r[0]), [0, x.bandwidth()]).padding(0.1);
    const y = d3.scaleLinear([0, d3.max(st, (d) => d3.max(d.means))], [H - m.b, m.t]).nice();
    svg.selectAll('g.pw-gridline').data([0]).join('g').attr('class', 'pw-gridline').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat('')).call(axisClean);
    svg.selectAll('g.pw-ax-x').data([0]).join('g').attr('class', 'pw-axis pw-ax-x').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).tickSizeOuter(0)).call(axisClean);
    svg.selectAll('g.pw-ax-y').data([0]).join('g').attr('class', 'pw-axis pw-ax-y').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(4).tickSizeOuter(0)).call(axisClean);
    svg.selectAll('text.pw-ylab').data([0]).join('text').attr('class', 'pw-ylab').attr('x', m.l - 4).attr('y', m.t - 10).attr('text-anchor', 'end').text('°C');
    const bars = st.flatMap((d) => RIVERS.map(([k, name, c], i) => ({ s: d.s, k, name, c, v: d.means[i] })));
    svg.selectAll('rect.pw-rbar').data(bars).join('rect').attr('class', 'pw-rbar')
      .attr('x', (d) => x(d.s) + xi(d.k)).attr('width', xi.bandwidth()).attr('y', (d) => y(d.v)).attr('height', (d) => y(0) - y(d.v)).attr('rx', 1.5)
      .style('fill', (d) => d.c);
    const key = svg.selectAll('g.pw-rkey').data(RIVERS).join('g').attr('class', 'pw-rkey');
    let kx = m.l;
    key.each(function ([, name, c]) {
      const g = d3.select(this).attr('transform', `translate(${kx},6)`);
      g.selectAll('rect').data([0]).join('rect').attr('width', 9).attr('height', 9).attr('rx', 2).style('fill', c);
      const t = g.selectAll('text').data([0]).join('text').attr('x', 13).attr('y', 8.5).text(name);
      kx += 13 + t.node().getComputedTextLength() + 14;
    });
    const tip = tipOf(box);
    svg.selectAll('rect.pw-rbar').on('pointermove', (ev, d) => {
      const [mx, my] = d3.pointer(ev, box);
      showTip(box, tip, [`${d.s} · ${d.name}`, `평균 전일 수온 ${d3.format('.1f')(d.v)} °C`], mx, my);
    }).on('pointerleave', () => { tip.hidden = true; });
    const su = st.find((d) => d.s === '여름'), wi = st.find((d) => d.s === '겨울');
    document.getElementById('pw-rivers-note').textContent =
      `여름에는 북한강이 가장 차고 경안천이 가장 따뜻하다. 같은 날 세 하천의 수온 차이(최고 − 최저)는 여름 평균 ${d3.format('.1f')(su.spread)} °C, 겨울 평균 ${d3.format('.1f')(wi.spread)} °C다. 그래서 상류 전일 수온이 날짜별 호 수온 수준을 정하는 가장 큰 입력이 된다.`;
  };

  // ---------------------------------------------------------------- 소개: 조사 차수와 기간
  const STAGES = [['개발학습', '개발학습'], ['개발검증', '개발검증'], ['최종시험', '최종시험']];
  const renderTimeline = () => {
    const box = document.getElementById('pw-timeline');
    const days = D.daily.map((r) => ({ t: new Date(r.date + 'T00:00:00Z'), date: r.date, stage: r.stage, miss: num(r.missing_inputs), survey: r.survey }));
    const obsDates = Array.from(new Set(D.station_daily.filter((r) => has(r.obs)).map((r) => r.date))).sort();
    const W = box.clientWidth || 700, narrow = W < 560, H = narrow ? 186 : 170, m = { t: 26, r: 12, b: 24, l: narrow ? 8 : 74 };
    const svg = svgIn(box, W, H, '조사 차수와 기간 나누기');
    const t0 = days[0].t, t1 = new Date(days[days.length - 1].t.getTime() + 864e5);
    const x = d3.scaleUtc([t0, t1], [m.l, W - m.r]);
    const ext = STAGES.map(([k, lab]) => {
      const ds = days.filter((d) => d.stage === k);
      return { k, lab, a: ds[0].t, b: new Date(ds[ds.length - 1].t.getTime() + 864e5) };
    });
    const yS = 40, yO = narrow ? 114 : 104, yM = narrow ? 134 : 124;
    svg.selectAll('rect.pw-tband').data(ext).join('rect').attr('class', 'pw-tband')
      .attr('x', (d) => x(d.a)).attr('width', (d) => Math.max(0, x(d.b) - x(d.a))).attr('y', m.t).attr('height', H - m.t - m.b)
      .style('fill', (d) => (d.k === '최종시험' ? 'var(--test-band)' : d.k === '개발검증' ? 'var(--band-2)' : 'var(--band)'));
    svg.selectAll('text.pw-tbandlab').data(ext).join('text').attr('class', 'pw-tbandlab')
      .attr('x', (d) => x(d.a) + 4).attr('y', m.t - 8).text((d) => d.lab);
    svg.selectAll('text.pw-trow').data(narrow ? [] : [['현장 조사', yS + 4], ['측정망 관측', yO + 4], ['상류 결측', yM + 4]]).join('text').attr('class', 'pw-trow')
      .attr('x', m.l - 8).attr('y', (d) => d[1]).attr('text-anchor', 'end').text((d) => d[0]);
    svg.selectAll('line.pw-tobs').data(obsDates).join('line').attr('class', 'pw-tobs')
      .attr('x1', (d) => x(new Date(d + 'T12:00:00Z'))).attr('x2', (d) => x(new Date(d + 'T12:00:00Z'))).attr('y1', yO - 6).attr('y2', yO + 6)
      .style('stroke', 'var(--fg)').style('stroke-width', 1).style('opacity', 0.55);
    svg.selectAll('line.pw-tmiss').data(days.filter((d) => d.miss > 0)).join('line').attr('class', 'pw-tmiss')
      .attr('x1', (d) => x(d.t)).attr('x2', (d) => x(d.t)).attr('y1', yM - 6).attr('y2', yM + 6)
      .style('stroke', 'var(--warn)').style('stroke-width', 1.2);
    const sv = days.filter((d) => has(d.survey));
    const g = svg.selectAll('g.pw-tsv').data(sv).join((en) => { const gg = en.append('g').attr('class', 'pw-tsv'); gg.append('circle'); gg.append('text'); return gg; })
      .attr('transform', (d, i) => `translate(${x(d.t)},${yS + (narrow ? (i % 3) * 19 : (i % 2 ? 26 : 0))})`).style('cursor', 'pointer');
    g.select('circle').attr('r', narrow ? 7.5 : 9).style('fill', (d) => (d.stage === '최종시험' ? 'var(--ok)' : d.stage === '개발검증' ? 'var(--accent-ink)' : 'var(--accent)'))
      .style('stroke', 'var(--panel)').style('stroke-width', 1.5);
    g.select('text').attr('class', 'pw-tsvlab').attr('text-anchor', 'middle').attr('dy', '0.35em').text((d) => d.survey);
    svg.selectAll('line.pw-tsvstem').data(narrow ? [] : sv.filter((d, i) => i % 2)).join('line').attr('class', 'pw-tsvstem')
      .attr('x1', (d) => x(d.t)).attr('x2', (d) => x(d.t)).attr('y1', yS + 8).attr('y2', yS + 17).style('stroke', 'var(--line)');
    svg.selectAll('g.pw-ax-x').data([0]).join('g').attr('class', 'pw-axis pw-ax-x').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).ticks(d3.utcMonth.every(narrow ? 6 : 3)).tickFormat(d3.utcFormat('%y.%m')).tickSizeOuter(0)).call(axisClean);
    const tip = tipOf(box);
    g.on('pointermove', (ev, d) => {
      const [mx, my] = d3.pointer(ev, box);
      showTip(box, tip, [`${d.survey}차 조사 · ${dateLabel(d.date)}`, d.stage, '누르면 예측 지도로'], mx, my);
    }).on('pointerleave', () => { tip.hidden = true; }).on('click', (ev, d) => setState({ tab: 'map', date: d.date }));
  };

  // ---------------------------------------------------------------- 모델 성능: 모형별 한 줄 요약
  const SUM_ORDER = ['E2-A 최종', 'E0-0', 'E0-1', 'E0-2', 'E0-3', 'E1', 'E2-A', 'E2-B', 'E2-C', 'E2-D', 'E3'];
  const SUM_HEAD = {
    Temp: '입력을 늘려도 수온은 상류 전일 수온만 쓴 E2-A가 가장 좋았다',
    EC: 'EC는 어느 모형도 GAM보다 확실히 낫지 않아, 최종시험 없이 E4로 넘겼다',
  };
  const SUM_NOTE = {
    Temp: {
      'E2-A 최종': '최종 후보. 반복 수를 다시 정해 학습하고 최종시험을 한 번 채점했다.',
      'E0-0': '전체 평균 하나. 계절 변화를 따라가지 못해 가장 나쁘다.',
      'E0-1': '계절 평균만으로는 해마다·날마다 다른 수온 수준을 따라가지 못한다.',
      'E0-2': '위치를 더해도 계절 평균보다 나아지지 않았다.',
      'E0-3': '외부 입력 없는 기준선. 모든 모형을 이것과 비교한다.',
      'E1': '공통 완전사례에서만 학습. GAM과 차이가 확실하지 않아 제외했다.',
      'E2-A': '위치·계절·시각에 상류 전일 수온 3개만 더한 9개 입력으로 개발검증·LOSO 모두 가장 낮아 최종 후보로 골랐다.',
      'E2-B': '유량을 더하자 E2-A보다 오히려 나빠졌고, GAM과 차이도 불확실하다.',
      'E2-C': '기상을 더하면 GAM보다는 좋지만 E2-A보다 나쁘다.',
      'E2-D': '3·7일 창까지 38개를 넣어도 E2-A보다 나쁘다.',
      'E3': '개발검증은 E2-A와 비슷하나 LOSO에서 더 나빠 제외했다.',
    },
    EC: {
      'E0-0': '전체 평균 하나.',
      'E0-1': '계절 평균.',
      'E0-2': '위치·계절 평균. GAM과 차이가 확실하지 않다.',
      'E0-3': '외부 입력 없는 기준선.',
      'E1': '공통 완전사례에서만 학습. GAM과 차이가 확실하지 않다.',
      'E2-A': '개발검증은 GAM보다 낮지만 구간이 넓고, LOSO는 GAM과 비슷하다.',
      'E2-B': '유량 추가. 개선 폭이 구간 안이다.',
      'E2-C': '기상 추가. 개선 폭이 구간 안이다.',
      'E2-D': 'LOSO에서 GAM보다 나빴다.',
      'E3': '개발검증은 가장 낮지만 구간이 0을 포함하고, LOSO는 GAM보다 나빴다.',
    },
  };
  const verdict = (d, lo, hi) => {
    if (!has(d)) return null;
    if (num(hi) < 0) return ['GAM보다 확실히 좋음', 'pw-tag-good'];
    if (num(lo) > 0) return ['GAM보다 확실히 나쁨', 'pw-tag-bad'];
    return ['차이 불확실', 'pw-tag-mid'];
  };
  const barCell = (td, v, ref, cap, dec, extra) => {
    const wrap = el('div', 'pw-ibarcell');
    const track = el('div', 'pw-ibartrack');
    if (Number.isFinite(v)) {
      const fill = el('span', 'pw-ibarfill' + (v > cap ? ' pw-over' : ''));
      fill.style.width = Math.min(100, (v / cap) * 100) + '%';
      track.appendChild(fill);
    }
    if (Number.isFinite(ref)) { const r = el('i', 'pw-ibarref'); r.style.left = Math.min(100, (ref / cap) * 100) + '%'; r.title = 'GAM'; track.appendChild(r); }
    wrap.appendChild(track);
    const val = el('span', 'pw-ibarval', Number.isFinite(v) ? d3.format(`.${dec}f`)(v) : '—');
    if (extra) val.appendChild(el('small', '', extra));
    wrap.appendChild(val);
    td.appendChild(wrap);
  };
  const renderSummary = () => {
    const T = S.target, dec = T === 'Temp' ? 2 : 1, unit = T === 'Temp' ? '°C' : 'μS/cm';
    document.getElementById('pw-summary-h').textContent = SUM_HEAD[T];
    const all = D.model_comparison.filter((r) => r.target === T);
    const rows = SUM_ORDER.map((id) => all.find((r) => r.model === id && r.set === '전체 가용') || all.find((r) => r.model === id)).filter(Boolean);
    const gam = rows.find((r) => r.model === 'E0-3');
    const vals = rows.filter((r) => r.model !== 'E0-0').flatMap((r) => [num(r.dv_rmse), num(r.loso_rmse), num(r.test_rmse)]).filter(Number.isFinite);
    const cap = d3.max(vals) * 1.08;
    const bestDv = d3.min(rows.filter((r) => r.stage !== '최종'), (r) => num(r.dv_rmse));
    const bestLo = d3.min(rows.filter((r) => r.stage !== '최종' && r.set === '전체 가용'), (r) => num(r.loso_rmse));
    const tbody = document.querySelector('#pw-sum-table tbody');
    tbody.replaceChildren();
    for (const r of rows) {
      const tr = el('tr', r.stage === '최종' ? 'pw-final' : '');
      const th = el('th', 'pw-l pw-stick'); th.scope = 'row';
      th.appendChild(el('b', '', r.model));
      th.appendChild(el('span', 'pw-sub', `${r.name} · ${r.inputs}${r.set !== '전체 가용' ? ' · 공통 완전사례' : ''}`));
      tr.appendChild(th);
      const tdv = el('td', 'pw-l pw-gsep' + (num(r.dv_rmse) === bestDv ? ' pw-best' : ''));
      barCell(tdv, num(r.dv_rmse), gam ? num(gam.dv_rmse) : NaN, cap, dec);
      tr.appendChild(tdv);
      const tlo = el('td', 'pw-l pw-gsep' + (r.set === '전체 가용' && num(r.loso_rmse) === bestLo ? ' pw-best' : ''));
      barCell(tlo, num(r.loso_rmse), gam && r.set === gam.set ? num(gam.loso_rmse) : NaN, cap, dec,
        has(r.loso_better) ? ` ${r.loso_better}/${r.loso_days}일 우세` : '');
      tr.appendChild(tlo);
      tr.appendChild(el('td', 'pw-gsep', has(r.test_rmse) ? d3.format(`.${dec}f`)(num(r.test_rmse)) : '—'));
      const tv = el('td', 'pw-l pw-gsep');
      const isFinal = r.stage === '최종';
      const [d, lo, hi] = isFinal ? [r.test_diff, r.test_lo, r.test_hi] : [r.dv_diff, r.dv_lo, r.dv_hi];
      if (r.model === 'E0-3') tv.appendChild(el('span', 'pw-tag', '기준'));
      else {
        const v = verdict(d, lo, hi);
        if (v) {
          tv.appendChild(el('span', 'pw-tag ' + v[1], v[0]));
          const f = d3.format(`+.${dec}f`);
          tv.appendChild(el('span', 'pw-sub', `${isFinal ? '최종시험' : '개발검증'} ${f(num(d))} [${f(num(lo))}, ${f(num(hi))}]`));
        } else tv.appendChild(el('span', 'pw-muted', '—'));
      }
      tr.appendChild(tv);
      tr.appendChild(el('td', 'pw-l pw-gsep pw-wrap', (SUM_NOTE[T] || {})[r.model] || ''));
      tbody.appendChild(tr);
    }
    const capRow = el('tr', 'pw-capnote');
    const c = el('td', 'pw-l', `막대 길이 기준 0 ~ ${d3.format(`.${T === 'Temp' ? 1 : 0}f`)(cap)} ${unit}. 넘는 값은 끝을 잘라 표시했다.`);
    c.colSpan = 6; capRow.appendChild(c); tbody.appendChild(capRow);
  };

  // ---------------------------------------------------------------- 모델 성능: 상세 비교표
  const MODEL_ORDER = ['E2-A 최종', 'E0-0', 'E0-1', 'E0-2', 'E0-3', 'E1', 'E2-A', 'E2-B', 'E2-C', 'E2-D', 'E3'];
  const SET_ORDER = ['전체 가용', '공통 완전사례'];
  const cell = (tr, text, cls, tag) => { const c = document.createElement(tag || 'td'); c.textContent = text; if (cls) c.className = cls; tr.appendChild(c); return c; };
  const renderModels = () => {
    const T = S.target, dec = T === 'Temp' ? 2 : 1;
    const f = (v, d = dec) => (has(v) ? d3.format(`.${d}f`)(num(v)) : '—');
    const s = (v) => (has(v) ? d3.format(`+.${dec}f`)(num(v)) : '—');
    $$('.pw-seg button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.target === T)));
    document.getElementById('pw-ec-note').hidden = T !== 'EC';
    const rows = D.model_comparison.filter((r) => r.target === T);
    const tbody = document.querySelector('#pw-model-table tbody');
    tbody.replaceChildren();
    for (const set of SET_ORDER) {
      const g = rows.filter((r) => r.set === set).sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model));
      if (!g.length) continue;
      const head = document.createElement('tr'); head.className = 'pw-grp';
      const hc = cell(head, set === '전체 가용' ? '전체 가용 집합 · 결측을 그대로 두고 학습' : '공통 완전사례 · 입력 38개가 모두 있는 행만', 'pw-l');
      hc.colSpan = 13; tbody.appendChild(head);
      const minDv = d3.min(g, (r) => num(r.dv_rmse)), minLo = d3.min(g.filter((r) => has(r.loso_rmse)), (r) => num(r.loso_rmse));
      for (const r of g) {
        const tr = document.createElement('tr');
        if (r.stage === '최종') tr.className = 'pw-final';
        const th = document.createElement('th'); th.scope = 'row'; th.className = 'pw-l pw-stick';
        const b = document.createElement('b'); b.textContent = r.model; th.appendChild(b);
        const sub = document.createElement('span'); sub.className = 'pw-sub'; sub.textContent = `${r.name} · ${r.inputs}`; th.appendChild(sub);
        tr.appendChild(th);
        cell(tr, f(r.dv_rmse), 'pw-gsep' + (num(r.dv_rmse) === minDv ? ' pw-best' : ''));
        cell(tr, f(r.dv_mae));
        cell(tr, f(r.dv_r2, 3));
        cell(tr, s(r.dv_bias));
        const dc = has(r.dv_diff) ? `${s(r.dv_diff)} [${s(r.dv_lo)}, ${s(r.dv_hi)}]` : (r.model === 'E0-3' ? '기준' : '—');
        cell(tr, dc, has(r.dv_diff) ? (num(r.dv_hi) < 0 ? 'pw-good' : num(r.dv_lo) > 0 ? 'pw-badc' : 'pw-muted') : 'pw-muted');
        cell(tr, f(r.loso_rmse), 'pw-gsep' + (has(r.loso_rmse) && num(r.loso_rmse) === minLo ? ' pw-best' : ''));
        cell(tr, has(r.loso_better) ? `${r.loso_better}/${r.loso_days}` : (r.model === 'E0-3' ? '기준' : '—'), 'pw-muted');
        cell(tr, f(r.test_rmse), 'pw-gsep');
        cell(tr, f(r.test_r2, 3));
        cell(tr, s(r.test_bias));
        const tc = has(r.test_diff) ? `${s(r.test_diff)} [${s(r.test_lo)}, ${s(r.test_hi)}]` : (r.model === 'E0-3' && has(r.test_rmse) ? '기준' : '—');
        cell(tr, tc, has(r.test_diff) ? (num(r.test_hi) < 0 ? 'pw-good' : num(r.test_lo) > 0 ? 'pw-badc' : 'pw-muted') : 'pw-muted');
        let st = r.setting || '—';
        if (has(r.iterations)) st += ` · 반복 ${d3.format(',')(r.iterations)}`;
        if (has(r.final_iterations)) st += `, 최종 ${d3.format(',')(r.final_iterations)}`;
        cell(tr, st, 'pw-l pw-muted pw-gsep');
        tbody.appendChild(tr);
      }
    }
    renderForest(rows, dec);
  };
  const renderForest = (rows, dec) => {
    const box = document.getElementById('pw-forest');
    const pts = SET_ORDER.flatMap((set) => rows.filter((r) => r.set === set && has(r.dv_diff) && r.family !== 'E0')
      .sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model))
      .map((r) => ({ k: `${r.model} · ${set === '전체 가용' ? '전체' : '공통'}`, d: num(r.dv_diff), lo: num(r.dv_lo), hi: num(r.dv_hi) })));
    const W = box.clientWidth || 600, rowH = 24, m = { t: 8, b: 28, r: 16 }, H = pts.length * rowH + m.t + m.b;
    const svg = svgIn(box, W, H, 'GAM 대비 균형 RMSE 차이와 95% 구간');
    const labs = svg.selectAll('text.pw-flab').data(pts).join('text').attr('class', 'pw-flab').attr('y', (d, i) => m.t + i * rowH + 16).text((d) => d.k);
    const lw = (d3.max(labs.nodes(), (n) => n.getComputedTextLength()) || 100) + 10;
    labs.attr('x', lw - 6).attr('text-anchor', 'end');
    const ext = d3.extent(pts.flatMap((p) => [p.lo, p.hi]).concat([0]));
    const x = d3.scaleLinear(ext, [lw + 6, W - m.r]).nice();
    svg.selectAll('g.pw-gridline').data([0]).join('g').attr('class', 'pw-gridline').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, Math.floor((W - lw) / 80))).tickSize(-(H - m.t - m.b)).tickFormat('')).call(axisClean);
    svg.selectAll('g.pw-ax-x').data([0]).join('g').attr('class', 'pw-axis pw-ax-x').attr('transform', `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, Math.floor((W - lw) / 80))).tickFormat((v) => d3.format(`+.${Math.min(dec, 1)}f`)(v)).tickSizeOuter(0)).call(axisClean);
    svg.selectAll('line.pw-zero').data([0]).join('line').attr('class', 'pw-zero').attr('x1', x(0)).attr('x2', x(0)).attr('y1', m.t).attr('y2', H - m.b)
      .style('stroke', 'var(--fg)').style('stroke-width', 1);
    const col = (p) => (p.hi < 0 ? 'var(--ok)' : p.lo > 0 ? 'var(--bad)' : 'var(--muted)');
    svg.selectAll('line.pw-ci').data(pts).join('line').attr('class', 'pw-ci').attr('x1', (p) => x(p.lo)).attr('x2', (p) => x(p.hi))
      .attr('y1', (p, i) => m.t + i * rowH + 12).attr('y2', (p, i) => m.t + i * rowH + 12).style('stroke', col).style('stroke-width', 2).style('stroke-linecap', 'round');
    svg.selectAll('circle.pw-pt').data(pts).join('circle').attr('class', 'pw-pt').attr('cx', (p) => x(p.d)).attr('cy', (p, i) => m.t + i * rowH + 12).attr('r', 4)
      .style('fill', col).style('stroke', 'var(--panel)').style('stroke-width', 1.5);
    const tip = tipOf(box);
    svg.selectAll('circle.pw-pt').on('pointermove', (ev, p) => {
      const [mx, my] = d3.pointer(ev, box);
      showTip(box, tip, [p.k, `GAM 대비 ${d3.format(`+.${dec}f`)(p.d)}`, `95% 구간 ${d3.format(`+.${dec}f`)(p.lo)} ~ ${d3.format(`+.${dec}f`)(p.hi)}`], mx, my);
    }).on('pointerleave', () => { tip.hidden = true; });
  };

  // ---------------------------------------------------------------- 중요도
  const renderImportance = () => {
    const box = document.getElementById('pw-importance');
    const rows = D.importance.map((r) => ({ k: String(r.variable), v: num(r.share) })).sort((a, b) => b.v - a.v);
    const W = box.clientWidth || 400, rowH = 24, H = rows.length * rowH + 8;
    const svg = svgIn(box, W, H, '입력별 중요도');
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

  // ---------------------------------------------------------------- 유역·자료: 유역도
  // 지점 종류: 기호와 색. kind 값은 scripts/build_basin.py의 SITE_KINDS와 같다.
  const KINDS = {
    lake_wq: { name: '팔당호 수질측정망', sym: d3.symbolCircle, c: 'var(--k-lake)' },
    auto_wq: { name: '한강 수질자동측정망 · 모형 입력', sym: d3.symbolTriangle, c: 'var(--k-auto)' },
    flow: { name: '유량·수위 · 후보 입력(E2-B)', sym: d3.symbolSquare, c: 'var(--k-flow)' },
    weather: { name: '기상 관측소 · 후보 입력(E2-C)', sym: d3.symbolDiamond, c: 'var(--k-met)' },
    dam: { name: '댐', sym: d3.symbolWye, c: 'var(--muted)' },
  };
  const BASIN_FILL = { 북한강: 'var(--c1)', 남한강: 'var(--c2)', 경안천: 'var(--c3)', 팔당호: 'var(--c4)' };
  const scaleBar = (svg, proj, W, H, cls) => {
    // 지도 아래쪽 가운데 위도에서 1픽셀이 몇 km인지 재서 반올림한 길이의 축척 막대를 그린다.
    const [lon0, lat0] = proj.invert([W * 0.5, H - 20]), [lon1] = proj.invert([W * 0.5 + 100, H - 20]);
    const kmPer100 = d3.geoDistance([lon0, lat0], [lon1, lat0]) * 6371;
    const nice = [1, 2, 5, 10, 20, 25, 50, 100].find((v) => v / kmPer100 * 100 >= 50) || 100;
    const len = nice / kmPer100 * 100, x0 = W - len - 16, y0 = H - 16;
    const g = svg.selectAll(`g.${cls}`).data([0]).join('g').attr('class', cls);
    g.selectAll('path').data([0]).join('path').attr('d', `M${x0},${y0 - 5}V${y0}H${x0 + len}V${y0 - 5}`)
      .style('fill', 'none').style('stroke', 'var(--fg)').style('stroke-width', 1.4);
    g.selectAll('text').data([0]).join('text').attr('x', x0 + len / 2).attr('y', y0 - 8).attr('text-anchor', 'middle').text(`${nice} km`);
  };
  const northArrow = (svg, x, y, cls) => {
    const g = svg.selectAll(`g.${cls}`).data([0]).join('g').attr('class', cls).attr('transform', `translate(${x},${y})`);
    g.selectAll('path').data([0]).join('path').attr('d', 'M0,-14L6,6L0,1L-6,6Z').style('fill', 'var(--fg)');
    g.selectAll('text').data([0]).join('text').attr('y', 20).attr('text-anchor', 'middle').text('N');
  };
  const symPath = (kind, size) => d3.symbol().type((KINDS[kind] || KINDS.dam).sym).size(size || 64)();
  const legendSym = (kind, hollow) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '-8 -8 16 16'); s.setAttribute('class', 'pw-lsym');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', symPath(kind, 56));
    const c = (KINDS[kind] || KINDS.dam).c;
    if (hollow) { p.style.fill = 'var(--panel)'; p.style.stroke = c; p.style.strokeWidth = '1.8'; } else p.style.fill = c;
    s.appendChild(p); return s;
  };
  const fillLegend = (box, items) => {
    box.replaceChildren();
    for (const [sw, label] of items) { const r = el('div', 'pw-lkey'); r.appendChild(sw); r.appendChild(el('span', '', label)); box.appendChild(r); }
  };
  const fillFacts = (box, facts) => {
    box.replaceChildren();
    for (const f of facts || []) { box.appendChild(el('dt', '', f.k)); box.appendChild(el('dd', '', f.v)); }
  };
  const bboxFeature = ([w, s, e, n]) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[w, s], [w, n], [e, n], [e, s], [w, s]]] } });
  const drawBox = (svg, proj, bb, cls, label) => {
    const d = bb ? [proj([bb[0], bb[3]]), proj([bb[2], bb[1]])] : null;
    svg.selectAll(`rect.${cls}`).data(d ? [d] : []).join('rect').attr('class', cls)
      .attr('x', (q) => q[0][0]).attr('y', (q) => q[0][1]).attr('width', (q) => Math.max(4, q[1][0] - q[0][0])).attr('height', (q) => Math.max(4, q[1][1] - q[0][1]))
      .style('fill', 'none').style('stroke', 'var(--bad)').style('stroke-width', 1.4);
    svg.selectAll(`text.${cls}-lab`).data(d && label ? [d] : []).join('text').attr('class', `${cls}-lab pw-boxlab`)
      .attr('x', (q) => q[1][0] + 4).attr('y', (q) => q[0][1] + 10).text(label);
  };

  // 유역 전체(세 하천 유역 경계). basin.json에 basins가 있을 때만 보인다.
  const renderWatershed = () => {
    const B = D.basin, card = document.getElementById('watershed');
    card.hidden = !(B && B.basins && B.basins.features.length);
    if (card.hidden) return;
    const box = document.getElementById('pw-ws-map');
    const W = box.clientWidth || 600, H = Math.round(Math.min(Math.max(W * 0.95, 360), 680));
    const svg = svgIn(box, W, H, '팔당호 유역도');
    const proj = d3.geoTransverseMercator().rotate([-127.5, -38]).fitExtent([[12, 12], [W - 12, H - 12]], B.basins);
    const path = d3.geoPath(proj);
    svg.selectAll('path.pw-basin').data(B.basins.features).join('path').attr('class', 'pw-basin').attr('d', path)
      .style('fill', (f) => BASIN_FILL[f.properties.group] || 'var(--band)').style('fill-opacity', 0.22)
      .style('stroke', 'var(--panel)').style('stroke-width', 0.6);
    svg.selectAll('path.pw-boundary').data(B.basin_outline ? [B.basin_outline] : []).join('path').attr('class', 'pw-boundary').attr('d', path)
      .style('fill', 'none').style('stroke', 'var(--fg)').style('stroke-width', 1.4);
    svg.selectAll('path.pw-river').data(B.ws_rivers ? B.ws_rivers.features : []).join('path').attr('class', 'pw-river').attr('d', path)
      .style('fill', 'none').style('stroke', 'var(--water)').style('stroke-width', (f) => (f.properties.main ? 1.6 : 0.7)).style('stroke-linejoin', 'round');
    svg.selectAll('text.pw-blab').data(B.basins.features.filter((f) => f.properties.label)).join('text').attr('class', 'pw-blab')
      .attr('transform', (f) => `translate(${proj(f.properties.label_at || d3.geoCentroid(f))})`).attr('text-anchor', 'middle').text((f) => f.properties.label);
    drawBox(svg, proj, B.region, 'pw-regbox', '');
    northArrow(svg, W - 22, 28, 'pw-wsnorth');
    scaleBar(svg, proj, W, H, 'pw-wsscale');
    const items = B.basins.features.filter((f) => f.properties.legend).map((f) => { const sw = el('i', 'pw-lsw'); sw.style.background = BASIN_FILL[f.properties.group]; return [sw, f.properties.legend]; });
    items.push([el('i', 'pw-lline'), '하천'], [el('i', 'pw-lbox'), '아래 지도 범위']);
    fillLegend(document.getElementById('pw-ws-legend'), items);
    fillFacts(document.getElementById('pw-ws-facts'), B.ws_facts);
  };

  // 유입 하천과 자료 지점(지역 지도)
  // 지도 가장자리에서 잘리는 글자는 반대쪽으로 붙인다.
  const fitLabels = (texts, W, posX) => {
    texts.each(function (d) {
      const t = d3.select(this), len = this.getComputedTextLength(), x0 = posX(d), dx = Math.abs(Number(t.attr('x')) || 8);
      const anchor = t.attr('text-anchor') || 'start';
      if (anchor !== 'end' && x0 + dx + len > W - 3) t.attr('x', -dx).attr('text-anchor', 'end');
      else if (anchor === 'end' && x0 - dx - len < 3) t.attr('x', dx).attr('text-anchor', 'start');
      else if (anchor === 'middle' && x0 - len / 2 < 3) t.attr('x', 3 - x0 + len / 2);
    });
  };
  const renderBasin = () => {
    const box = document.getElementById('pw-basin-map'), B = D.basin;
    const ok = !!(B && B.region);
    document.getElementById('pw-basin-none').hidden = ok;
    box.closest('.pw-basinwrap').hidden = !ok;
    if (!ok) return;
    const [w, s, e, n] = B.region;
    const W = box.clientWidth || 600;
    const proj0 = d3.geoTransverseMercator().rotate([-(w + e) / 2, -(s + n) / 2]);
    const fc = bboxFeature(B.region);
    const b0 = d3.geoPath(proj0).bounds(fc), aspect = (b0[1][1] - b0[0][1]) / (b0[1][0] - b0[0][0]);
    const H = Math.round(Math.min(W * aspect, 760));
    const proj = proj0.fitExtent([[0, 0], [W, H]], fc), path = d3.geoPath(proj);
    const svg = svgIn(box, W, H, '팔당호 유입 하천과 자료 지점');
    svg.selectAll('rect.pw-mapbg').data([0]).join('rect').attr('class', 'pw-mapbg').attr('width', W).attr('height', H).style('fill', 'var(--bg)');
    svg.selectAll('path.pw-river').data(B.rivers ? B.rivers.features : []).join('path').attr('class', 'pw-river').attr('d', path)
      .style('fill', 'none').style('stroke', 'var(--water)').style('stroke-width', (f) => f.properties.w || 1).style('stroke-linejoin', 'round').style('stroke-linecap', 'round');
    svg.selectAll('path.pw-water').data(B.water ? B.water.features : []).join('path').attr('class', 'pw-water').attr('d', path)
      .style('fill', 'var(--water)').style('fill-rule', 'evenodd').style('stroke', 'var(--water)').style('stroke-width', 0.5);
    svg.selectAll('text.pw-rlab').data(B.labels || []).join('text').attr('class', 'pw-rlab')
      .attr('transform', (d) => `translate(${proj([d.lon, d.lat])}) rotate(${d.rotate || 0})`).attr('text-anchor', 'middle').text((d) => d.text);
    drawBox(svg, proj, B.lake_box, 'pw-lakebox', '조사 수역');
    const sites = (B.sites || []).filter((x) => KINDS[x.kind] && x.on_map !== false);
    const gs = svg.selectAll('g.pw-site').data(sites, (x) => x.id).join((en) => { const g = en.append('g').attr('class', 'pw-site'); g.append('path'); g.append('text'); return g; })
      .attr('transform', (x) => `translate(${proj([x.lon, x.lat])})`);
    gs.select('path').attr('d', (x) => symPath(x.kind, x.kind === 'lake_wq' ? 30 : 70))
      .style('fill', (x) => (x.precision === '근사' ? 'var(--panel)' : KINDS[x.kind].c))
      .style('stroke', (x) => (x.precision === '근사' ? KINDS[x.kind].c : 'var(--panel)')).style('stroke-width', (x) => (x.precision === '근사' ? 1.8 : 1.2));
    gs.select('text').attr('class', 'pw-sitelab').attr('x', (x) => x.dx ?? 8).attr('y', (x) => x.dy ?? 4)
      .attr('text-anchor', (x) => ((x.dx ?? 8) < 0 ? 'end' : 'start')).text((x) => (x.kind === 'lake_wq' ? '' : x.short || x.name));
    northArrow(svg, 22, 30, 'pw-north');
    scaleBar(svg, proj, W, H, 'pw-scalebar');
    fitLabels(gs.select('text'), W, (x) => proj([x.lon, x.lat])[0]);
    const tip = tipOf(box);
    gs.on('pointermove', (ev, x) => {
      const [mx, my] = d3.pointer(ev, box);
      showTip(box, tip, [KINDS[x.kind].name, x.name, x.data || '', x.use || '', x.addr || '', `위치: ${x.precision}`].filter(Boolean), mx, my);
    }).on('pointerleave', () => { tip.hidden = true; });
    const kinds = Object.keys(KINDS).filter((k) => sites.some((x) => x.kind === k));
    const items = kinds.map((k) => [legendSym(k, false), `${KINDS[k].name} (${sites.filter((x) => x.kind === k).length})`]);
    if (sites.some((x) => x.precision === '근사')) items.push([legendSym('auto_wq', true), '속이 빈 기호: 근사 위치']);
    items.push([el('i', 'pw-lline'), '하천 · 호소 수면'], [el('i', 'pw-lbox'), '조사 수역(아래 지도)']);
    fillLegend(document.getElementById('pw-basin-legend'), items);
    fillFacts(document.getElementById('pw-basin-facts'), B.facts);
  };

  // ---------------------------------------------------------------- 유역·자료: 조사 수역과 호 안 측정망
  const renderLake = () => {
    const box = document.getElementById('pw-lake-map'), geo = D.geo;
    const pts = geo.outline.concat(geo.stations);
    const x0 = d3.min(pts, (p) => p.x) - 1700, x1 = d3.max(pts, (p) => p.x) + 500, y0 = d3.min(pts, (p) => p.y) - 500, y1 = d3.max(pts, (p) => p.y) + 700;
    const xEast = d3.max(geo.stations, (p) => p.x);
    const W = box.clientWidth || 500, k = W / (x1 - x0), H = Math.round((y1 - y0) * k);
    const px = (x) => (x - x0) * k, py = (y) => (y1 - y) * k;
    const svg = svgIn(box, W, H, '조사 수역과 팔당호 수질측정망');
    const water = D.basin && D.basin.lake_utm ? D.basin.lake_utm : [];
    const line = d3.line().x((p) => px(p[0])).y((p) => py(p[1]));
    svg.selectAll('path.pw-lwater').data(water).join('path').attr('class', 'pw-lwater').attr('d', (r) => line(r) + 'Z')
      .style('fill', 'var(--water)').style('fill-opacity', 0.35).style('stroke', 'var(--water)').style('stroke-width', 0.6).style('fill-rule', 'evenodd');
    const s = Math.max(1, 100 * k);
    svg.selectAll('rect.pw-lcell').data(geo.cells).join('rect').attr('class', 'pw-lcell')
      .attr('x', (c) => px(c.x) - s / 2).attr('y', (c) => py(c.y) - s / 2).attr('width', s + 0.3).attr('height', s + 0.3)
      .style('fill', 'var(--accent)').style('opacity', 0.22);
    const ol = d3.line().x((p) => px(p.x)).y((p) => py(p.y));
    svg.selectAll('path.pw-lout').data([geo.outline]).join('path').attr('class', 'pw-lout').attr('d', (d) => ol(d) + 'Z')
      .style('fill', 'none').style('stroke', 'var(--accent-ink)').style('stroke-width', 1.4);
    const labs = (D.basin && D.basin.lake_labels) || [];
    svg.selectAll('text.pw-llab').data(labs).join('text').attr('class', 'pw-llab').attr('x', (d) => px(d.x)).attr('y', (d) => py(d.y))
      .attr('text-anchor', (d) => d.anchor || 'middle').text((d) => d.text)
      .each(function (d) {          // 왼쪽·오른쪽 끝에서 잘리지 않게
        const len = this.getComputedTextLength(), a = d.anchor || 'middle', x = px(d.x);
        const left = a === 'end' ? x - len : a === 'middle' ? x - len / 2 : x;
        if (left < 3) d3.select(this).attr('text-anchor', 'start').attr('x', 3);
        else if (left + len > W - 3) d3.select(this).attr('text-anchor', 'end').attr('x', W - 3);
      });
    const gs = svg.selectAll('g.pw-lst').data(geo.stations, (d) => d.id).join((en) => { const g = en.append('g').attr('class', 'pw-lst'); g.append('circle'); g.append('text'); return g; })
      .attr('transform', (d) => `translate(${px(d.x)},${py(d.y)})`).style('cursor', 'pointer');
    gs.select('circle').attr('r', 5.5).style('fill', (d) => (d.id === S.site ? 'var(--warn)' : 'var(--k-lake)')).style('stroke', 'var(--panel)').style('stroke-width', 1.5);
    gs.select('text').attr('class', 'pw-lstlab').attr('x', (d) => (d.x === xEast ? -8 : 8)).attr('y', -7)
      .attr('text-anchor', (d) => (d.x === xEast ? 'end' : 'start')).text((d) => d.id);
    northArrow(svg, W - 18, 24, 'pw-lnorth');
    const kmPx = 1000 * k, nice = [0.5, 1, 2, 5].find((v) => v * kmPx >= 50) || 5, len = nice * kmPx;
    const sb = svg.selectAll('g.pw-lscale').data([0]).join('g').attr('class', 'pw-lscale');
    sb.selectAll('path').data([0]).join('path').attr('d', `M${W - len - 14},${H - 16}v5h${len}v-5`).style('fill', 'none').style('stroke', 'var(--fg)').style('stroke-width', 1.4);
    sb.selectAll('text').data([0]).join('text').attr('x', W - len / 2 - 14).attr('y', H - 20).attr('text-anchor', 'middle').text(`${nice} km`);
    const tip = tipOf(box);
    gs.on('pointermove', (ev, d) => {
      const [mx, my] = d3.pointer(ev, box);
      const e = (D.station_errors || []).find((r) => r.site === d.id && r.period === '최종시험');
      showTip(box, tip, [d.id, `관측 ${D.station_daily.filter((r) => r.site === d.id && has(r.obs)).length}일`, e ? `최종시험 RMSE ${d3.format('.2f')(e.rmse)} °C` : '', '누르면 시계열로'].filter(Boolean), mx, my);
    }).on('pointerleave', () => { tip.hidden = true; }).on('click', (ev, d) => setState({ tab: 'map', site: d.id }));
  };

  // ---------------------------------------------------------------- 유역·자료: 지점 표
  const renderSiteTable = () => {
    const tbody = document.querySelector('#pw-site-table tbody');
    const sites = (D.basin && D.basin.sites) || [];
    document.getElementById('sites').hidden = !sites.length;
    tbody.replaceChildren();
    const order = Object.keys(KINDS);
    for (const s of sites.slice().sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind))) {
      const tr = el('tr');
      const k = el('td', 'pw-l');
      k.appendChild(legendSym(s.kind, s.precision === '근사')); k.appendChild(document.createTextNode(' ' + ((KINDS[s.kind] || {}).name || s.kind).split(' · ')[0]));
      tr.appendChild(k);
      tr.appendChild(el('td', 'pw-l', s.name + (s.code ? ` (${s.code})` : '')));
      tr.appendChild(el('td', 'pw-l', s.river || '—'));
      tr.appendChild(el('td', 'pw-l', s.data || '—'));
      tr.appendChild(el('td', 'pw-l pw-wrap', s.use || '—'));
      tr.appendChild(el('td', '', Number.isFinite(s.lat) ? `${d3.format('.4f')(s.lat)}, ${d3.format('.4f')(s.lon)}` : '—'));
      tr.appendChild(el('td', 'pw-l' + (s.precision === '근사' ? ' pw-warnc' : ''), s.precision || '—'));
      tbody.appendChild(tr);
    }
  };

  // ---------------------------------------------------------------- 파생 요약(소개·유역 화면의 숫자)
  const derive = () => {
    const obsRows = D.station_daily.filter((r) => has(r.obs));
    const dates = Array.from(new Set(obsRows.map((r) => r.date))).sort();
    const gaps = dates.slice(1).map((d, i) => (Date.parse(d) - Date.parse(dates[i])) / 864e5);
    const miss = (k) => D.daily.filter((r) => !Number.isFinite(num(r[k]))).length;
    D.obs_info = [{ days: dates.length, gap: d3.median(gaps), rows: obsRows.length, input_days: D.daily.length,
      miss_bukhan: miss('up_bukhan'), miss_namhan: miss('up_namhan'), miss_gyeongan: miss('up_gyeongan') }];
    const o = D.geo.outline;
    const area = Math.abs(d3.sum(o, (p, i) => { const q = o[(i + 1) % o.length]; return p.x * q.y - q.x * p.y; })) / 2;
    D.geo_info = [{ cells: D.geo.cells.length, area_km2: area / 1e6, w_km: (d3.max(o, (p) => p.x) - d3.min(o, (p) => p.x)) / 1000,
      h_km: (d3.max(o, (p) => p.y) - d3.min(o, (p) => p.y)) / 1000 }];
  };

  // ---------------------------------------------------------------- 컨트롤과 전체 그리기
  const PANEL = {
    intro: () => { renderRivers(); renderTimeline(); },
    map: () => { renderMaps(); renderStation(); renderSurveys(); },
    models: () => { renderSummary(); renderModels(); renderImportance(); },
    basin: () => { renderWatershed(); renderBasin(); renderLake(); renderSiteTable(); },
  };
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
    $$('.pw-seg button').forEach((b) => b.addEventListener('click', () => { S.target = b.dataset.target; writeHash(); renderSummary(); renderModels(); }));
    const tabs = $$('.pw-tabs [data-tab]');
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => setState({ tab: b.dataset.tab }));
      b.addEventListener('keydown', (ev) => {
        const j = ev.key === 'ArrowRight' ? i + 1 : ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : null;
        if (j === null) return;
        ev.preventDefault();
        const nb = tabs[(j + tabs.length) % tabs.length]; nb.focus(); setState({ tab: nb.dataset.tab });
      });
    });
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest('[data-goto]');
      if (!a) return;
      ev.preventDefault();
      setState({ tab: a.dataset.goto });
      document.querySelector('.pw-tabs').scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
    window.addEventListener('hashchange', () => { readHash(); S.date = clampDate(S.date); showTab(false); render(); });
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
    const hasField = !!D.survey_cells;
    document.getElementById('pw-obs-fig').hidden = !hasField;
    document.getElementById('pw-maps').classList.toggle('pw-maps-single', !hasField);
    document.getElementById('pw-note-field').hidden = !hasField;
    document.getElementById('pw-foot-full').hidden = !hasField;
    document.getElementById('pw-foot-public').hidden = hasField;
    document.getElementById('pw-map-obs').hidden = !(hasField && isSurvey);
    document.getElementById('pw-obs-none').hidden = !hasField || isSurvey;
    fillValues();
    PANEL[S.tab]();
  };
  const renderCharts = () => PANEL[S.tab]();

  const fail = (msg) => {
    const e = document.getElementById('pw-error');
    e.textContent = msg; e.hidden = false;
  };

  const start = async () => {
    readHash();
    showTab(false);
    try {
      const got = await Promise.all(FILES.map((f) => fetch(`data/${f}.json`).then((r) => {
        if (!r.ok) throw new Error(`data/${f}.json (${r.status})`);
        return r.json();
      })));
      FILES.forEach((f, i) => { D[f] = got[i]; });
      D.survey_cells = null;
      if (D.model_info[0].field_cells === true) {
        const r = await fetch('data/survey_cells.json').catch(() => null);
        D.survey_cells = r && r.ok ? await r.json() : null;
      }
      const rb = await fetch('data/basin.json').catch(() => null);      // 유역도 자료(없어도 됨)
      D.basin = rb && rb.ok ? await rb.json().catch(() => null) : null;
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
    derive();
    if (!D.geo.stations.some((s) => s.id === S.site)) S.site = DEFAULT.site;
    S.date = clampDate(S.date);
    setupControls();
    render();
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

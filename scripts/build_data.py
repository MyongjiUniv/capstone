"""대시보드 자료(data/*.json) 만들기.

캡스톤디자인 폴더의 모델 결과를 읽어 대시보드가 쓰는 JSON을 다시 만든다(공개용 10개, --public 없이 11개).
- 최종 수온 모형 E2-A(CatBoost)의 나무를 JSON으로 내보낸다. 브라우저는 이것으로 지도를 직접 계산한다.
- 날짜별 상류 입력, 조사 수역 격자의 09~17시 평균 예측 요약, 측정망 지점 예측·관측, 조사일 수표면 관측, 점수표를 만든다.
- 최종시험 구간을 다시 채점하지 않는다. 점수는 이미 저장된 결과 파일에서 옮겨 온다.

폴더 구조(기본): 캡스톤디자인/대시보드/scripts/build_data.py
  읽는 곳: 캡스톤디자인/모델구성/{0. 준비자료, 2. E1_E3_기계학습, 3. 최종시험_수온} (번호 없는 이름도 찾는다)
  쓰는 곳: 캡스톤디자인/대시보드/data/
다른 위치에서 실행할 때: python build_data.py --root "D:/.../캡스톤디자인"
공개 저장소용: python build_data.py --public  (현장 계측 셀 자료 survey_cells.json을 만들지 않고, 있으면 지운다)

필요 패키지: numpy, pandas, catboost (scripts/requirements.txt)
"""
import argparse
import datetime as dt
import json
import os
import struct
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
from catboost import CatBoostRegressor

HERE = Path(__file__).resolve().parent
FEATS = ['x', 'y', 'doy_sin', 'doy_cos', 'tod_sin', 'tod_cos', 'Tup_bukhan_d1', 'Tup_namhan_d1', 'Tup_gyeongan_d1']
UP = ['Tup_bukhan_d1', 'Tup_namhan_d1', 'Tup_gyeongan_d1']
HOURS = list(range(9, 18))             # 09~17시 매시 예측을 평균(시각 입력의 비물리적 진동을 고르게 함)
DATE_FROM, DATE_TO = '2023-08-01', '2026-03-31'
GRID_M = 100


def stage_of(d):
    return '개발학습' if d <= '2024-11-01' else ('개발검증' if d <= '2025-04-18' else '최종시험')


def finder(model_dir):
    def mdir(name):
        """'준비자료' 또는 '0. 준비자료' 형식의 폴더를 찾는다."""
        for p in [model_dir / name, *sorted(model_dir.glob(f'*. {name}'))]:
            if p.exists():
                return p
        raise FileNotFoundError(f'모델구성/{name} 폴더가 없습니다')
    return mdir


def read_polygon(shp):
    """단일 폴리곤 shp(shape type 5)의 첫 링 꼭짓점(UTM 52N, m)."""
    b = Path(shp).read_bytes()
    stype, = struct.unpack('<i', b[108:112])
    if stype != 5:
        raise ValueError(f'폴리곤이 아닙니다(shape type {stype})')
    nparts, npts = struct.unpack('<2i', b[144:152])
    parts = list(struct.unpack(f'<{nparts}i', b[152:152 + 4 * nparts])) + [npts]
    off = 152 + 4 * nparts
    xy = np.frombuffer(b[off:off + 16 * npts], dtype='<f8').reshape(-1, 2)
    return xy[parts[0]:parts[1]]


def inside(poly, px, py):
    """점이 폴리곤 안에 있는지(광선 교차)."""
    x, y = poly[:, 0], poly[:, 1]
    xj, yj = np.roll(x, 1), np.roll(y, 1)
    res = np.zeros(px.shape, bool)
    for i in range(len(poly)):
        cond = ((y[i] > py) != (yj[i] > py)) & (px < (xj[i] - x[i]) * (py - y[i]) / (yj[i] - y[i] + 1e-300) + x[i])
        res ^= cond
    return res


def phases(dates, tod_s):
    d = pd.to_datetime(pd.Series(list(dates)))
    L = np.where(d.dt.is_leap_year, 366, 365)
    phd = 2 * np.pi * (d.dt.dayofyear.to_numpy() - 1) / L
    pht = 2 * np.pi * np.asarray(tod_s, float) / 86400
    return np.sin(phd), np.cos(phd), np.sin(pht), np.cos(pht)


# ---------------------------------------------------------------- 모형별 성능 비교표
MODELS = {   # 모형ID: (계열, 이름, 입력)
    'E0-0': ('E0', '전체 평균', '없음'),
    'E0-1': ('E0', '계절 평균', '계절'),
    'E0-2': ('E0', '100 m 셀×계절 평균', '위치·계절'),
    'E0-3': ('E0', 'GAM', 'F0 위치·연중일·시각 (6개)'),
    'E1': ('E1', '랜덤포레스트', 'F4 (38개)'),
    'E2-A': ('E2', 'CatBoost', 'F1 +상류 전일 (9개)'),
    'E2-B': ('E2', 'CatBoost', 'F2 +유량 (15개)'),
    'E2-C': ('E2', 'CatBoost', 'F3 +기상 (23개)'),
    'E2-D': ('E2', 'CatBoost', 'F4 +3·7일 창 (38개)'),
    'E3': ('E3', 'LightGBM', 'F4 (38개)'),
}
SETS = {'전체가용': ('full', '전체 가용'), '공통완전사례': ('common', '공통 완전사례')}


def setting_text(v):
    if not isinstance(v, str) or not v.strip():
        return None
    p = json.loads(v)
    names = {'depth': '깊이', 'l2': 'l2', 'max_depth': '최대 깊이', 'msl': '잎 최소', 'num_leaves': '잎 수', 'mcs': '잎 최소'}
    return ', '.join(f'{names.get(k, k)} {x}' for k, x in p.items())


def model_comparison(ml, fin):
    """개발검증(12~14차)·LOSO(1~14차)·최종시험(15~18차) 점수를 모형별 한 행으로 모은다. 저장된 결과만 쓴다."""
    cmp_ = pd.read_csv(ml / '개발검증_비교표.csv')
    cmp_ = cmp_[cmp_.평가행 == '학습집합과 동일']
    boot = pd.read_csv(ml / '개발검증_재표집.csv')
    boot = boot[boot.학습집합 == boot.평가행].set_index(['목표', '학습집합', '모델'])
    loso = pd.read_csv(ml / 'LOSO_요약.csv')
    loso = loso[loso.비교기준 == 'E0-3'].set_index(['목표', '학습집합', '모델'])
    sc = pd.read_csv(fin / '수온_E2A_점수.csv')
    test = sc[(sc.단계 == 'test') & sc.폴드.isna()].set_index('실험ID')
    tboot = pd.read_csv(fin / '수온_시험_재표집.csv')
    tboot = tboot[tboot.평가행 == 'full'].set_index('모델')
    r3 = lambda v: None if pd.isna(v) else round(float(v), 3)
    rows = []
    for _, r in cmp_.iterrows():
        tgt, code = r.목표, SETS[r.학습집합][0]
        fam, name, inp = MODELS[r.실험ID]
        b = boot.loc[(tgt, code, r.실험ID)] if (tgt, code, r.실험ID) in boot.index else None
        lo = loso.loc[(tgt, code, r.실험ID)] if (tgt, code, r.실험ID) in loso.index else None
        t = test.loc[r.실험ID] if (tgt == 'Temp' and code == 'full' and r.실험ID.startswith('E0') and r.실험ID in test.index) else None
        rows.append({
            'target': tgt, 'set': SETS[r.학습집합][1], 'model': r.실험ID, 'family': fam, 'name': name, 'inputs': inp, 'stage': '비교',
            'setting': setting_text(r.설정), 'iterations': None if pd.isna(r.반복수) else int(r.반복수),
            'dv_rmse': r3(r.균형RMSE), 'dv_mae': r3(r.균형MAE), 'dv_r2': r3(r.R2), 'dv_bias': r3(r.평균편향),
            'dv_worst': r3(r.최악조사일RMSE), 'dv_worst_survey': int(r.최악조사차수),
            'dv_diff': None if b is None or r.실험ID == 'E0-3' else r3(b['E0*대비_차이']),
            'dv_lo': None if b is None or r.실험ID == 'E0-3' else r3(b['차이_2.5%']),
            'dv_hi': None if b is None or r.실험ID == 'E0-3' else r3(b['차이_97.5%']),
            'loso_rmse': None if lo is None else r3(lo.RMSE_평균), 'loso_days': None if lo is None else int(lo.조사일수),
            'loso_better': None if lo is None or r.실험ID == 'E0-3' else int(lo.기준보다_좋은_조사일수),
            'test_rmse': None if t is None else r3(t.균형RMSE), 'test_mae': None if t is None else r3(t.균형MAE),
            'test_r2': None if t is None else r3(t.R2), 'test_bias': None if t is None else r3(t.평균편향),
            'test_diff': None, 'test_lo': None, 'test_hi': None})
    # 최종 후보: E2-A 재튜닝(수온, 전체 가용)
    dv = sc[(sc.실험ID == 'E2-A') & (sc.단계 == 'dev_val')].iloc[0]
    le = sc[(sc.실험ID == 'E2-A') & (sc.단계 == 'loso')].copy()
    le['survey'] = le.폴드.str.replace('차', '').astype(int)
    lg = pd.read_csv(ml / 'LOSO_조사일별.csv')
    lg = lg[(lg.목표 == 'Temp') & (lg.set == 'full')].set_index('survey')['E0-3']
    better = int(sum(float(x) < float(lg.loc[k]) for k, x in zip(le.survey, le.균형RMSE)))
    cfg = json.loads((fin / '수온_최종시험_설정.json').read_text(encoding='utf-8'))
    t, tb = test.loc['E2-A'], tboot.loc['E2-A']
    rows.append({
        'target': 'Temp', 'set': '전체 가용', 'model': 'E2-A 최종', 'family': 'E2', 'name': 'CatBoost 최종 후보(재튜닝)',
        'inputs': 'F1 +상류 전일 (9개)', 'stage': '최종',
        'setting': f"깊이 {cfg['grid_choice']['depth']}, l2 {cfg['grid_choice']['l2']}", 'iterations': int(cfg['iter_inner_median']),
        'dv_rmse': r3(dv['균형RMSE']), 'dv_mae': r3(dv['균형MAE']), 'dv_r2': r3(dv['R2']), 'dv_bias': r3(dv['평균편향']),
        'dv_worst': r3(dv['최악조사일RMSE']), 'dv_worst_survey': int(dv['최악조사차수']), 'dv_diff': None, 'dv_lo': None, 'dv_hi': None,
        'loso_rmse': r3(le['균형RMSE'].mean()), 'loso_days': int(len(le)), 'loso_better': better,
        'test_rmse': r3(t.균형RMSE), 'test_mae': r3(t.균형MAE), 'test_r2': r3(t.R2), 'test_bias': r3(t.평균편향),
        'test_diff': r3(tb['기준대비_차이']), 'test_lo': r3(tb['차이_2.5%']), 'test_hi': r3(tb['차이_97.5%']),
        'final_iterations': int(cfg['iter_final(dev_val early stop)'])})
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default=os.environ.get('CAPSTONE_ROOT', str(HERE.parents[1])), help='캡스톤디자인 폴더')
    ap.add_argument('--out', default=str(HERE.parent / 'data'), help='JSON을 쓸 폴더')
    ap.add_argument('--public', action='store_true', help='공개용: 현장 계측 셀 자료(survey_cells.json)를 빼고 만든다')
    a = ap.parse_args()
    root, out = Path(a.root), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    mdir = finder(root / '모델구성')
    prep, ml, fin = mdir('준비자료'), mdir('E1_E3_기계학습'), mdir('최종시험_수온')

    def dump(name, rows):
        p = out / f'{name}.json'
        p.write_text(json.dumps(rows, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
        print(f'{name:14s} {len(rows):6d}행  {p.stat().st_size / 1024:6.0f} KB')

    meta = json.loads((prep / '준비_메타.json').read_text(encoding='utf-8'))
    survey = {int(k): v for k, v in meta['survey_dates'].items()}
    d2s = {v: k for k, v in survey.items()}

    # ---- 모형
    m = CatBoostRegressor()
    m.load_model(str(fin / 'E2A_수온_최종모형.cbm'))
    with tempfile.TemporaryDirectory() as td:
        jp = Path(td) / 'model.json'
        m.save_model(str(jp), format='json')
        j = json.loads(jp.read_text())
    trees = [{'tree': k, 'f': [s['float_feature_index'] for s in t['splits']], 'b': [s['border'] for s in t['splits']],
              'v': t['leaf_values']} for k, t in enumerate(j['oblivious_trees'])]
    dump('model_trees', trees)
    cfg = json.loads((fin / '수온_최종시험_설정.json').read_text(encoding='utf-8'))
    dump('model_info', [{'scale': j['scale_and_bias'][0], 'bias': j['scale_and_bias'][1][0], 'features': ','.join(FEATS),
                         'hour_from': HOURS[0], 'hour_to': HOURS[-1], 'trees': len(trees), 'depth': cfg['grid_choice']['depth'],
                         'l2': cfg['grid_choice']['l2'], 'train_rows': cfg['train_rows_final'], 'train_end': cfg['train_dates_max'],
                         'test_rows': cfg['test_rows'], 'built_at': dt.date.today().isoformat(), 'field_cells': not a.public}])

    # ---- 기하: 조사 수역 안 100 m 격자, 경계, 측정망
    poly = read_polygon(prep / 'polygon' / 'polygon.shp')
    xs = np.arange(np.floor(poly[:, 0].min() / GRID_M) * GRID_M + GRID_M / 2, poly[:, 0].max(), GRID_M)
    ys = np.arange(np.floor(poly[:, 1].min() / GRID_M) * GRID_M + GRID_M / 2, poly[:, 1].max(), GRID_M)
    gx, gy = np.meshgrid(xs, ys)
    keep = inside(poly, gx.ravel(), gy.ravel())
    G = pd.DataFrame({'x': gx.ravel()[keep], 'y': gy.ravel()[keep]})
    obs = pd.read_csv(prep / 'observations.csv.gz', low_memory=False,
                      usecols=['obs_idx', 'source', 'survey_id', 'date', 'tod_s', 'x', 'y', 'site_id', 'Temp', 'cell100',
                               'doy_sin', 'doy_cos', 'tod_sin', 'tod_cos'])
    eli = pd.read_csv(prep / 'eligibility.csv.gz', usecols=['obs_idx', 'Temp_full_ok'])
    obs = obs.merge(eli, on='obs_idx')
    st = obs[obs.source == 'lake'].groupby('site_id')[['x', 'y']].first().sort_index()
    geo = [{'kind': 'grid', 'id': f'g{i}', 'x': float(r.x), 'y': float(r.y)} for i, r in G.iterrows()]
    geo += [{'kind': 'outline', 'id': f'o{i}', 'x': round(float(x), 1), 'y': round(float(y), 1)} for i, (x, y) in enumerate(poly)]
    geo += [{'kind': 'station', 'id': s, 'x': round(float(r.x), 1), 'y': round(float(r.y), 1)} for s, r in st.iterrows()]
    dump('lake_geometry', geo)

    # ---- 날짜별 입력과 격자 예측 요약
    F = pd.read_csv(prep / 'features_daily.csv')
    F = F[(F.date >= DATE_FROM) & (F.date <= DATE_TO)].reset_index(drop=True)
    nd, ng = len(F), len(G)
    P = np.zeros((nd, ng))
    Ps = np.zeros((len(st), nd))
    for h in HOURS:
        ds, dc, ts, tc = phases(F.date, np.full(nd, h * 3600))
        X = np.column_stack([np.tile(G.x, nd), np.tile(G.y, nd), np.repeat(ds, ng), np.repeat(dc, ng), np.repeat(ts, ng),
                             np.repeat(tc, ng), *(np.repeat(F[c], ng) for c in UP)]).astype(np.float32)
        P += m.predict(X).reshape(nd, ng) / len(HOURS)
        Xs = [np.column_stack([np.full(nd, r.x), np.full(nd, r.y), ds, dc, ts, tc, *(F[c] for c in UP)]) for _, r in st.iterrows()]
        Ps += m.predict(np.vstack(Xs).astype(np.float32)).reshape(len(st), nd) / len(HOURS)
    rnd = lambda v, k=6: None if pd.isna(v) else round(float(v), k)     # 모형 입력은 반올림하지 않음(6자리)
    daily = []
    for i, r in F.iterrows():
        daily.append({'date': r.date, 'stage': stage_of(r.date), 'survey': d2s.get(r.date), 'up_bukhan': rnd(r.Tup_bukhan_d1),
                      'up_namhan': rnd(r.Tup_namhan_d1), 'up_gyeongan': rnd(r.Tup_gyeongan_d1),
                      'missing_inputs': int(r[UP].isna().sum()), 'pred_mean': round(float(P[i].mean()), 2),
                      'pred_min': round(float(P[i].min()), 2), 'pred_max': round(float(P[i].max()), 2)})
    dump('daily', daily)

    # ---- 측정망 지점: 날짜별 평균 예측, 관측(수층 평균), 관측 시각 예측
    L = obs[(obs.source == 'lake') & obs.Temp_full_ok].merge(F[['date', *UP]], on='date', how='left')
    L['pred'] = m.predict(L[FEATS].to_numpy(np.float32))
    Lg = L.groupby(['site_id', 'date']).agg(obs=('Temp', 'mean'), pred_obs=('pred', 'mean'), layers=('Temp', 'size'))
    srows = []
    for k, s in enumerate(st.index):
        for i, d in enumerate(F.date):
            o = Lg.loc[(s, d)] if (s, d) in Lg.index else None
            srows.append({'date': d, 'site': s, 'stage': stage_of(d), 'pred_day': round(float(Ps[k, i]), 2),
                          'missing_inputs': int(F.loc[i, UP].isna().sum()),
                          'obs': None if o is None else round(float(o.obs), 2),
                          'pred_at_obs': None if o is None else round(float(o.pred_obs), 2),
                          'layers': None if o is None else int(o.layers)})
    dump('station_daily', srows)

    # ---- 조사일 수표면 관측(100 m 셀 평균)
    S = obs[(obs.source == 'surface') & obs.Temp_full_ok]
    Sg = S.groupby(['survey_id', 'cell100']).agg(x=('x', 'mean'), y=('y', 'mean'), obs=('Temp', 'mean'), n=('Temp', 'size')).reset_index()
    if a.public:
        (out / 'survey_cells.json').unlink(missing_ok=True)
        print('survey_cells   공개용이라 만들지 않음(현장 계측 원자료)')
    else:
        dump('survey_cells', [{'survey': int(r.survey_id), 'date': survey[int(r.survey_id)], 'cell': str(r.cell100),
                               'x': round(float(r.x), 1), 'y': round(float(r.y), 1), 'obs': round(float(r.obs), 2), 'n': int(r.n)}
                              for r in Sg.itertuples()])

    # ---- 점수(저장된 결과에서 옮김)
    sc = pd.read_csv(fin / '수온_E2A_점수.csv')
    cmp_ = pd.read_csv(ml / '개발검증_비교표.csv')
    gdv = cmp_[(cmp_.실험ID == 'E0-3') & (cmp_.목표 == 'Temp') & (cmp_.학습집합 == '전체가용')].iloc[0]
    loso_g = pd.read_csv(ml / 'LOSO_조사일별.csv')
    loso_g = loso_g[(loso_g.목표 == 'Temp') & (loso_g.set == 'full')].set_index('survey')['E0-3']
    loso_e = sc[(sc.실험ID == 'E2-A') & (sc.단계 == 'loso')].copy()
    loso_e['survey'] = loso_e.폴드.str.replace('차', '').astype(int)
    loso_e = loso_e.set_index('survey')
    rows = []

    def srow(stage, model, r):
        rows.append({'stage': stage, 'model': model, 'rmse': round(float(r['균형RMSE']), 3), 'mae': round(float(r['균형MAE']), 3),
                     'r2': round(float(r['R2']), 3), 'bias': round(float(r['평균편향']), 3)})
    srow('개발검증', 'E2-A', sc[(sc.실험ID == 'E2-A') & (sc.단계 == 'dev_val')].iloc[0])
    srow('개발검증', 'E0-3', gdv)
    for mid in ['E2-A', 'E0-3', 'E0-2', 'E0-1', 'E0-0']:
        srow('최종시험', mid, sc[(sc.실험ID == mid) & (sc.단계 == 'test') & sc.폴드.isna()].iloc[0])
    rows.append({'stage': 'LOSO 평균', 'model': 'E2-A', 'rmse': round(float(loso_e['균형RMSE'].mean()), 3), 'mae': None, 'r2': None, 'bias': None})
    rows.append({'stage': 'LOSO 평균', 'model': 'E0-3', 'rmse': round(float(loso_g.loc[1:14].mean()), 3), 'mae': None, 'r2': None, 'bias': None})
    dump('scores', rows)
    bt = pd.read_csv(fin / '수온_시험_재표집.csv')
    b = bt[(bt.평가행 == 'full') & (bt.모델 == 'E2-A')].iloc[0]
    dump('test_diff', [{'compare': 'E2-A − E0-3', 'diff': round(float(b['기준대비_차이']), 3), 'lo': round(float(b['차이_2.5%']), 3),
                        'hi': round(float(b['차이_97.5%']), 3), 'p_better': round(float(b['P(차이<0)']), 3),
                        'field_days': int(b['현장조사일수']), 'lake_days': int(b['측정망날짜수'])}])
    ts = pd.read_csv(fin / '수온_E2A_조사차수별.csv')
    ts = ts[(ts.단계 == 'test') & ts.폴드.isna()]
    surv = []
    for k in sorted(survey):
        if k <= 14:
            surv.append({'survey': k, 'date': survey[k], 'check': 'LOSO', 'e2a': round(float(loso_e.loc[k, '균형RMSE']), 3),
                         'gam': round(float(loso_g.loc[k]), 3)})
        else:
            e = ts[(ts.실험ID == 'E2-A') & (ts.survey == k)].iloc[0]
            g = ts[(ts.실험ID == 'E0-3') & (ts.survey == k)].iloc[0]
            surv.append({'survey': k, 'date': survey[k], 'check': '최종시험', 'e2a': round(float(e['균형RMSE']), 3),
                         'gam': round(float(g['균형RMSE']), 3)})
    dump('survey_scores', surv)
    imp = pd.read_csv(fin / '수온_E2A_최종모형_중요도.csv', index_col=0).iloc[:, 0]
    lab = {'x': '위치 x', 'y': '위치 y', 'doy_sin': '연중일 sin', 'doy_cos': '연중일 cos', 'tod_sin': '시각 sin', 'tod_cos': '시각 cos',
           'Tup_bukhan_d1': '북한강(가평) 전일 수온', 'Tup_namhan_d1': '남한강(양평) 전일 수온', 'Tup_gyeongan_d1': '경안천 전일 수온'}
    dump('importance', [{'variable': lab[k], 'share': round(float(v), 2)} for k, v in imp.items()])
    dump('model_comparison', model_comparison(ml, fin))

    # ---- 점검: 브라우저와 같은 계산식(나무 직접 계산)이 CatBoost 예측과 같은지
    rng = np.random.default_rng(1)
    Xc = X[rng.choice(len(X), 2000, replace=False)]
    ref = m.predict(Xc)
    Xe = np.where(np.isnan(Xc.astype(np.float64)), -np.inf, Xc.astype(np.float64))
    acc = np.zeros(len(Xe))
    for t in trees:
        idx = np.zeros(len(Xe), int)
        for i, (f, bd) in enumerate(zip(t['f'], t['b'])):
            idx |= (Xe[:, f] > bd).astype(int) << i
        acc += np.asarray(t['v'])[idx]
    diff = np.abs(j['scale_and_bias'][1][0] + j['scale_and_bias'][0] * acc - ref).max()
    print(f'나무 직접 계산과 CatBoost 예측의 최대 차이: {diff:.2e}  (격자 {ng}칸, 날짜 {nd}일, 측정망 {len(st)}곳)')
    if diff > 1e-6:
        raise SystemExit('나무 직접 계산이 CatBoost 예측과 다릅니다. 모형 형식을 확인하세요.')


if __name__ == '__main__':
    main()

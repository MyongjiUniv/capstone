"""유역·자료 화면의 지도 자료(data/basin.json) 만들기.

- 하천·호소 수면: scripts/geo/osm_water.txt, scripts/geo/osm_rivers.txt
  (OpenStreetMap, © OpenStreetMap contributors, ODbL). Overpass API로 받아 단순화·부호화한 것이다(형식은 파일 머리말).
- 자료 지점: 아래 SITES 표. 팔당호 수질측정망 5곳은 data/lake_geometry.json의 자료 좌표(UTM 52N)를 쓴다.
  기상관측소는 기상청 관측지점정보의 좌표다. 자동측정망 3곳은 원자료에 좌표가 없어 도로명주소를 OpenStreetMap 도로의 건물번호 위치에 보간했고,
  경안천 유량 지점(광주시(경안교))은 쌍령동 쪽 경안교의 OSM 위치다.
- 유역 경계(선택): --basin-shp 로 중권역(또는 표준유역) shp를 주면 북한강·남한강·경안천·팔당호 직접 유역으로 묶어 넣는다.
  이름 열은 --name-field 로 고르고, 묶음은 GROUP_KEYS의 낱말로 정한다. 없으면 유역도 카드는 숨겨진다.

사용:
  python scripts/build_basin.py
  python scripts/build_basin.py --basin-shp "C:/Users/<사용자>/한강중권역/중권역.shp" --name-field MBSN_NM

필요 패키지: numpy, shapely, pyproj, pyshp (scripts/requirements.txt)
"""
import argparse
import json
from pathlib import Path

import numpy as np
from pyproj import CRS, Transformer
from shapely.geometry import LineString, MultiPolygon, Polygon, box, mapping, shape
from shapely.geometry.polygon import orient
import warnings
from shapely.ops import linemerge, polygonize, transform, unary_union
warnings.filterwarnings("ignore", category=DeprecationWarning)

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
UTM = 'EPSG:32652'
TO_LL = Transformer.from_crs(UTM, 'EPSG:4326', always_xy=True)
TO_UTM = Transformer.from_crs('EPSG:4326', UTM, always_xy=True)

REGION = [127.17, 37.355, 127.60, 37.865]        # 「유입 하천과 자료 지점」 지도 범위(서, 남, 동, 북)

# kind: lake_wq 팔당호 수질측정망 · auto_wq 수질자동측정망 · flow 유량 · weather 기상 · dam 댐(자료로 쓰지 않음)
# precision: 자료 좌표 · 공식(운영 기관 공개 좌표, 기상청 관측지점정보) · OSM(시설 위치)
#            · 주소(도로명주소를 OpenStreetMap 도로의 건물번호 위치에 보간, 오차 100 m 안팎) · 근사
SITES = [
    dict(id='auto_bukhan', kind='auto_wq', name='가평 수질자동측정소', short='가평 측정소', river='북한강',
         data='수온·EC · 시간 자료', use='모형 입력: 북한강 전일 수온(E2-A)', lat=37.65921, lon=127.37923, precision='주소', dx=-9, dy=4,
         addr='경기도 가평군 청평면 북한강로 1537 (삼회리 617-4)'),
    dict(id='auto_namhan', kind='auto_wq', name='양평 수질자동측정소', short='양평 측정소', river='남한강',
         data='수온·EC · 시간 자료', use='모형 입력: 남한강 전일 수온(E2-A)', lat=37.50772, lon=127.45139, precision='주소', dx=8, dy=-6,
         addr='경기도 양평군 옥천면 경강로 1520 (옥천리 913-4)'),
    dict(id='auto_gyeongan', kind='auto_wq', name='경안천 수질자동측정소', short='경안천 측정소', river='경안천',
         data='수온·EC · 시간 자료', use='모형 입력: 경안천 전일 수온(E2-A)', lat=37.44237, lon=127.31107, precision='주소', dx=8, dy=-6,
         addr='경기도 광주시 퇴촌면 산수로 969 (정지리 192-3, 서하보)'),
    dict(id='flow_cheongpyeong', kind='flow', name='청평댐 방류량', short='청평댐', river='북한강',
         data='방류량 · 일', use='후보 입력: 북한강 유량(E2-B~D)', lat=37.72521, lon=127.42069, precision='OSM', dx=-9, dy=4),
    dict(id='flow_ipo', kind='flow', name='이포보 방류량', short='이포보', river='남한강',
         data='방류량 · 일', use='후보 입력: 남한강 유량(E2-B~D)', lat=37.40470, lon=127.54061, precision='OSM', dx=-9, dy=4),
    dict(id='flow_gyeongan', kind='flow', name='광주시(경안교) 수위관측소', short='경안교', river='경안천',
         data='유량 · 일', use='후보 입력: 경안천 유량(E2-B~D)', lat=37.40598, lon=127.26352, precision='OSM', dx=8, dy=12,
         addr='경기도 광주시 쌍령동 경안교'),
    dict(id='met_yangpyeong', kind='weather', name='양평 ASOS(202)', short='양평 ASOS', river='남한강 인근',
         data='기온·강수·바람 · 시간 → 일', use='후보 입력: 기상(E2-C·D)', lat=37.4886, lon=127.4945, precision='공식', dx=8, dy=14),
    dict(id='met_gwangju', kind='weather', name='경기광주 AWS', short='경기광주 AWS', river='경안천 인근',
         data='기온·강수·바람 · 시간 → 일', use='후보 입력: 기상(E2-C·D)', lat=37.4353, lon=127.2592, precision='공식', dx=-9, dy=12),
    dict(id='met_cheongpyeong', kind='weather', name='청평 AWS', short='청평 AWS(제외)', river='북한강 인근',
         data='기온·강수·바람 · 시간 → 일', use='2025.3~5 결측이 길어 입력에서 뺐다', lat=37.6841, lon=127.3802, precision='공식', dx=8, dy=4),
    dict(id='dam_paldang', kind='dam', name='팔당댐', short='팔당댐', river='한강',
         data='방류량·수위', use='모형에 쓰지 않음(위치 참고)', lat=37.52649, lon=127.27922, precision='OSM', dx=-9, dy=12),
]

# 하천 이름 표시(지역 지도). 위치는 하천선 위 대략의 점, 각도는 글자 방향(도).
LABELS = [
    dict(text='북한강', lon=127.385, lat=37.640, rotate=62),
    dict(text='남한강', lon=127.445, lat=37.462, rotate=-28),
    dict(text='경안천', lon=127.2525, lat=37.379, rotate=75),
    dict(text='한강', lon=127.205, lat=37.553, rotate=-25),
    dict(text='팔당호', lon=127.325, lat=37.505, rotate=0),
    dict(text='청평호', lon=127.468, lat=37.722, rotate=-40),
]
MAIN_RIVERS = {'북한강': 2.4, '남한강': 2.8, '한강': 2.8, '경안천': 1.6}

# 유역 묶음: 중권역 이름에 들어 있는 낱말
GROUP_KEYS = {
    '북한강': ['북한강', '화천', '춘천', '소양', '의암', '홍천', '청평', '평화의'],
    '남한강': ['남한강', '평창', '충주', '달천', '섬강', '동강', '서강', '한강상류'],
    '경안천': ['경안'],
    '팔당호': ['팔당'],
}


def decode(code):
    """'x,y dx,dy ...'(1e-4도, (127°, 37°) 기준 차분) → [(lon, lat), ...]"""
    x = y = 0
    out = []
    for i, tok in enumerate(code.split()):
        a, b = map(int, tok.split(','))
        x, y = (a, b) if i == 0 else (x + a, y + b)
        out.append((127 + x / 1e4, 37 + y / 1e4))
    return out


def read_osm_lines(path):
    feats = []
    for ln in Path(path).read_text(encoding='utf-8').splitlines():
        if not ln.strip() or ln.startswith('#'):
            continue
        name, code = ln.split('|', 1)
        pts = decode(code)
        if len(pts) > 1:
            feats.append((name, LineString(pts)))
    return feats


def read_osm_water(path):
    feats = []
    for ln in Path(path).read_text(encoding='utf-8').splitlines():
        if not ln.strip() or ln.startswith('#'):
            continue
        oid, name, parts = ln.split('|', 2)
        outer, inner = [], []
        for part in parts.split(';'):
            role, code = part.split(':', 1)
            pts = decode(code)
            if len(pts) > 1:
                (inner if role == 'i' else outer).append(LineString(pts))
        polys = list(polygonize(unary_union(outer))) if outer else []      # unary_union으로 교차점을 노드로 만든다
        if not polys:
            continue
        g = unary_union(polys)
        holes = list(polygonize(unary_union(inner))) if inner else []
        if holes:
            g = g.difference(unary_union(holes))
        feats.append((name, g.buffer(0)))
    return feats


def ll_ring(xy):
    x, y = TO_LL.transform(np.asarray(xy)[:, 0], np.asarray(xy)[:, 1])
    return np.column_stack([x, y])


def rnd(geom, k=5):
    return json.loads(json.dumps(mapping(geom)), parse_float=lambda s: round(float(s), k))


def cw(geom):
    """d3-geo는 바깥 고리가 시계 방향이어야 한다(RFC 7946과 반대)."""
    if isinstance(geom, Polygon):
        return orient(geom, sign=-1.0)
    if isinstance(geom, MultiPolygon):
        return MultiPolygon([orient(p, sign=-1.0) for p in geom.geoms])
    return geom


def fc(feats):
    return {'type': 'FeatureCollection', 'features': feats}


def read_shp_basins(path, name_field, simplify_m):
    import shapefile
    r = shapefile.Reader(str(path), encoding='cp949')
    prj = Path(path).with_suffix('.prj')
    src = CRS.from_wkt(prj.read_text(encoding='utf-8', errors='ignore')) if prj.exists() else CRS.from_epsg(5186)
    to_utm = Transformer.from_crs(src, UTM, always_xy=True).transform
    fields = [f[0] for f in r.fields[1:]]
    if name_field not in fields:
        raise SystemExit(f'--name-field {name_field} 가 없습니다. 열: {fields}')
    groups = {k: [] for k in GROUP_KEYS}
    for sr in r.iterShapeRecords():
        nm = str(sr.record[name_field])
        g = next((k for k, keys in GROUP_KEYS.items() if any(w in nm for w in keys)), None)
        if g:
            groups[g].append(transform(to_utm, shape(sr.shape.__geo_interface__)).buffer(0))
    feats, areas = [], {}
    for g, geoms in groups.items():
        if not geoms:
            continue
        u = unary_union(geoms).simplify(simplify_m)
        areas[g] = u.area / 1e6
        ll = transform(lambda x, y, z=None: TO_LL.transform(x, y), u)
        feats.append({'type': 'Feature', 'properties': {'group': g, 'label': g if g != '팔당호' else '',
                      'legend': f'{g} 유역' if g != '팔당호' else '팔당호 직접 유역', 'area_km2': round(areas[g])},
                      'geometry': rnd(cw(ll), 4)})
    whole = unary_union([unary_union(v) for v in groups.values() if v]).simplify(simplify_m)
    outline = rnd(cw(transform(lambda x, y, z=None: TO_LL.transform(x, y), whole)), 4)
    facts = [{'k': f'{g} 유역', 'v': f'{a:,.0f} km² ({a / whole.area * 1e6 * 100:.1f}%)'} for g, a in areas.items()]
    facts.append({'k': '합계', 'v': f'{whole.area / 1e6:,.0f} km²'})
    return fc(feats), {'type': 'Feature', 'properties': {}, 'geometry': outline}, facts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--basin-shp', help='중권역(또는 표준유역) shp. 없으면 유역 경계 없이 만든다')
    ap.add_argument('--name-field', default='MBSN_NM', help='유역 이름 열')
    ap.add_argument('--simplify', type=float, default=300.0, help='유역 경계 단순화 허용 오차(m)')
    a = ap.parse_args()

    geo = json.loads((ROOT / 'data/lake_geometry.json').read_text(encoding='utf-8'))
    outline = np.array([[r['x'], r['y']] for r in geo if r['kind'] == 'outline'])
    stations = [r for r in geo if r['kind'] == 'station']

    # ---- 자료 지점
    sites = []
    for r in stations:
        lon, lat = TO_LL.transform(r['x'], r['y'])
        sites.append(dict(id=r['id'], kind='lake_wq', name=r['id'], short=r['id'], river='팔당호',
                          data='수온·EC 등 · 대개 주 1회 · 수층별', use='정답·검증(측정망 시계열)',
                          lat=round(lat, 5), lon=round(lon, 5), precision='자료 좌표'))
    sites += SITES

    # ---- 조사 수역 범위(위경도)
    ll = ll_ring(outline)
    lake_box = [round(float(v), 5) for v in (ll[:, 0].min(), ll[:, 1].min(), ll[:, 0].max(), ll[:, 1].max())]

    # ---- 수면·하천(OSM)
    reg = box(*REGION)
    water_feats, lake_utm = [], []
    pts = np.vstack([outline, [[r['x'], r['y']] for r in stations]])
    lake_win = box(pts[:, 0].min() - 900, pts[:, 1].min() - 900, pts[:, 0].max() + 900, pts[:, 1].max() + 900)
    for name, g in read_osm_water(HERE / 'geo/osm_water.txt'):
        gi = g.intersection(reg)
        if not gi.is_empty:
            water_feats.append({'type': 'Feature', 'properties': {'name': name},
                                'geometry': rnd(cw(gi), 4)})
        gu = transform(lambda x, y, z=None: TO_UTM.transform(x, y), g).intersection(lake_win)
        for p in getattr(gu, 'geoms', [gu]):
            if isinstance(p, Polygon) and not p.is_empty:
                p = p.simplify(8)
                lake_utm.append([[round(x), round(y)] for x, y in p.exterior.coords])
                lake_utm += [[[round(x), round(y)] for x, y in i.coords] for i in p.interiors]
    river_feats = []
    for nm, g in read_osm_lines(HERE / 'geo/osm_rivers.txt'):
        g = g.intersection(reg)
        if g.is_empty:
            continue
        river_feats.append({'type': 'Feature', 'properties': {'name': nm, 'w': MAIN_RIVERS.get(nm, 0.8)},
                            'geometry': rnd(g, 4)})

    # 조사 수역 지도의 하천 이름(UTM)
    lake_labels = [dict(text='북한강', x=351150, y=4157700, anchor='start'), dict(text='남한강', x=357900, y=4152450, anchor='middle'),
                   dict(text='경안천', x=349700, y=4148900, anchor='start'), dict(text='한강(팔당댐 아래)', x=347600, y=4153300, anchor='end')]

    out = {
        'note': '',
        'source': 'OpenStreetMap(하천·호소 수면, 댐·보 위치), data/lake_geometry.json(팔당호 수질측정망), 기상청 관측지점정보(기상관측소), 도로명주소 보간(자동측정망), OSM 교량 위치(경안교)',
        'region': REGION, 'lake_box': lake_box,
        'water': fc(water_feats), 'rivers': fc(river_feats), 'labels': LABELS,
        'sites': sites, 'lake_utm': lake_utm, 'lake_labels': lake_labels,
        'facts': [
            {'k': '모형 입력', 'v': '가평·양평·경안천 수질자동측정망 전일 수온'},
            {'k': '후보 입력(유량)', 'v': '청평댐·이포보 방류량, 경안천 유량'},
            {'k': '후보 입력(기상)', 'v': '양평 ASOS, 경기광주 AWS(청평 AWS 제외)'},
            {'k': '정답·검증', 'v': '현장 계측 1~18차, 팔당호 수질측정망 5곳'},
            {'k': '수면·하천', 'v': '© OpenStreetMap contributors'},
        ],
    }
    if a.basin_shp:
        basins, bo, facts = read_shp_basins(a.basin_shp, a.name_field, a.simplify)
        out.update({'basins': basins, 'basin_outline': bo, 'ws_facts': facts,
                    'ws_rivers': fc([f for f in river_feats if f['properties']['w'] > 1])})
    p = ROOT / 'data/basin.json'
    p.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'basin.json {p.stat().st_size / 1024:.0f} KB · 수면 {len(water_feats)} · 하천 {len(river_feats)} · 지점 {len(sites)}'
          + (f" · 유역 {len(out['basins']['features'])}" if 'basins' in out else ' · 유역 경계 없음'))


if __name__ == '__main__':
    main()

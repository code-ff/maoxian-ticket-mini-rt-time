// utils/geo.js
// 「按用户 GPS 选最近站点」的纯计算层：球面距离 + 坐标系归一 + 默认选中站决策。
// 不依赖 wx / 页面 / 网络 / 任何业务模块，可直接在 Node 下单测。
//
// ⚠️ 坐标系假设（需真机核实，见 小程序项目档案.md）：
//   后端 /geo_data/stations 的 point.lon/lat 与车辆 GPS 的 lon/lat 同系，但接口未声明坐标系。
//   公交终端上报的多为 WGS84 原始 GPS；wx.getLocation 当前取 gcj02。二者在国内相差约 300~600m，
//   而本项目真实站间距中位数约 564m —— 不统一坐标系会系统性选错约 1 站。
//   因此提供 config.NEAREST_STATION.stationCoord 显式声明，默认按 'wgs84' 处理并转成 gcj02 再比；
//   真机核对后若发现站点本身就是 gcj02，把该配置改成 'gcj02' 即不做任何转换。

const PI = 3.1415926535897932384626;
const EARTH_R = 6371008.8;          // 平均地球半径（米）
const KRAS_A = 6378245.0;           // GCJ-02 偏移算法所用克拉索夫斯基椭球长半轴
const KRAS_EE = 0.00669342162296594323;

function toRad(deg) { return deg * PI / 180; }

/** Haversine 球面距离，单位：米 */
function distanceMeters(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function outOfChina(lon, lat) {
  return lon < 72.004 || lon > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

/**
 * 业界公开的 GCJ-02 偏移算法：WGS84 → GCJ02，返回 [lon, lat]。
 * 境外坐标不转换。算法本身以国家公开标准为准，业务上请用真机实测校准 stationCoord 配置。
 */
function wgs84ToGcj02(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = toRad(lat);
  let magic = Math.sin(radLat);
  magic = 1 - KRAS_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((KRAS_A * (1 - KRAS_EE)) / (magic * sqrtMagic) * PI);
  dLon = (dLon * 180.0) / (KRAS_A / sqrtMagic * Math.cos(radLat) * PI);
  return [lon + dLon, lat + dLat];
}

/** GCJ02 → WGS84：用正解做 3 次迭代反解，精度足够做站点匹配 */
function gcj02ToWgs84(lon, lat) {
  if (outOfChina(lon, lat)) return [lon, lat];
  let wLon = lon;
  let wLat = lat;
  for (let i = 0; i < 3; i++) {
    const g = wgs84ToGcj02(wLon, wLat);
    wLon += lon - g[0];
    wLat += lat - g[1];
  }
  return [wLon, wLat];
}

/** 把站点坐标统一到 GPS 所在的坐标系 */
function normalizeStationPoint(lon, lat, opt) {
  const from = (opt && opt.stationCoord) || 'gcj02';
  const to = (opt && opt.gpsCoord) || 'gcj02';
  if (from === to) return [lon, lat];
  if (from === 'wgs84' && to === 'gcj02') return wgs84ToGcj02(lon, lat);
  if (from === 'gcj02' && to === 'wgs84') return gcj02ToWgs84(lon, lat);
  return [lon, lat];
}

/**
 * 在当前方向的站点序列里找离用户最近的站。
 * @param {{latitude:number, longitude:number}} location 用户定位
 * @param {Array<{code?:string,name?:string,lon?:number,lat?:number,point?:{lon:number,lat:number}}>} stations
 * @param {{stationCoord?:string, gpsCoord?:string}} opt
 * @returns {{index:number, distance:number, code:string, name:string}|null}
 */
function nearestStation(location, stations, opt) {
  if (!location || !Array.isArray(stations) || !stations.length) return null;
  const lat0 = Number(location.latitude);
  const lon0 = Number(location.longitude);
  if (!isFinite(lat0) || !isFinite(lon0)) return null;

  let best = null;
  for (let i = 0; i < stations.length; i++) {
    const s = stations[i] || {};
    const pt = s.point || {};
    const lon = Number(s.lon != null ? s.lon : pt.lon);
    const lat = Number(s.lat != null ? s.lat : pt.lat);
    // 0 / NaN / 越界都视为无效坐标，直接跳过，不参与最近站竞争
    if (!isFinite(lon) || !isFinite(lat) || lon === 0 || lat === 0 ||
        lon < 72 || lon > 138 || lat < 0.8 || lat > 56) continue;
    const p = normalizeStationPoint(lon, lat, opt);
    const d = distanceMeters(lat0, lon0, p[1], p[0]);
    if (!best || d < best.distance) {
      best = { index: i, distance: d, code: String(s.code || ''), name: s.name || '' };
    }
  }
  return best;
}

/**
 * 决定详情页「默认选中站」：能用最近站就用，否则原样回退到旧的「首辆车下一站」。
 * 三重保护：总开关 / 定位与坐标缺失 / 距离阈值（用户不在该线路附近时绝不乱选）。
 * @returns {{index:number, reason:string, distance:number|null, near:object|null}}
 */
function pickDefaultIndex(location, stations, fallbackIndex, opt) {
  const cfg = opt || {};
  const fallback = { index: fallbackIndex, reason: 'fallback', distance: null, near: null };
  if (cfg.enabled === false) return { index: fallbackIndex, reason: 'feature-off', distance: null, near: null };
  const near = nearestStation(location, stations, cfg);
  if (!near) return { ...fallback, reason: 'no-location-or-coords' };
  const max = typeof cfg.maxDistance === 'number' ? cfg.maxDistance : 1500;
  if (near.distance > max) return { ...fallback, reason: 'too-far', distance: near.distance, near: near };
  return { index: near.index, reason: 'nearest', distance: near.distance, near: near };
}

module.exports = {
  distanceMeters,
  wgs84ToGcj02,
  gcj02ToWgs84,
  normalizeStationPoint,
  nearestStation,
  pickDefaultIndex
};

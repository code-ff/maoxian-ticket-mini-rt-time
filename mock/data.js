/**
 * 小程序本地兜底 Mock 的数据模型（单数据源）
 * ─────────────────────────────────────────────────────────────
 * ★ 所有业务数据（线路 / 站名 / 站序 / 设备号 / 班次字段）均来自
 *   code/mock/real-snapshot.js —— 由 mock-server/scripts/capture-real.js
 *   从旧页面真实接口抓取后自动生成，本文件不编造任何业务取值。
 *
 * 与 Mock 后端 mock-server/server.js 的区别：
 *   - 后端持有含 paths/polygon 的全量真实站点表，车辆沿真实路径插值移动；
 *   - 本兜底（后端未启动时才用）用精简快照，按同一契约做时间推进，保证「仍会动」。
 *
 * 数据契约（与老页面实际调用的接口一致）：
 *   loadDELines          → [{lineCode,name,direction1{start,end,dir,timeRange},direction2{...}}]
 *   geo_data/stations    → {stations:[[站点...],[站点...]]}
 *   reloadCarMonitor     → {lineCode,stationCode,success,sj,lineName,lastStationName,
 *                           stationName,time,upDown,distance?}
 *   findByLineAndUpDown2 → {forecast:{deviceId:秒},list:[真实车辆全字段]}
 *
 * 四态真实枚举：time = "等待发车" / "车辆到站" / "即将到站" / "N分钟·M站"；
 *          distance = "N米" / "N.N公里" / "车辆到站"（等待发车时不下发该字段）；
 *          触发口径与 mock-server/server.js 一致（车所在站 / 前方无车 / <800米 / 更远）；
 *          sj = " 首 06:00 末 18:30"。
 */
var real = require('./real-snapshot.js');

function clone(o) { return JSON.parse(JSON.stringify(o)); }
function lineOf(code) { return real.lines.find(function (l) { return String(l.lineCode) === String(code); }); }

// 站点表精简模型（供前端渲染）：code / name / no / length
function getStations(code, upDown) {
  var d = real.stations[String(code)];
  var arr = (d && d[Number(upDown) === 1 ? 1 : 0]) || [];
  return arr.map(function (s) {
    return {
      code: String(s.stationCode),
      name: s.name,
      no: s.serialNo,
      length: (typeof s.length === 'number' && s.length > 0) ? s.length : 600,
      lon: s.lon,   // 精简快照保留站点经纬度，兜底时用于车辆位置插值
      lat: s.lat
    };
  });
}

function segLen(st, i) {
  return (st[i] && st[i].length > 0) ? st[i].length : 600;
}

/* ───────── 线路列表 ───────── */
function snapshotLines() { return clone(real.lines); }

/* ───────── 站点序列（接口 /geo_data/stations/{lineCode}） ───────── */
function snapshotStations(code) {
  var d = real.stations[String(code)];
  return { stations: clone(d || [[], []]) };
}

/* ───────── 车辆位置（按绝对时刻幂等推算，与 Mock 后端同构） ───────── */
// 演示倍速：与 mock-server/server.js 的 SPEED 一致，5s 轮询前进约 223 m（真实站间距
// 中位 564 m / 最短 202 m），保证逐站平滑推进；倍速过高会一次跨多个站点。
// 生产 SaaS 后端直接返回真实数据，不受此值影响。
var FALLBACK_SPEED = 6;
var FALLBACK_BOOT_AT = Date.now();
var fbSeeds = {};  // key -> 真实快照车辆种子（只初始化一次，之后永不修改）

// 与 Mock 后端一致：真实快照里 mark='Z' 但 speed=0 的静止在途车（B800852D 等），
// 按同方向在线车平均速度补齐推演 speed，避免演示时永远钉在同一节点。
// 设为 false 可严格还原真实静止状态。
var FILL_STILL_BUS = true;

function initSeed(code, up) {
  var st = getStations(code, up);
  var N = st.length;
  var key = String(code) + '_' + (Number(up) === 1 ? 1 : 0);
  var snap = real.gps[key] || { list: [] };
  var buses = (snap.list || []).map(function (b) {
    return {
      raw: clone(b),
      i: Math.max(0, Math.min(N - 2, Number(b.stationIndex) - 1)),
      distance: Number(b.distance) || 0,
      speed: Number(b.speed) || 0,
      mark: b.mark
    };
  });
  if (FILL_STILL_BUS) {
    var moving = buses.filter(function (b) { return b.mark === 'Z' && b.speed > 0; });
    var avg = moving.length
      ? moving.reduce(function (s, b) { return s + b.speed; }, 0) / moving.length
      : 26.8;
    buses.forEach(function (b) {
      if (b.mark === 'Z' && !b.speed) {
        b.speed = Math.round(avg * 10) / 10;
        b.raw.speed = b.speed;   // buildGpsItem 从 raw 克隆，speed 需同步
      }
    });
  }
  fbSeeds[key] = buses;
  return fbSeeds[key];
}

/**
 * ★ 位置 = 真实快照起点 + 从模块加载起的累计模拟里程，与接口调用次数无关。
 * 监控头 / GPS 两条轮询各自都会取数，早期「按上次调用时间差推进」的写法会让每轮
 * 被推进两次，叠加快照倍速后单轮跨 2~5 站（车辆跳节点）。改为幂等推算后，
 * 同一时刻两个端点返回同一位置，车辆只随真实时间平滑前进。
 */
function activeBuses(code, up, now) {
  var st = getStations(code, up);
  var N = st.length;
  var key = String(code) + '_' + (Number(up) === 1 ? 1 : 0);
  var seed = fbSeeds[key] || initSeed(code, up);
  var total = 0;
  for (var k = 0; k < N - 1; k++) total += segLen(st, k);
  var elapsed = Math.max(0, (now - FALLBACK_BOOT_AT) / 1000) * FALLBACK_SPEED;

  return seed.map(function (b) {
    var out = { raw: b.raw, i: b.i, distance: b.distance, speed: b.speed, mark: b.mark };
    if (!b.speed || b.mark === 'B' || b.mark === 'E' || total <= 0) return out;
    var v = b.speed * 1000 / 3600;
    out.distance -= (v * elapsed) % total;          // 累计里程对全线总长取模
    var guard = 0;
    while (out.distance <= 0 && guard++ < 2 * N + 2) {
      out.i += 1;
      if (out.i >= N - 1) { out.i = 0; out.distance += segLen(st, 0); } // 结转，不整段重置
      else out.distance += segLen(st, out.i);
    }
    if (out.distance < 0) out.distance = segLen(st, out.i);
    return out;
  });
}

// 由真实车辆记录 + 当前状态组装 GPS 记录（保留全部原始字段，仅覆盖实时量）
function buildGpsItem(b, st, now) {
  var out = clone(b.raw);
  var cur = st[b.i] || st[0];
  var nxt = st[b.i + 1] || cur;
  var L = segLen(st, b.i);
  var ratio = Math.max(0, Math.min(1, 1 - b.distance / L));
  var lon = (cur.lon || 0) + ((nxt.lon || 0) - (cur.lon || 0)) * ratio;
  var lat = (cur.lat || 0) + ((nxt.lat || 0) - (cur.lat || 0)) * ratio;

  out.stationIndex = b.i + 1;              // 真实契约：1-based 段序号
  out.stationCode = cur.code;
  out.stationName = cur.name;
  out.stationNo = cur.no;
  out.distance = Math.round(b.distance * 100) / 100;
  out.seconds = b.speed ? Math.round(b.distance / (b.speed * 1000 / 3600)) : 0;
  out.seconds2 = null;
  out.lon = lon;
  out.lat = lat;
  out.point = { lon: lon, lat: lat };
  out.timestamp = now;
  out.serverTimestamp = now;
  out.inOut = b.distance < 80 ? 1 : 0;
  out.inStationDistance = out.inOut === 1 ? out.distance : null;
  out.outStationDistance = out.inOut === 0 ? out.distance : null;
  out.inStationTime = out.inOut === 1 ? now : null;
  return out;
}

/* ───────── 车辆 GPS（接口 /gps/findByLineAndUpDown2） ───────── */
function snapshotGps(code, up, now) {
  now = now || Date.now();
  var st = getStations(code, up);
  var buses = activeBuses(code, up, now);
  var list = buses.map(function (b) { return buildGpsItem(b, st, now); });
  var forecast = {};
  buses.forEach(function (b, i) {
    var v = b.speed * 1000 / 3600 || 8;
    var rem = b.distance;
    for (var k = b.i + 1; k < st.length - 1; k++) rem += segLen(st, k);
    forecast[list[i].deviceId] = Math.round(rem / v);
  });
  return { forecast: forecast, list: list };
}

/* ───────── 监控头（接口 /carMonitor/reloadCarMonitor） ───────── */
function snapshotMonitor(code, up, stationCode, now) {
  now = now || Date.now();
  var line = lineOf(code);
  var st = getStations(code, up);
  if (!line || !st.length) return { success: false, error: '未找到线路：' + code };
  if (!stationCode || String(stationCode) === '0') {
    return { lineCode: String(code), stationCode: String(stationCode || '0'), success: true, upDown: String(up) };
  }
  var selIdx = -1;
  for (var i = 0; i < st.length; i++) {
    if (String(st[i].code) === String(stationCode)) { selIdx = i; break; }
  }
  if (selIdx < 0) return { success: false, error: '未找到站点：' + stationCode };

  var range = (Number(up) === 1 ? line.direction2 : line.direction1).timeRange.split('-');
  var base = {
    lineCode: String(code),
    stationCode: String(stationCode),
    success: true,
    sj: ' 首 ' + (range[0] || '') + ' 末 ' + (range[1] || ''),
    lineName: line.name,
    lastStationName: st[st.length - 1].name,
    stationName: st[selIdx].name,
    upDown: String(up)
  };
  var buses = activeBuses(code, up, now);
  // 状态 ①：车当前所在站（GPS stationCode 即段起点站）→ 「车辆到站 / 车辆到站」
  var atStation = null;
  for (var ai = 0; ai < buses.length; ai++) {
    var ab = buses[ai];
    if (ab.mark === 'Z' && st[ab.i] && String(st[ab.i].code) === String(stationCode)) { atStation = ab; break; }
  }
  if (atStation) {
    base.distance = '车辆到站';
    base.time = '车辆到站';
    return base;
  }
  var best = null;
  buses.forEach(function (b) {
    if (b.mark !== 'Z' || !b.speed) return;
    if (b.i < selIdx && (!best || b.i > best.i)) best = b;
  });
  // 状态 ②：选中站前方无在途车 → 「等待发车」，真实接口此时不下发 distance
  if (!best) { base.time = '等待发车'; return base; }

  var meters = best.distance;
  for (var k = best.i + 1; k < selIdx; k++) meters += segLen(st, k);
  var stops = Math.max(1, selIdx - best.i);   // 含目标站，对齐真实 "…·3站"
  if (meters <= 100) {
    base.distance = '车辆到站';
    base.time = '车辆到站';
    return base;
  }
  base.distance = meters >= 1000 ? (meters / 1000).toFixed(1) + '公里' : Math.round(meters) + '米';
  // 状态 ③：距站 < 800 米 → 「即将到站」（真实采集 395 / 597 / 672 米；811 米已是「2分钟·1站」）
  if (meters < 800) {
    base.distance = Math.round(meters) + '米';
    base.time = '即将到站';
    return base;
  }
  // 状态 ④：更远 → 「N分钟·M站」。与 Mock 后端一致：用在线车辆平均运营速度，避免瞬时低速拉偏 ETA
  var moving = buses.filter(function (b) { return b.mark === 'Z' && b.speed > 0; });
  var avg = moving.length ? moving.reduce(function (s, b) { return s + b.speed; }, 0) / moving.length : 30;
  var v = Math.max(avg, 20) * 1000 / 3600;
  base.time = Math.ceil(meters / v / 60) + '分钟·' + stops + '站';
  return base;
}

module.exports = {
  getStations: getStations,
  snapshotLines: snapshotLines,
  snapshotStations: snapshotStations,
  snapshotMonitor: snapshotMonitor,
  snapshotGps: snapshotGps
};

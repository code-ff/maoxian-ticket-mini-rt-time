/**
 * 小程序本地兜底 Mock（Mock 后端未启动时由 utils/request.js 自动启用）
 * 数据全部来自真实快照 real-snapshot.js，按接口契约原样分发；
 * GPS / 监控头按真实流逝时间推进，因此后端未启动时车辆「照样会动」。
 */
const data = require('./data.js');

function upOf(v) { return Number(v) === 1 ? 1 : 0; }

function getLines() { return data.snapshotLines(); }

function getStations(apiPath) {
  const parts = String(apiPath).split('?')[0].split('/');
  return data.snapshotStations(parts[parts.length - 1]);
}

function getCarMonitor(params) {
  return data.snapshotMonitor(params.lineCode, upOf(params.upDown), params.stationCode);
}

function getGps(params) {
  return data.snapshotGps(params.lineCode, upOf(params.upDown));
}

// 按接口路径分发（与 utils/config.js → API 的路径一一对应）
function resolve(apiPath, params) {
  const p = params || {};
  if (apiPath.indexOf('loadDELines') >= 0) return getLines();
  if (apiPath.indexOf('geo_data/stations') >= 0) return getStations(apiPath);
  if (apiPath.indexOf('reloadCarMonitor') >= 0) return getCarMonitor(p);
  if (apiPath.indexOf('findByLineAndUpDown2') >= 0) return getGps(p);
  return {};
}

module.exports = { getLines, getStations, getCarMonitor, getGps, resolve };

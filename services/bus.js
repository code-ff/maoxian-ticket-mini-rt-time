/**
 * 公交业务服务层
 * 仅封装旧页面实际调用的接口，入参 / 返回结构保持与旧接口一致，不做字段翻译。
 * 接口地址与路径统一取自 utils/config.js，页面 wxml/js 不写死地址。
 *
 * 静态证据（旧页面 shipped-artifact）：
 *   detail.html:325-352  → /carMonitor/reloadCarMonitor，前端直接透传 time / distance 文案
 *   detail.html:366-373  → svg.js showSvg(lineCode, upDown) → start_gps()
 *   svg.js:13-17         → /geo_data/stations/{lineCode}
 *   svg.js:210-224       → /gps/findByLineAndUpDown2?lineCode=&upDown=&t=Math.random()
 */
const { request } = require('../utils/request.js');
const config = require('../utils/config.js');

/**
 * 线路列表：GET /carMonitor/loadDELines
 * 适配说明（唯一的数据适配点）：旧页面这个 URL 返回的是 HTML，线路数据内嵌在
 *   `var BUS_LINES = [...]` 中（Content-Type: text/html），并不是 JSON 接口。
 * Mock 后端 / SaaS 后端按同结构直接透出 JSON 数组。此处两种形态都归一为数组，
 * 字段名 / 类型 / 嵌套层级完全不变，不新增字段、不改写业务数据。
 */
function parseLines(data) {
  if (Array.isArray(data)) return data;
  if (typeof data !== 'string') return [];
  const s = data.trim();
  // ① Mock / SaaS：JSON 数组文本
  if (s.charAt(0) === '[') {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr;
    } catch (e) { /* 落到 HTML 解析 */ }
  }
  // ② 旧页面：HTML 内嵌 var BUS_LINES = [...];
  const m = s.match(/var\s+BUS_LINES\s*=\s*(\[[\s\S]*?\]);/);
  if (m) {
    try {
      const arr = JSON.parse(m[1]);
      if (Array.isArray(arr)) return arr;
    } catch (e) {
      console.warn('[bus] BUS_LINES 解析失败', e);
    }
  }
  return [];
}

function getLines() {
  return request(config.API.loadDELines, {}, { raw: true }).then(parseLines);
}

// 双向站点序列：GET /geo_data/stations/{lineCode}
// 旧页面 svg.js 的 $.get('/geo_data/stations/' + lineCode) → {stations:[[去程],[返程]]}
function getStations(lineCode) {
  return request(config.API.stations + encodeURIComponent(lineCode), {});
}

// 监控头（5s 轮询）：GET /carMonitor/reloadCarMonitor?lineCode=&upDown=&stationCode=
// 四态真实枚举：等待发车 / 车辆到站 / 即将到站 / N分钟·M站；distance 字段在「等待发车」时不下发。
function getCarMonitor({ lineCode, upDown, stationCode = '' }) {
  return request(config.API.reloadCarMonitor, { lineCode, upDown, stationCode });
}

// 车辆 GPS / 站点位置（5s 串行轮询）：GET /gps/findByLineAndUpDown2?lineCode=&upDown=&t=
// t 为防缓存随机量，与旧页面 svg.js 一致（Math.random()）。
function getGps({ lineCode, upDown }) {
  return request(config.API.findByLineAndUpDown2, { lineCode, upDown, t: Math.random() });
}

module.exports = { getLines, getStations, getCarMonitor, getGps, parseLines };

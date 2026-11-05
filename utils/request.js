/**
 * 统一请求封装
 * - 环境：'real' → config.REAL_BASE（旧页面真实接口）/ 'mock' → MOCK_BASE / 'prod' → PROD_BASE
 * - 切换：存储 __ENV__ 优先（'real' / 'mock' / 'prod'），其次读 config.env
 * - 失败回退：仅 mock 环境回退本地兜底 code/mock/local.js；real / prod 以真实结果为准（与旧页面一致）
 * - opts.raw=true：不做 JSON 解析，原样返回字符串（用于旧站 /carMonitor/loadDELines 返回 HTML 的适配）
 */
const config = require('./config.js');
const localFallback = require('../mock/local.js');

function currentEnv() {
  const ov = (typeof wx !== 'undefined') ? wx.getStorageSync('__ENV__') : '';
  if (ov === 'real' || ov === 'mock' || ov === 'prod') return ov;
  return config.env;
}

// 当前后端基地址（接口地址统一在 config.js 维护）
function apiBase() {
  const env = currentEnv();
  if (env === 'prod') return config.PROD_BASE;
  if (env === 'mock') return config.MOCK_BASE;
  return config.REAL_BASE;
}

// 真实接口环境不回退本地兜底，避免用快照掩盖真实故障
function isRealBackend() {
  return currentEnv() !== 'mock';
}

/**
 * @param {string} apiPath 接口路径（见 config.API）
 * @param {object} params  GET 入参
 * @param {object} opts    { raw: true } 时返回未经 JSON 解析的原始文本
 * @returns {Promise<any>}
 */
function request(apiPath, params = {}, opts = {}) {
  const base = apiBase();
  const qs = Object.keys(params || {})
    .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(params[k]))
    .join('&');
  const url = base + apiPath + (qs ? '?' + qs : '');

  return new Promise((resolve, reject) => {
    wx.request({
      url: url,
      method: 'GET',
      dataType: opts.raw ? 'text' : 'json',
      header: { 'content-type': 'application/json' },
      success: (res) => {
        if (res && res.statusCode === 200 && res.data !== undefined && res.data !== null) resolve(res.data);
        else reject(res);
      },
      fail: (err) => {
        if (!isRealBackend()) {
          try {
            const fb = localFallback.resolve(apiPath, params || {});
            console.warn('[request] Mock 后端不可用，已回退本地兜底:', apiPath);
            return resolve(fb);
          } catch (e) { /* 忽略，走 reject */ }
        }
        reject(err);
      }
    });
  });
}

module.exports = { request: request, apiBase: apiBase, isRealBackend: isRealBackend };

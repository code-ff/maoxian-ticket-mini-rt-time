/**
 * 全局配置（接口地址 / 环境切换 / 轮询 / 文案替换点位）
 * ─────────────────────────────────────────────────────────────
 * ★ 接口地址配置入口（唯一）：本文件的 REAL_BASE / MOCK_BASE / PROD_BASE + API 路径。
 *   页面 wxml / js 内不写死任何接口地址，全部经 services/bus.js → utils/request.js 取用。
 *
 * ★ 一键切换（env 或运行时覆盖）：
 *   'real' → REAL_BASE 旧页面真实接口（当前联调目标，无鉴权、可直接访问）
 *   'mock' → MOCK_BASE 自建 Mock 后端（真实快照驱动，便于离线演示车辆移动）
 *   'prod' → PROD_BASE SaaS 正式域名（分配后替换，须 https + 配置 request 合法域名）
 *   运行时热切换：wx.setStorageSync('__ENV__', 'real' | 'mock' | 'prod')
 *   real / prod 均以真实接口为准，请求失败不回退本地兜底；mock 失败才回退 code/mock/local.js。
 *
 * ★ 数据契约（入参 / 返回字段名 / 类型 / 嵌套层级 / 枚举值）严格对齐旧页面实际调用的接口：
 *   loadDELines           /carMonitor/loadDELines                （线路列表；旧页面为 HTML 内嵌 var BUS_LINES，见 services/bus.js 适配）
 *   geo_data/stations     /geo_data/stations/{lineCode}         （双向站点序列，旧页面 svg.js 的 $.get）
 *   reloadCarMonitor       /carMonitor/reloadCarMonitor          （监控头，5s 轮询，四态枚举见 pages/lines/lines.js）
 *   findByLineAndUpDown2   /gps/findByLineAndUpDown2             （车辆 GPS，5s 串行轮询）
 *   真实数据基线：mock-server/fixtures/real/（由 scripts/capture-real.js 从旧页面真实抓取）。
 *   契约样本：code/mock/samples/。
 *
 * ★ 轮询口径（静态证据：旧页面 detail.html:301 / svg.js:194-225）：
 *   监控头 = 立即请求 + setInterval(5000)；GPS = 站点表加载成功后递归 setTimeout(5000) 串行轮询。
 *   选站点击立即刷新监控头；页面不可见 / 关闭详情 / 卸载时清理定时器。
 *
 * ★ 文案替换点位：仅 TEXT 中的平台名称 / 归属主体 / 导航与占位文案；
 *   页面提示文字、站名、线路业务状态文案一律沿用接口与原型，不改动排版。
 */
module.exports = {
  // 运行环境：'real' 旧页面真实接口 | 'mock' 自建 Mock 后端 | 'prod' SaaS 正式域名
  env: 'real',

  // ★ 旧页面真实接口（当前联调目标）：无鉴权、可直接访问
  //   注意：http + IP + 端口，微信开发者工具需「不校验合法域名」（project*.config.json 已设 urlCheck:false）；
  //   真机预览需开启调试模式；正式提审必须切 https 正式域名并配置 request 合法域名。
  REAL_BASE: 'http://118.113.164.50:9777',

  // 自建 Mock 后端地址（mock-server/server.js，默认 http://localhost:9778）
  MOCK_BASE: 'http://localhost:9778',

  // SaaS 正式联调地址（分配后替换；页面代码无需改动）
  PROD_BASE: 'https://your-saas-domain.com',

  // 轮询间隔（毫秒），与旧页面 setInterval / setTimeout 一致
  POLL_MONITOR: 5000,
  POLL_GPS: 5000,

  // 接口路径（入参、返回结构与旧接口完全一致）
  API: {
    loadDELines: '/carMonitor/loadDELines',
    stations: '/geo_data/stations/',        // 后接 lineCode，返回 {stations:[[去程],[返程]]}
    reloadCarMonitor: '/carMonitor/reloadCarMonitor',
    findByLineAndUpDown2: '/gps/findByLineAndUpDown2'
  },

  // 文案替换点位（仅替换业务/布局文案，不改动排版）
  TEXT: {
    appName: '茂县公交',            // 平台 / 归属主体名称
    navTitleLines: '线路查询',       // 线路页导航标题
    detailTitle: '线路详情',          // 详情默认标题（打开后会被线路名覆盖）
    searchPlaceholder: '输入线路名 / 站点',
    emptyText: '未找到匹配线路'
  }
};

const busService = require('../../services/bus.js');
const config = require('../../utils/config.js');
const { isRealBackend } = require('../../utils/request.js');
const mockData = require('../../mock/data.js');
const watchtowers = require('./watchtowers.js');

// 车辆图标（白色线稿公交车，置于青绿圆点中；base64 SVG，微信 <image> 兼容最稳）
const BUS_ICON = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmZmZmIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cmVjdCB4PSI0IiB5PSI1IiB3aWR0aD0iMTYiIGhlaWdodD0iMTEiIHJ4PSIyLjUiLz48cGF0aCBkPSJNNCAxMWgxNiIvPjxwYXRoIGQ9Ik04IDV2Nk0xMiA1djZNMTYgNXY2Ii8+PGNpcmNsZSBjeD0iOC41IiBjeT0iMTcuNSIgcj0iMS40IiBmaWxsPSIjZmZmZmZmIiBzdHJva2U9Im5vbmUiLz48Y2lyY2xlIGN4PSIxNS41IiBjeT0iMTcuNSIgcj0iMS40IiBmaWxsPSIjZmZmZmZmIiBzdHJva2U9Im5vbmUiLz48L3N2Zz4=";

/**
 * 车辆在「站点时间线」上的分数位置 [0, N-1]。
 * 真实接口契约：stationIndex = 站点表下标 + 1；distance = 距下一站米数；
 * 站点表每项 length = 该站到下一站的真实段长（米）。故按真实段长换算进度，
 * 不再使用固定站间距，保证车辆图标位置与真实 GPS 一致。
 */
function busFraction(b, stations) {
  const N = stations.length;
  const idx = Math.max(0, Math.min(N - 2, Number(b.stationIndex) - 1));
  const L = (stations[idx] && stations[idx].length > 0) ? stations[idx].length : 600;
  let f = idx + (1 - Number(b.distance) / L);
  if (f < 0) f = 0;
  if (f > N - 1) f = N - 1;
  return f;
}

/**
 * 监控头状态机 —— 完全按旧页面真实接口 reloadCarMonitor 的下发枚举解析。
 *
 * 静态证据：
 *   detail.html:336-352 前端只做 data.time / data.distance 透传，distance 缺失时显示 '--'；
 *   真实接口 249210 去程 43 站全量采集（fixtures/real/monitor_states_249210_0.json）：
 *     time 枚举 = 等待发车 / 车辆到站 / 即将到站 / N分钟·M站
 *     distance 枚举 = 不下发(等待发车) / "车辆到站" / "N米" / "N.N公里"
 *   触发口径：车当前所在站 → 车辆到站；车前方 1~2 站且 < 800 米 → 即将到站；
 *             更远 → N分钟·M站；选中站前方无在途车 → 等待发车（且不下发 distance）。
 *
 * 映射只使用原型已有的 .m-arrival(big/unit/sub/.soon) 与 .sflag 结构，
 * 不新增视觉元素、样式或页面；「N分钟·M站」中的 M 站直接作为「最近车辆 距 X站」口径。
 */
function parseMonitorState(m) {
  const src = (typeof m === 'string') ? { time: m } : (m || {});
  const time = String(src.time || '');
  const distance = String(src.distance || '');
  const sm = time.match(/(\d+)\s*站/);
  const stops = sm ? parseInt(sm[1], 10) : null;
  let key, big, unit, sub, flag;
  let soon = false;

  if (/等待发车/.test(time)) {
    key = 'waiting'; big = '等待'; unit = '发车'; sub = '暂未发车'; flag = '等待发车';
  } else if (/车辆到站/.test(time)) {
    key = 'arrived'; big = '车辆'; unit = '到站'; sub = '车辆已到站'; flag = '车辆到站'; soon = true;
  } else if (/即将到站/.test(time)) {
    key = 'soon'; big = '即将'; unit = '进站'; sub = '车辆即将到达'; flag = '即将到站'; soon = true;
  } else {
    const mm = time.match(/(\d+)\s*分钟/);
    if (mm) {
      key = 'eta'; big = mm[1]; unit = '分钟'; flag = big + '分钟';
      sub = distance ? '后到站 · 约 ' + distance : '后到站';
    } else {
      key = 'unknown'; big = '--'; unit = '分钟'; sub = '--'; flag = '';
    }
  }
  return { key: key, big: big, unit: unit, sub: sub, flag: flag, soon: soon, stops: stops, time: time, distance: distance };
}

Page({
  data: {
    statusBarHeight: 20,
    navTitle: config.TEXT.navTitleLines,
    keyword: '',
    searchPlaceholder: config.TEXT.searchPlaceholder,
    emptyText: config.TEXT.emptyText,
    busIcon: BUS_ICON,
    watchtowers: watchtowers,
    lines: [],
    lineCards: [],
    detail: {
      show: false,
      lineCode: '',
      lineName: '',
      upDown: 0,
      stations: [],          // 站点主数据：由 /geo_data/stations/{lineCode} 接口下发（code/name/no/length）
      buses: [],             // GPS 车辆：{deviceId, stationIndex, stationName, stationCode, distance, frac, inOut, stationNo}
      selected: null,        // 选中站点序号
      monitor: { lineName: '', lastStationName: '', sj: '', stationName: '', distance: '—', time: '—' },
      routeNodes: [],
      arrivalBig: '--',
      arrivalUnit: '分钟',
      arrivalSub: '',
      soon: false,
      stateKey: '',          // 监控头状态机：waiting / arrived / soon / eta / unknown
      flag: '',              // 选中站徽标文案（等待发车 / 车辆到站 / 即将到站 / N分钟）
      serverStops: null,     // 服务端 time 中「M站」的真实站数口径
      nearName: '',          // 监控卡「最近车辆 距 [站名] X站」中的站名（对齐原型 .m-near）
      nearStops: ''          // 站数文本：'本站' / 'N 站'
    }
  },

  onLoad() {
    const sys = wx.getWindowInfo();
    this.setData({ statusBarHeight: sys.statusBarHeight || 20 });
    this.loadLines();
  },

  onUnload() {
    this.stopTimers();
  },

  // 旧页面 beforeunload 清理定时器；小程序切后台同样暂停，回前台恢复并立即刷新一次
  onHide() {
    this.stopTimers();
  },

  onShow() {
    if (!this.data.detail.show || !this.data.detail.lineCode) return;
    const code = this.data.detail.lineCode;
    const upDown = this.data.detail.upDown;
    const selIdx = this.data.detail.selected;
    const selCode = (selIdx != null && this.data.detail.stations[selIdx]) ? this.data.detail.stations[selIdx].code : '';
    this.loadMonitor(code, upDown, selCode);
    this.loadGps(code, upDown, false);
    this.startTimers(code, upDown);
  },

  /* ---------- 线路列表 ---------- */
  async loadLines() {
    try {
      const lines = await busService.getLines();
      this.setData({ lines: Array.isArray(lines) ? lines : [] });
      this.buildCards();
    } catch (e) {
      // 旧页面失败时只降级文案，不弹窗（约束：不新增弹窗）
      console.error('线路加载失败', e);
    }
  },

  // 由契约数据构建列表渲染模型（direction1=去程 / direction2=返程）
  buildCards() {
    this._allCards = (this.data.lines || []).map((l) => ({
      code: l.lineCode,
      name: l.name,
      dirs: [this.dirModel(l.direction1, 0), this.dirModel(l.direction2, 1)]
    }));
    this.applyFilter();
  },

  dirModel(d, dir) {
    const timeRange = (d && d.timeRange) || '';
    return {
      dir: dir,
      start: d ? d.start : '',
      end: d ? d.end : '',
      time: timeRange,
      timeFirst: timeRange.split('-')[0] || '',
      label: dir === 0 ? '去程' : '返程'
    };
  },

  // 搜索：支持输入线路数字（210/101…），站名/线路名模糊匹配保持不变
  applyFilter() {
    const kw = (this.data.keyword || '').trim().toLowerCase();
    let list = this._allCards || [];
    if (kw) {
      const km = kw.replace(/\D/g, ''); // 仅保留数字
      list = list.filter((c) => {
        // 数字快捷检索：线路名中的数字 或 线路编码尾号命中
        const routeNo = (c.name.match(/\d+/) || [])[0] || '';
        const codeTail = String(c.code).replace(/\D/g, '').slice(-1);
        if (String(c.code) === kw || (km && (routeNo === km || codeTail === km))) return true;
        // 文本匹配只看线路名 / 站点名：真实线路编码为 6 位数字，
        // 拼进 hay 会让「210」误命中 251210（大邑216路）等无关线路。
        const hay = (c.name + c.dirs.map((d) => d.start + d.end).join('')).toLowerCase();
        return hay.includes(kw);
      });
    }
    this.setData({ lineCards: list });
  },

  onSearchInput(e) {
    this.setData({ keyword: e.detail.value });
    this.applyFilter();
  },

  /* ---------- 站点序列（老页面真实接口 /geo_data/stations/{lineCode}） ---------- */
  // 按线路缓存一次，换向直接使用，避免重复请求与异步竞态
  async ensureStations(code) {
    if (this._stationsCache && this._stationsCache.code === String(code)) return this._stationsCache.byDir;
    let byDir = [[], []];
    try {
      const rs = await busService.getStations(code);
      const raw = (rs && rs.stations) || [];
      byDir = [0, 1].map((d) => (raw[d] || []).map((s) => ({
        code: String(s.stationCode),
        name: s.name,
        no: s.serialNo,
        length: (typeof s.length === 'number' && s.length > 0) ? s.length : 600
      })));
    } catch (e) {
      console.warn('站点接口不可用', e);
    }
    if (!byDir[0].length && !byDir[1].length) {
      // 本地快照只服务于 mock 环境（后端未启动时仍可预览）。
      // real / prod 一律以真实后端为准：否则切换到茂县 SaaS 后，站点表会混入
      // 旧页面大邑快照的站名，造成「列表是茂县、站点是大邑」的数据串源。
      if (!isRealBackend()) {
        byDir = [0, 1].map((d) => mockData.getStations(code, d));
      } else {
        console.warn('[stations] 真实后端未返回有效站点表，按契约不回退本地快照');
      }
    }
    this._stationsCache = { code: String(code), byDir: byDir };
    return byDir;
  },

  /* ---------- 线路详情（滑入层） ---------- */
  onOpenDetail(e) {
    const { code, dir } = e.currentTarget.dataset;
    this.openDetail(code, Number(dir));
  },

  async openDetail(code, dir) {
    const line = (this.data.lines || []).find((l) => String(l.lineCode) === String(code));
    if (!line) return;
    this.stopTimers();
    const seq = (this._detailSeq = (this._detailSeq || 0) + 1);
    this.setData({
      'detail.show': true,
      'detail.lineCode': code,
      'detail.lineName': line.name,
      'detail.upDown': dir,
      'detail.stations': [],
      'detail.buses': [],
      'detail.selected': null,
      'detail.monitor': { lineName: '', lastStationName: '', sj: '', stationName: '', distance: '—', time: '—' },
      'detail.routeNodes': [],
      'detail.arrivalBig': '--',
      'detail.arrivalUnit': '分钟',
      'detail.arrivalSub': '',
      'detail.soon': false,
      'detail.stateKey': '',
      'detail.flag': '',
      'detail.serverStops': null
    });
    // 旧页面顺序：showSvg 先拉站点表并画时间线，成功后 start_gps；监控头独立立即请求
    const byDir = await this.ensureStations(code);
    if (seq !== this._detailSeq) return; // 期间切换了线路/方向，丢弃过期结果
    this.setData({ 'detail.stations': byDir[dir] || [] });
    // 先拉 GPS 确定默认选中站（首辆车下一站），再拉监控头
    this.loadGps(code, dir, true);
    this.startTimers(code, dir);
  },

  // 车辆 GPS / 站点位置（串行轮询）
  async loadGps(code, upDown, isInit) {
    try {
      const gps = await busService.getGps({ lineCode: code, upDown: upDown });
      const sts = this.data.detail.stations || [];
      const N = sts.length;
      if (!N) return;
      // 与旧页面 svg.js:292-295 一致：mark='B'(未发车)/'E'(收班)/null 不渲染
      const buses = (gps.list || [])
        .filter((b) => b.mark && b.mark !== 'B' && b.mark !== 'E')
        .map((b) => ({
          deviceId: b.deviceId,
          stationIndex: b.stationIndex,
          stationName: b.stationName,
          stationCode: b.stationCode,
          distance: b.distance,
          inOut: b.inOut,
          stationNo: b.stationNo,
          frac: busFraction(b, sts)
        }))
        // 与旧页面 svg.js:231-237 一致：inOut==2 优先，其余按 stationNo 升序（缺失时回退 stationIndex）
        .sort((a, b) => {
          const a2 = (a.inOut === 2 || a.inOut === '2') ? -1 : 0;
          const b2 = (b.inOut === 2 || b.inOut === '2') ? -1 : 0;
          if (a2 !== b2) return a2 - b2;
          const an = Number(a.stationNo) || Number(a.stationIndex) || 0;
          const bn = Number(b.stationNo) || Number(b.stationIndex) || 0;
          return an - bn;
        });
      this.setData({ 'detail.buses': buses });

      // 默认选中站：首辆车的“下一站”（保证有车驶近，ETA 为正）；用户未手动选站时也维持
      if (isInit || this.data.detail.selected == null) {
        const firstFrac = buses.length ? Math.floor(buses[0].frac + 0.0001) : 0;
        const sel = Math.min(firstFrac + 1, Math.max(0, N - 1));
        this.setData({ 'detail.selected': sel });
        const selCode = sts[sel] ? sts[sel].code : '';
        this.loadMonitor(code, upDown, selCode);
      }
      this.renderRoute();
    } catch (e) {
      console.error('GPS 加载失败', e);
    }
  },

  // 监控头（轮询）—— 返回 lineName / 开往 / 首末班 / 选中站点 / distance / time（四态）
  async loadMonitor(code, upDown, stationCode) {
    try {
      const m = await busService.getCarMonitor({ lineCode: code, upDown: upDown, stationCode: stationCode });
      // 旧页面 detail.html:336-339：业务失败只记日志并保留上一轮数据，不弹窗、不清空
      if (!m || m.success === false) {
        console.warn('监控头返回业务失败', m && m.error);
        return;
      }
      this.setData({
        'detail.monitor.lineName': m.lineName || '',
        'detail.monitor.lastStationName': m.lastStationName || '',
        'detail.monitor.sj': m.sj || '',
        'detail.monitor.stationName': m.stationName || '',
        // 旧页面 detail.html:348-349：distance 缺失时显示 '--'（此处沿用现有占位符）
        'detail.monitor.distance': m.distance || '—',
        'detail.monitor.time': m.time || '—'
      });
      this.applyTime({ time: m.time, distance: m.distance });
      this.renderRoute();
    } catch (e) {
      // 旧页面 error 分支只降级文案，不弹窗
      console.error('监控头加载失败', e);
    }
  },

  // 把接口回传的 time / distance 映射为监控卡大数字、副标题、选中站徽标、站数口径
  // 四态真实枚举见 parseMonitorState；兼容旧调用 applyTime('6分钟·3站')
  applyTime(m) {
    const s = parseMonitorState(m);
    this.setData({
      'detail.arrivalBig': s.big,
      'detail.arrivalUnit': s.unit,
      'detail.arrivalSub': s.sub,
      'detail.soon': s.soon,
      'detail.flag': s.flag,
      'detail.serverStops': s.stops,
      'detail.stateKey': s.key
    });
    return s;
  },

  // 构建站点时间线节点（站点 + 途中区间，两类节点都可承载车辆图标，由 GPS 位置驱动）
  // 节点序列为 station0, seg0, station1, seg1, … 共 2N-1 个，索引 2i 为站点、2i+1 为途中点。
  // 车辆 frac ∈ [0, N-1] 按 frac*2 四舍五入映射到最近节点：段首/段尾落在站点大圈上，
  // 段中落在途中点上，随轮询逐格移动。
  renderRoute() {
    const sts = this.data.detail.stations;
    const N = sts.length;
    const buses = this.data.detail.buses || [];
    const busNode = {};
    buses.forEach((b) => {
      const k = Math.max(0, Math.min(2 * N - 2, Math.round(b.frac * 2)));
      busNode[k] = true;
    });

    const sel = this.data.detail.selected;
    const selFlag = this.data.detail.flag || '';

    const nodes = [];
    for (let i = 0; i < N; i++) {
      const isSel = sel === i;
      nodes.push({
        key: 's' + i,
        type: 'station',
        index: i,
        name: sts[i].name,
        selected: isSel,
        flag: isSel ? selFlag : '',
        isBus: !!busNode[i * 2]
      });
      if (i < N - 1) {
        nodes.push({ key: 'g' + i, type: 'seg', isBus: !!busNode[i * 2 + 1] });
      }
    }
    // 最近车辆 距 [选中站] X站（严格对齐原型 .m-near）
    // 优先采用服务端 time「N分钟·M站」的 M 站真实口径；无 M 时按首车所在段推算。
    let nearName = '', nearStops = '—';
    if (sts[sel]) {
      nearName = sts[sel].name;
      const srv = this.data.detail.serverStops;
      const key = this.data.detail.stateKey;
      if (srv != null) {
        nearStops = srv === 0 ? '本站' : srv + ' 站';
      } else if (key === 'waiting' || key === 'arrived') {
        nearStops = '本站';
      } else {
        const pb = buses[0] || null;
        const seg = pb ? Math.max(0, pb.stationIndex - 1) : sel;
        const refStops = Math.abs(sel - seg);
        nearStops = refStops === 0 ? '本站' : refStops + ' 站';
      }
    }

    this.setData({ 'detail.routeNodes': nodes, 'detail.nearName': nearName, 'detail.nearStops': nearStops });
  },

  // 换向：切换 upDown 后重新请求（对齐原 changeDirection 的前端等价实现）
  onSwitchDir(e) {
    const dir = Number(e.currentTarget.dataset.dir);
    if (dir === this.data.detail.upDown) return;
    const code = this.data.detail.lineCode;
    this._detailSeq = (this._detailSeq || 0) + 1;
    this.stopTimers();
    const cached = (this._stationsCache && this._stationsCache.code === String(code)) ? this._stationsCache.byDir : null;
    this.setData({
      'detail.upDown': dir,
      'detail.stations': cached ? (cached[dir] || []) : [],
      'detail.selected': null,
      'detail.buses': [],
      'detail.routeNodes': []
    });
    if (!cached) {
      this.ensureStations(code).then((byDir) => {
        this.setData({ 'detail.stations': byDir[dir] || [] });
        this.loadGps(code, dir, true);
        this.startTimers(code, dir);
      });
      return;
    }
    this.loadGps(code, dir, true);
    this.startTimers(code, dir);
  },

  // 选站：切换选中态并立即刷新监控头（对齐旧页面 detail.html:306-313 点击立即 loadMonitorData）
  onSelectStation(e) {
    const i = Number(e.currentTarget.dataset.index);
    const sel = this.data.detail.selected;
    const newSel = (sel === i ? null : i);
    this.setData({ 'detail.selected': newSel });

    const N = this.data.detail.stations.length;
    let idx = newSel;
    if (newSel == null) {
      // 取消选中 → 回退到默认（首辆车下一站）
      const firstFrac = this.data.detail.buses[0] ? Math.floor(this.data.detail.buses[0].frac + 0.0001) : 0;
      idx = Math.min(firstFrac + 1, Math.max(0, N - 1));
    }
    const selCode = this.data.detail.stations[idx] ? this.data.detail.stations[idx].code : '';
    this.loadMonitor(this.data.detail.lineCode, this.data.detail.upDown, selCode);
    this.renderRoute();
  },

  // 刷新：重新拉取监控头 + GPS（轮询本身也会持续刷新，这里供手动触发）
  onRefreshDetail() {
    const code = this.data.detail.lineCode;
    const upDown = this.data.detail.upDown;
    const selIdx = this.data.detail.selected;
    const selCode = (selIdx != null && this.data.detail.stations[selIdx]) ? this.data.detail.stations[selIdx].code : '';
    this.loadMonitor(code, upDown, selCode);
    this.loadGps(code, upDown, false);
  },

  onCloseDetail() {
    this._detailSeq = (this._detailSeq || 0) + 1;
    this.stopTimers();
    this.setData({ 'detail.show': false });
  },

  /* ---------- 轮询定时器（严格对齐旧页面） ----------
   * 监控头：detail.html:301 setInterval(loadMonitorData, 5000) —— 固定 5s。
   * GPS：svg.js:194-207 start_gps → 递归 setTimeout(refreshLoop, 5000)，
   *      即「上一次请求完成后再等 5s」，串行不堆积；此处同构。
   * 首次 GPS 由 openDetail / onSwitchDir 立即发起，故定时器在首拉之后进入循环。 */
  startTimers(code, upDown) {
    this.stopTimers();
    this._gpsStopped = false;

    this.monitorTimer = setInterval(() => {
      if (this._monitorBusy) return;                 // 防并发堆积（不改变交互）
      const selIdx = this.data.detail.selected;
      const selCode = (selIdx != null && this.data.detail.stations[selIdx]) ? this.data.detail.stations[selIdx].code : '';
      this._monitorBusy = true;
      this.loadMonitor(code, upDown, selCode).then(
        () => { this._monitorBusy = false; },
        () => { this._monitorBusy = false; }
      );
    }, config.POLL_MONITOR);

    const gpsLoop = () => {
      if (this._gpsStopped) return;
      this.loadGps(code, upDown, false).then(
        () => { if (!this._gpsStopped) this.gpsTimer = setTimeout(gpsLoop, config.POLL_GPS); },
        () => { if (!this._gpsStopped) this.gpsTimer = setTimeout(gpsLoop, config.POLL_GPS); }
      );
    };
    this.gpsTimer = setTimeout(gpsLoop, config.POLL_GPS);
  },

  stopTimers() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    if (this.gpsTimer) clearTimeout(this.gpsTimer);
    this.monitorTimer = null;
    this.gpsTimer = null;
    this._gpsStopped = true;
    this._monitorBusy = false;
  }
});

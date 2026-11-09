// utils/location.js
// 「进入时获取 GPS 并打印控制台」模块；v8.6 起额外把结果缓存在内存，供详情页选最近站点用。
//
// 设计约束（务必保持）：
//   1. 不 setData、不读写 Storage、不发网络请求、不弹自定义 UI、不 toast；
//   2. 不读写任何业务数据，不引用 services / pages / mock 下的任何模块；
//   3. 成功、失败、异常全部只走 console，绝不向上抛错，避免影响 App 生命周期；
//   4. 只在 App.onLaunch 调用一次，不做持续定位（避免触发 wx.getLocation 2.17.0 起的调用频率限制）。
//   5. 坐标只存内存（不落盘、不上传），页面通过 getLastLocation / whenReady 读取。
//   6. config.DEBUG_LOCATION 是本地联调开关（默认 null）：填了坐标就用模拟定位、不调用
//      wx.getLocation，便于「人不到现场」验证最近站链路；提审前必须改回 null。
//
// 官方依据（2026-11-05 核实 / 2026-11-09 复核）：
//   - wx.getLocation 参数 type / isHighAccuracy(基础库 2.9.0) / highAccuracyExpireTime(基础库 2.9.0，须 >= 3000ms)
//   - 需 scope.userLocation 授权；2022-07-14 后发布的小程序须在 app.json 声明 requiredPrivateInfos
//   - 开发者工具定位用 IP 模拟，且「工具目前仅支持 gcj02 坐标」，故这里用 gcj02；
//     真机若需 GPS 原始坐标，把 TYPE 改成 'wgs84'，并同步改 config.NEAREST_STATION.gpsCoord
//   - 隐私预检 wx.getPrivacySetting / wx.requirePrivacyAuthorize 自基础库 2.32.3 起支持，低版本做降级

const config = require('./config.js');

const TAG = '[GPS]';
const TYPE = 'gcj02';

// 内存缓存：只存一次定位结果，不落 Storage、不上传。
let lastLocation = null;
let listeners = [];

/** 写入缓存并通知等待中的页面（解决「定位晚于站点表就绪」的时序竞态） */
function setLocation(loc) {
  lastLocation = loc;
  const pending = listeners;
  listeners = [];
  pending.forEach(function (cb) {
    try { cb(loc); } catch (e) { console.error(TAG, '订阅回调异常（已隔离）：', e); }
  });
}

/** 取最近一次定位；没有（未授权 / 失败 / 尚未返回）时返回 null */
function getLastLocation() {
  return lastLocation;
}

/**
 * 定位就绪后回调；若已就绪则立即同步回调。
 * 返回取消订阅函数，页面 onUnload / 关闭详情时调用，避免重复刷新与内存残留。
 */
function whenReady(cb) {
  if (typeof cb !== 'function') return function () {};
  if (lastLocation) {
    try { cb(lastLocation); } catch (e) { console.error(TAG, '订阅回调异常（已隔离）：', e); }
    return function () {};
  }
  listeners.push(cb);
  return function () {
    listeners = listeners.filter(function (fn) { return fn !== cb; });
  };
}

/** 真正取一次坐标，并把结果打到控制台 */
function fetchAndLog() {
  wx.getLocation({
    type: TYPE,
    isHighAccuracy: true,
    highAccuracyExpireTime: 4000,
    success(res) {
      console.log(TAG, '获取成功，原始返回：', res);
      console.log(
        TAG,
        '纬度 =', res.latitude,
        '经度 =', res.longitude,
        '精度 =', res.accuracy, 'm',
        '速度 =', res.speed, 'm/s',
        '坐标系 =', TYPE
      );
      console.log(TAG, '经纬度（可直接复制）：' + res.latitude + ',' + res.longitude);
      setLocation({
        latitude: res.latitude,
        longitude: res.longitude,
        accuracy: res.accuracy,
        type: TYPE,
        at: Date.now()
      });
    },
    fail(err) {
      const msg = (err && err.errMsg) || err;
      console.warn(TAG, '获取失败：', msg);
      console.warn(
        TAG,
        '排查顺序：① 小程序后台「开发 → 开发管理 → 接口设置」是否已开通 getLocation 接口权限（未开通提审会被拦截、调用必失败）；' +
        '② 后台「设置 → 服务内容声明 → 用户隐私保护指引」是否已声明「位置信息」；' +
        '③ 是否曾拒绝过位置授权（小程序右上角「…」→ 设置 → 位置信息 重新打开）；' +
        '④ 开发者工具可在「模拟器 → 自定义位置」设定坐标，工具定位走 IP 模拟会有误差'
      );
      console.warn(TAG, '定位不可用，详情页「默认选中最近站」将原样回退为旧的「首辆车下一站」');
    }
  });
}

/**
 * 隐私协议预检：调用真实隐私接口前先确认用户已同意《用户隐私保护指引》。
 * 未注册 wx.onNeedPrivacyAuthorization，故由微信拉起统一隐私弹窗（行为以微信官方为准）。
 * 低版本基础库无此 API 时降级为直接调用，保证调试不被卡住。
 */
function afterPrivacy(cb) {
  if (typeof wx.getPrivacySetting !== 'function') {
    console.log(TAG, '当前基础库不支持隐私预检，降级直接定位');
    cb();
    return;
  }

  wx.getPrivacySetting({
    success(res) {
      console.log(TAG, '隐私授权状态：', res.needAuthorization ? '待用户同意' : '无需授权');
      if (!res.needAuthorization || typeof wx.requirePrivacyAuthorize !== 'function') {
        cb();
        return;
      }
      wx.requirePrivacyAuthorize({
        success() {
          console.log(TAG, '用户已同意隐私协议，继续获取定位');
          cb();
        },
        fail(err) {
          console.warn(TAG, '用户未同意隐私协议，本次放弃定位：', (err && err.errMsg) || err);
        }
      });
    },
    fail(err) {
      console.warn(TAG, '隐私状态查询失败，降级直接定位：', (err && err.errMsg) || err);
      cb();
    }
  });
}

/**
 * 本地联调：用 config.DEBUG_LOCATION 覆盖真实定位，便于人不到现场时验证「默认选中最近站」。
 * 默认 null，生产路径完全不进入此分支。返回是否启用了模拟定位。
 * 注意：模拟值只进内存与控制台，不落盘、不上传；提审前必须把配置改回 null。
 */
function applyDebugLocation() {
  const d = config.DEBUG_LOCATION;
  if (!d) return false;
  const lat = Number(d.latitude);
  const lon = Number(d.longitude);
  if (!isFinite(lat) || !isFinite(lon)) {
    console.warn(TAG, 'DEBUG_LOCATION 坐标无效，已忽略，继续走真实定位');
    return false;
  }
  console.warn(TAG, '注意：已启用调试模拟坐标（config.DEBUG_LOCATION），本次不调用 wx.getLocation；提审前必须改回 null');
  const loc = { latitude: lat, longitude: lon, accuracy: 0, type: TYPE, at: Date.now(), debug: true };
  console.log(TAG, '模拟定位：纬度 =', lat, '经度 =', lon, '坐标系 =', TYPE);
  console.log(TAG, '经纬度（可直接复制）：' + lat + ',' + lon);
  setLocation(loc);
  return true;
}

/**
 * 对外入口：App.onLaunch 调用一次。
 * 整个模块用 try/catch 全量隔离，任何异常都不会冒泡到业务代码。
 */
function logLocationOnEnter() {
  try {
    console.log(TAG, '小程序进入，准备获取一次定位…');
    if (applyDebugLocation()) return;
    if (typeof wx === 'undefined' || typeof wx.getLocation !== 'function') {
      console.warn(TAG, '当前环境不支持 wx.getLocation，跳过');
      return;
    }
    afterPrivacy(fetchAndLog);
  } catch (e) {
    console.error(TAG, '定位模块异常（已隔离，不影响原有业务）：', e);
  }
}

module.exports = { logLocationOnEnter, getLastLocation, whenReady };

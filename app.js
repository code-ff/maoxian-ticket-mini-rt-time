// app.js
const location = require('./utils/location.js');

App({
  onLaunch() {
    // 本轮新增：进入小程序时获取一次 GPS 并打印控制台。
    // 独立调试模块，内部已做隐私预检与全量异常隔离，不参与任何业务逻辑。
    location.logLocationOnEnter();
  }
});

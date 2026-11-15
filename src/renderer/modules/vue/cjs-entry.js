/* eslint-disable */
// vue$ 别名指向这里。
//
// 本项目的 Vue 是 vendored 的 ESM 版本（src/renderer/modules/vue/index.js 结尾是 `export default Vue`）。
// element-ui 这类 npm 包是打包好的 UMD/CJS，内部执行 `module.exports = require("vue")`，
// webpack 对 harmony 模块的 require 返回的是命名空间对象 { default: Vue, __esModule: true }，
// 于是 element-ui 拿到的不是构造函数，Vue.use / Vue.component 直接不存在 —— 组件与 $message 全都装不上。
//
// 这里给 CJS 侧一个「两种形状都对」的出口：
//   require('vue')        → Vue 构造函数本身（element-ui 可用）
//   _interopRequireDefault → 命中 __esModule，再取 .default 也是同一个 Vue
const mod = require('./index.js');
const Vue = mod && mod.__esModule ? mod.default : mod;

module.exports = Vue;
module.exports.default = Vue;
module.exports.__esModule = true;

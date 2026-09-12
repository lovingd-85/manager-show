'use strict';

// 构建脚本：把 WebGL 星云背景引擎连同 three.js 打包为单个 IIFE 文件
// → public/vendor/nebula.min.js，供页面以 <script src> 同源自托管加载
// （满足 CSP script-src 'self'，全程无 CDN / 无运行时请求）。
// 用法：npm run build:vendor
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const result = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/webgl/nebula.js')],
  bundle: true,
  format: 'iife',
  minify: true,
  legalComments: 'none',
  target: ['es2020'],
  outfile: path.join(root, 'public/vendor/nebula.min.js'),
  logLevel: 'error',
});

if (result.errors.length) process.exit(1);
console.log(`已生成 public/vendor/nebula.min.js（${(require('node:fs').statSync(path.join(root, 'public/vendor/nebula.min.js')).size / 1024).toFixed(0)} KB）`);

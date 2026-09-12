/* Manager Show · 背景调度（theme.js）
   - 唯一背景色板：default 靛紫（.aurora-a CSS 降级层 + 星云引擎内置同色板），
     不再按页面/风险/日程切换氛围
   - 指针视差只作用于 CSS 降级层：WebGL 星云运行时（body.nebula-on）不位移，
     且仅在 hover 设备、非 prefers-reduced-motion 时启用
*/
'use strict';

(function () {
  const body = document.body;
  const fallback = document.querySelector('.bg-fallback');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canHover = window.matchMedia('(hover: hover)').matches;

  // 极光降级层的轻微视差（GPU 合成；星云启动后该层被画布完全覆盖，跳过写入）
  if (fallback && !reduceMotion && canHover) {
    let raf = null;
    let px = 0;
    let py = 0;
    window.addEventListener('pointermove', (e) => {
      if (body.classList.contains('nebula-on')) return;
      px = (e.clientX / window.innerWidth - 0.5) * 2;
      py = (e.clientY / window.innerHeight - 0.5) * 2;
      if (raf === null) {
        raf = requestAnimationFrame(() => {
          fallback.style.setProperty('--par-x', (px * 12).toFixed(1) + 'px');
          fallback.style.setProperty('--par-y', (py * 9).toFixed(1) + 'px');
          raf = null;
        });
      }
    }, { passive: true });
  }
})();

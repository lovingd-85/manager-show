/* Manager Show · WebGL 动态星云背景引擎（three.js ShaderMaterial，本地打包自托管）
   --------------------------------------------------------------------------------
   由 dynamic Nebula Shader（InteractiveNebulaShader）移植为原生 JS 版本，重点改进：
   - 固定全屏 canvas（body 直接子元素，不参与任何 transform/位移容器 → 无黑边、无截断）
   - cover 裁切：着色器内以「中心化 + 最短边归一」计算 UV，任意宽高比都填满且不拉伸主体
   - 高品质：8 步光线行进 + 提前退出、highp 精度、胶片颗粒去色带、DPR 上限 2（>2 肉眼无差）
   - 降级：WebGL 不可用 / 上下文丢失 → body.no-webgl，CSS 渐变层接管（theme.js 的极光）
   - prefers-reduced-motion：只渲染一帧静态星云（固定 iTime），不启动动画循环、无指针视差
   - 页面隐藏时暂停渲染；唯一背景色板 default 靛紫（不随页面/风险/日程切换）
   - Canvas 始终连续动画：路由过渡不暂停/不降帧（曾因过渡期暂停再恢复显得卡顿，
     已移除 setPriority），对外只暴露 window.MSNebula.state 供测试/诊断
   --------------------------------------------------------------------------------
   构建：npm run build:vendor → public/vendor/nebula.min.js（IIFE，含 three，同源自托管）。
*/
import * as THREE from 'three';

/* ---------- 顶点着色器：整屏正交四边形，传递 UV ---------- */
const VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
  }
`;

/* ---------- 片元着色器：光线行进星云 ----------
   UV 说明（cover 裁切的关键）：
   uv = (fragCoord - 0.5*res) / min(res.x, res.y)
   即以屏幕中心为原点、最短边为 1 个单位 —— 16:9 时水平范围 ±0.89、竖屏 9:16 时垂直 ±0.89。
   星云主体永远居中且不被拉伸，四周由 map 场自然延伸填满，任何宽高比无黑边、无截断。 */
const FRAGMENT_SHADER = /* glsl */ `
  #ifdef GL_FRAGMENT_PRECISION_HIGH
    precision highp float;
  #else
    precision mediump float;
  #endif

  uniform vec2  iResolution;
  uniform float iTime;
  uniform vec2  iMouse;     // 指针位置（0..1，左下原点），驱动轻微视差
  uniform vec3  uBaseA;     // 色板 · 基础色（唯一色板 default 靛紫）
  uniform vec3  uBaseB;     // 色板 · 光量系数
  uniform float uDim;       // 1 = 中心变暗（内容可读），0 = 关闭
  varying vec2 vUv;

  #define t iTime
  mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

  float map(vec3 p) {
    p.xz *= rot(t * 0.4);
    p.xy *= rot(t * 0.3);
    vec3 q = p * 2. + t;
    return length(p + vec3(sin(t * 0.7))) * log(length(p) + 1.0)
         + sin(q.x + sin(q.z + sin(q.y))) * 0.5 - 1.0;
  }

  void main() {
    // 中心化 + 最短边归一（cover）。乘以 0.72 收窄视场（zoom）：
    // 星云主体在宽屏/竖屏的边缘仍然落在采样范围内 —— 任何宽高比都填满、无黑边、无截断
    vec2 uv = (gl_FragCoord.xy - 0.5 * iResolution) / min(iResolution.x, iResolution.y) * 0.72;
    uv += (iMouse - 0.5) * 0.07;

    vec3 col = vec3(0.0);
    float d = 2.5;
    // 8 步光线行进（原版 6 步）：贴到表面附近即提前退出，边缘区域自然衰减
    for (int i = 0; i < 8; i++) {
      vec3 p = vec3(0.0, 0.0, 5.0) + normalize(vec3(uv, -1.0)) * d;
      float rz = map(p);
      float f = clamp((rz - map(p + 0.1)) * 0.5, -0.1, 1.0);
      vec3 base = uBaseA + uBaseB * f;
      col = col * base + smoothstep(2.5, 0.0, rz) * 0.7 * base;
      d += min(rz, 1.0);
      if (rz < 0.02) break;
    }

    // 中心变暗：内容卡片区域压暗，边缘保留星云光感（uDim=0 时关闭）
    float dist   = distance(gl_FragCoord.xy, iResolution * 0.5);
    float radius = min(iResolution.x, iResolution.y) * 0.5;
    float dim    = smoothstep(radius * 0.30, radius * 0.55, dist);
    col = mix(col * 0.30, col, mix(dim, 1.0, 1.0 - uDim));

    // 轻微色调映射 + 边缘环境光抬升：星云主体之外的远角也保持深蓝底色，
    // 与 CSS 暗角叠加后仍高于纯黑，杜绝"黑边"
    col = 1.0 - exp(-col * 1.25);
    float edge = smoothstep(0.5, 1.1, length(uv));
    col = max(col, vec3(0.06, 0.095, 0.16) * (0.45 + 0.55 * edge));

    // 胶片颗粒（消除低亮度区色带）
    float grain = fract(sin(dot(gl_FragCoord.xy + vec2(t * 7.0, t * 5.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    col = max(col + grain * 0.014, vec3(0.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ---------- 唯一背景色板：default 靛紫（不随页面/风险/日程切换） ---------- */
const PALETTES = {
  default: { a: [0.10, 0.30, 0.40], b: [5.0, 2.5, 3.0] },
};

const MAX_DPR = 2;          // >2 肉眼无可见差异，避免 4K 屏无谓的填充压力

(function initNebula() {
  const canvas = document.getElementById('nebula-canvas');
  const body = document.body;
  if (!canvas || !body) return;

  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const canHover = window.matchMedia('(hover: hover)').matches;
  const reducedMotion = () => reduceMotionQuery.matches;

  let renderer = null;
  let material = null;
  let mesh = null;
  let failed = false;
  let disposed = false;
  const clock = new THREE.Clock();
  const mouse = new THREE.Vector2(0.5, 0.5);
  const targetMouse = new THREE.Vector2(0.5, 0.5);

  /* ---------- 降级：切到 CSS 渐变背景 ---------- */
  function fail() {
    if (disposed) return;
    failed = true;
    body.classList.add('no-webgl');
    body.classList.remove('nebula-on');
    if (renderer) { renderer.setAnimationLoop(null); renderer.dispose(); }
    window.removeEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', onResize);
    window.removeEventListener('pointermove', onPointerMove);
    renderer = null;
    // 保留 API 形状：状态为 fallback
    window.MSNebula = { state: 'fallback' };
  }

  /* ---------- 尺寸：canvas 铺满视口（固定定位、无 transform），渲染缓冲按 DPR ---------- */
  function onResize() {
    if (!renderer) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w <= 0 || h <= 0) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_DPR));
    renderer.setSize(w, h, false);   // false：CSS 尺寸由样式表控制（100% x 100%）
    material.uniforms.iResolution.value.set(renderer.domElement.width, renderer.domElement.height);
    if (reducedMotion()) renderStatic();   // 静态模式下尺寸变化需重绘
  }

  function onPointerMove(e) {
    if (reducedMotion() || !canHover) return;
    targetMouse.set(
      Math.max(0, Math.min(1, e.clientX / window.innerWidth)),
      Math.max(0, Math.min(1, 1 - e.clientY / window.innerHeight)),
    );
  }

  /* ---------- 静态帧（prefers-reduced-motion）：固定 iTime，不启动循环 ---------- */
  function renderStatic() {
    if (!renderer || !material) return;
    material.uniforms.iTime.value = 9.7;   // 选取构图饱满的固定时刻
    renderer.render(scene, camera);
  }

  /* ---------- 初始化 ---------- */
  let scene = null;
  let camera = null;
  try {
    if (!window.WebGLRenderingContext) throw new Error('no WebGLRenderingContext');
    // 先用临时 context 探测真实可用性：失败时跳过 three，降级路径不产生控制台报错噪音
    const probe = document.createElement('canvas');
    const probeCtx = probe.getContext('webgl2') || probe.getContext('webgl');
    if (!probeCtx) throw new Error('WebGL context unavailable');
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
    });
  } catch {
    fail();
    return;
  }

  scene = new THREE.Scene();
  camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const p0 = PALETTES.default;
  material = new THREE.ShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      iResolution: { value: new THREE.Vector2(1, 1) },
      iTime: { value: 0 },
      iMouse: { value: mouse },
      uBaseA: { value: new THREE.Vector3(...p0.a) },
      uBaseB: { value: new THREE.Vector3(...p0.b) },
      uDim: { value: 1 },
    },
  });
  mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  // WebGL 上下文丢失（GPU 重置 / 驱动故障）→ 立即降级到 CSS 渐变
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); fail(); });

  window.addEventListener('resize', onResize, { passive: true });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize, { passive: true });
  if (!reducedMotion() && canHover) window.addEventListener('pointermove', onPointerMove, { passive: true });

  onResize();

  // 动画循环（reduced-motion 下不启动；偏好中途改变时响应式切换）
  const onMotionPref = () => {
    if (!renderer) return;
    if (reducedMotion()) {
      renderer.setAnimationLoop(null);
      renderStatic();
    } else {
      clock.getElapsedTime();   // 重置时间基准，避免静止期被计入
      renderer.setAnimationLoop(animate);
    }
  };
  reduceMotionQuery.addEventListener('change', onMotionPref);

  function animate() {
    if (!renderer || failed || disposed) return;
    if (document.hidden) return;          // 隐藏时暂停（省电），回到前台自动续帧

    material.uniforms.iTime.value = clock.getElapsedTime();

    // 指针视差缓动
    mouse.lerp(targetMouse, 0.06);

    renderer.render(scene, camera);
  }

  if (reducedMotion()) {
    renderStatic();
  } else {
    renderer.setAnimationLoop(animate);
  }

  // 首帧已渲染：亮出画布（CSS 过渡淡入，避免白/黑闪）
  body.classList.add('nebula-on');

  /* ---------- 对外 API ---------- */
  window.MSNebula = {
    /** 测试/诊断用：当前引擎状态 */
    get state() {
      return failed ? 'fallback' : (reducedMotion() ? 'static' : 'running');
    },
  };
})();

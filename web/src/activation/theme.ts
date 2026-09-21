import type { Color } from "../graph/types-extra";

export const THEME = {
  colors: {
    rest: [96, 165, 250] as Color,
    seed: [255, 205, 135] as Color,
    expand: [125, 211, 252] as Color,
    conflict: [226, 120, 245] as Color,
    /** 支持链撞上反对关系时的珊瑚洋红：与普通冲突色接近，但更具“碰撞”感。 */
    tension: [251, 113, 133] as Color,
    /** 假设反转的紫青色：表示认知视角翻面，不表示结论成立。 */
    inversion: [167, 139, 250] as Color,
    analogy: [34, 211, 238] as Color,
    support: [74, 222, 128] as Color,
    counter: [251, 113, 133] as Color,
    boundary: [251, 191, 36] as Color,
    verified: [45, 212, 191] as Color,
    invalid: [248, 113, 113] as Color,
    sufficient: [52, 211, 153] as Color,
    insufficient: [251, 191, 36] as Color,
    simulation: [192, 132, 252] as Color,
    lens: [255, 190, 100] as Color,
    read: [56, 189, 248] as Color,
    write: [196, 181, 253] as Color,
    nodeGlow: [255, 193, 92] as Color,
    /** 神经元信号金：沿边传递的柔和金光（render.ts 使用，保留自 v2.0） */
    signal: [255, 205, 105] as Color,
    /** 信号前锋白金光：扫过时的头部高亮 */
    signalHead: [255, 238, 185] as Color,
    tensionSignal: [251, 113, 133] as Color,
    tensionHead: [255, 214, 220] as Color,
    inversionSignal: [167, 139, 250] as Color,
    inversionHead: [216, 234, 255] as Color,
    /** 1/2/3 跳的节点核心色；外围抵达光晕仍统一使用 nodeGlow。 */
    pathDepth: [
      [125, 211, 252] as Color,
      [96, 165, 250] as Color,
      [167, 139, 250] as Color,
    ],
    background: "rgba(64, 65, 70, 0.92)",
    attentionVeil: [44, 45, 50] as Color,
    attentionVeilAlpha: 0.16,
  },
  timing: {
    /** front 从 0 推进到 1.3 的秒数 */
    frontDuration: 0.72,
    /** 保持期结束时刻（秒） */
    holdUntil: 2.0,
    /** 衰减期秒数 */
    fadeDuration: 0.7,
    /** 同事件多束点亮的错峰秒数 */
    stagger: 0.1,
    /** 同批召回节点的微错峰秒数 */
    nodeStagger: 0.12,
    /** 相邻图遍历深度之间的波次间隔；需明显大于同层边错峰。 */
    pathStagger: 0.42,
    /** 关系前锋发出后，节点开始呈现抵达反馈的延迟。 */
    pathNodeDelay: 0.24,
    /** 同轮精读卡片之间的错峰秒数 */
    readStagger: 2.0,
    /** 真实认知事件进入画布后的最小间隔；让操作痕迹可读，而不伪造新事件。 */
    eventQueueGap: 0.68,
    /** 精读节点保持缓慢脉冲激活的总时长（秒） */
    readPulseDuration: 5.5,
    /** 总时长内完成的呼吸次数；两次可保持缓慢、可辨但不催促 */
    readPulseCycles: 2,
    /** 精读激活结束前的柔和退出时长（秒） */
    readExitDuration: 0.24,
    /** 节点从暗到亮的入场时长 */
    nodeEntryDuration: 0.24,
    /** OPS 解释性动作：展开、停留、退出；不套用按钮反馈时长。 */
    gestureDuration: 0.72,
    gestureHold: 1.28,
    gestureExit: 0.7,
    /** 大批结果分组展开，避免数量线性放大等待时间。 */
    maxStaggerSpan: 0.72,
    /** 即使任务提前结束，关系也至少完整可读这一时长 */
    minReadable: 0.82,
  },
  search: {
    cycleDuration: 1.85,
    entryDuration: 0.28,
    exitDuration: 0.52,
  },
  fibers: {
    baseAlphaIntra: 0.1,
    baseAlphaInter: 0.2,
    litAlpha: 0.82,
    spread: 14,
  },
  node: {
    seedAct: 1.2,
    readAct: 0.9,
    catalogAct: 0.66,
    writeAct: 1.28,
    /** 每 60fps 帧的 act 衰减系数 */
    decayPerFrame: 0.99,
    /** act 超过此值才显示标题 */
    labelThreshold: 0.45,
  },
};

export const LENS_ORDINALS = ["一", "二", "三", "四", "五", "六"];

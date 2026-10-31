/**
 * bloub 机器人头像（React 封装）。
 *
 * 动画引擎整体移植自 https://github.com/jeremy-prt/bloub （`./bloub/` 目录，纯
 * TypeScript，逐文件对应上游 src/bot/）：身体是每帧由径向剖面实时计算的 path，
 * 状态切换时逐点 morph——thinking 会收缩成圆点、弹出三点脉冲，wink 眨眼等；
 * 眼睛是球面切线投影「真洞」，滑向球缘时被轮廓自动裁剪。
 *
 * 本组件只做三件事：
 * 1. 驱动引擎：rAF 时钟（有界增量，标签页隐藏恢复不跳变）+ 一小段编排
 *    （默认 待机 → thinking → 待机 → 眨眼 循环，让形变动画周期可见）；
 * 2. 视线跟随鼠标：指针相对头像按半屏归一化 → 头部 yaw/pitch（gaze.ts 的
 *    lookTarget 规则，去掉面向设置面板的基础转角），仅作用于有静息脸的状态；
 * 3. 主题适配：跟随 html.light 切换墨色/纸色。眼洞透出的是「纸色」=页面
 *    背景色本身，所以任何主题下都不会出现轮廓描边。
 */

import { useEffect, useId, useRef, useState } from "react";
import { BotEngine, type BotFrame } from "./bloub/engine.js";
import { NOTIF_BLUE, type DotRender } from "./bloub/decor.js";
import { SPIN, TURN_TIME, YAW_MAX, PITCH_MAX, PITCH } from "./bloub/gaze.js";
import { EXPRESSION_BY_ID } from "./bloub/expressions.js";
import { mixHex } from "./bloub/skins.js";
import { clamp, easings } from "./bloub/math.js";
import { STATE_BY_ID, type StateId } from "./bloub/states.js";

// 坐标系（上游 repere.ts）：静止球半径 100。viewBox 半宽取 120 而非上游的
// 158——上游留白是为了轨道/彗星的圆环（半径 1.4R），默认编排只有
// idle/thinking/wink，身体与圆点最远 ~1.12R，收紧后同尺寸下球更大。
const R = 100;
const VB = 120;

/** 默认编排：循环播放，thinking 段展示 path 形变动画。 */
const DEFAULT_CYCLE: { state: StateId; duration: number }[] = [
  { state: "idle", duration: 5.2 },
  { state: "thinking", duration: 2.6 },
  { state: "idle", duration: 3.4 },
  { state: "wink", duration: 1.6 },
];

/** 视线跟随的朝向幅度（gaze.ts）：够大能看出在看，够小眼睛不出球缘。 */

export interface BloubBotProps {
  /** 渲染边长（px），正方形 */
  size?: number;
  /**
   * 静息表情（expressions.ts 的 id），作用于待机等静止脸状态；默认「惊讶」。
   */
  expression?: string;
  /** 播放的编排，默认 待机 → thinking → 待机 → 眨眼 循环 */
  cycle?: { state: StateId; duration: number }[];
  /** 视线跟随鼠标，默认开 */
  follow?: boolean;
  /** 覆盖墨色（身体）；默认随主题：浅色 #0a0a0c / 深色 #f4f4f5 */
  ink?: string;
  /** 覆盖纸色（眼洞透出的背景色）；默认随主题与聊天区底色一致 */
  paper?: string;
  className?: string;
}

/** 读取当前是否浅色主题（App 通过 html.light 切换黑白）。SSR 环境无 document，按深色处理。 */
function useIsLightTheme(): boolean {
  const [isLight, setIsLight] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("light"),
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsLight(document.documentElement.classList.contains("light"));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);
  return isLight;
}

export function BloubBot({
  size = 96,
  expression = "surpris",
  cycle = DEFAULT_CYCLE,
  follow = true,
  ink: inkProp,
  paper: paperProp,
  className,
}: BloubBotProps) {
  // useId 纯净生成实例级 id（清洗掉冒号，保证 url(#id) 引用安全）
  const uid = useId().replace(/:/g, "");
  const maskId = `bloub-mask-${uid}`;
  const isLight = useIsLightTheme();
  const ink = inkProp ?? (isLight ? "#0a0a0c" : "#f4f4f5");
  const paper = paperProp ?? (isLight ? "#ffffff" : "#000000");

  const svgRef = useRef<SVGSVGElement>(null);
  // 引擎是可变对象，只在 effect 里创建与驱动；帧数据走 state 驱动渲染
  const [frame, setFrame] = useState<BotFrame | null>(null);

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !cycle.length) return;

    const expr = EXPRESSION_BY_ID.get(expression) ?? null;
    const engine = new BotEngine(R, cycle[0]?.state ?? "idle", null, expr);

    // --- 编排播放 ---
    let blockIdx = 0;
    let nextAt = cycle[0]?.duration ?? Infinity;

    // --- 指针跟随（移植 BloubBot.vue 的 aim/release）---
    let pointer: { x: number; y: number } | null = null;
    let aiming = false;
    let turnSince = 0;
    const onPointerMove = (event: PointerEvent) => {
      // 触屏没有悬停光标：手指抬起会让视线停在最后一点，像 bug
      if (event.pointerType === "touch") return;
      pointer = { x: event.clientX, y: event.clientY };
    };
    const onPointerLeave = () => {
      pointer = null;
    };
    if (follow) {
      window.addEventListener("pointermove", onPointerMove);
      document.documentElement.addEventListener("pointerleave", onPointerLeave);
    }

    function release(clock: number) {
      if (!aiming) return;
      engine.setLook(null, clock, TURN_TIME);
      aiming = false;
    }

    /**
     * 瞄准指针。只做 DOM 部分（量出球和光标在哪），视线规则在这里内联：
     * 与 gaze.ts 的 lookTarget 相同，但去掉面向设置面板的基础转角（-TURN），
     * 待机时正对前方。进场半秒内 mix 爬升 + 一整圈 spin——眼睛绕球一周后
     * 落到指针上，正好展示球面投影。
     */
    function aim(clock: number) {
      // 只在带静息脸的状态跟随；其余状态视线的位姿就是动画本身
      if (!STATE_BY_ID.get(engine.state)?.baseFace) {
        release(clock);
        return;
      }
      const box = svgRef.current?.getBoundingClientRect();
      // 零尺寸矩形（面板隐藏时）会让归一化变成 0/0=NaN，而引擎会永久保留
      // NaN 目标——直接跳过本帧
      if (!box || box.width === 0 || box.height === 0) return;
      if (!aiming) turnSince = clock;
      const nx = pointer
        ? clamp((pointer.x - (box.left + box.width / 2)) / Math.max(1, window.innerWidth / 2), -1, 1)
        : 0;
      const ny = pointer
        ? clamp((pointer.y - (box.top + box.height / 2)) / Math.max(1, window.innerHeight / 2), -1, 1)
        : 0;
      const tour = easings.easeOutQuint(clamp((clock - turnSince) / TURN_TIME));
      engine.setLook(
        {
          yaw: nx * YAW_MAX,
          // 屏幕向下为正，而俯仰向上为正
          pitch: PITCH - ny * PITCH_MAX,
          mix: tour,
          spin: SPIN * (1 - tour),
          wander: pointer !== null ? 0 : 1,
        },
        clock,
      );
      aiming = true;
    }

    let raf = 0;
    let last = 0;
    let clock = 0;
    const tick = (ms: number) => {
      raf = requestAnimationFrame(tick);
      const dt = last ? Math.min((ms - last) / 1000, 0.064) : 0;
      last = ms;
      clock += dt;

      if (clock >= nextAt) {
        blockIdx = (blockIdx + 1) % cycle.length;
        const block = cycle[blockIdx];
        if (block) {
          engine.setState(block.state, clock);
          nextAt = clock + block.duration;
        } else {
          nextAt = Infinity;
        }
      }

      if (follow) aim(clock);

      setFrame(engine.sample(clock));
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
    };
  }, [cycle, expression, follow]);

  /** 点位属性：颜色默认跟身体；depth 用于爆散粒子融入背景。 */
  function dotAttrs(dot: DotRender) {
    const fill =
      dot.color ?? (dot.depth === undefined ? ink : mixHex(paper, ink, dot.depth));
    const common = { fill, opacity: dot.opacity };
    return dot.d
      ? {
          ...common,
          d: dot.d,
          transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${R})`,
        }
      : { ...common, cx: dot.x, cy: dot.y, r: dot.r };
  }

  if (!frame) {
    return (
      <svg
        ref={svgRef}
        width={size}
        height={size}
        viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
        role="img"
        aria-label="bloub 动画头像"
        className={className}
      />
    );
  }

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`${-VB} ${-VB} ${VB * 2} ${VB * 2}`}
      role="img"
      aria-label="bloub 动画头像"
      className={className}
    >
      <defs>
        {/*
          眼睛是身体上的「真洞」（与 bloub/x.ai 一致）：在 mask 里挖掉后，
          视线滑到球缘时被轮廓自动裁掉，而不是贴片。
        */}
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x={-VB}
          y={-VB}
          width={VB * 2}
          height={VB * 2}
        >
          <path d={frame.bodyPath} fill="#fff" />
          {frame.eyes.map((eye, i) => (
            <path key={i} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="#000" />
          ))}
          {frame.notch ? (
            <circle cx={frame.notch.x} cy={frame.notch.y} r={frame.notch.r} fill="#000" />
          ) : null}
        </mask>

        {frame.arcs.map((arc) => (
          <linearGradient
            key={arc.id}
            id={`${uid}-${arc.id}`}
            gradientUnits="userSpaceOnUse"
            x1={arc.grad.x1}
            y1={arc.grad.y1}
            x2={arc.grad.x2}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((c, i) => (
              <stop key={i} offset={i / (arc.grad.stops.length - 1)} stopColor={c} />
            ))}
          </linearGradient>
        ))}
      </defs>

      {/* 轨道的后半段：先画，被身体遮住 */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            key={`b${arc.id}`}
            d={arc.back}
            stroke={`url(#${uid}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>

      {/* 爆散粒子：位于核心之后 */}
      {frame.dotsBehind ? (
        <g>
          {frame.dots.map((dot, i) =>
            dot.d ? (
              <path key={`pb${i}`} {...dotAttrs(dot)} />
            ) : (
              <circle key={`pb${i}`} {...dotAttrs(dot)} />
            ),
          )}
        </g>
      ) : null}

      <g opacity={frame.bodyAlpha}>
        {/* 底层：眼洞透出的纸色（=页面背景色），所以不会有轮廓描边 */}
        <path d={frame.bodyPath} fill={paper} />
        <g mask={`url(#${maskId})`}>
          <rect x={-VB} y={-VB} width={VB * 2} height={VB * 2} fill={ink} />
        </g>
      </g>

      {!frame.dotsBehind ? (
        <g>
          {frame.dots.map((dot, i) =>
            dot.d ? (
              <path key={`pf${i}`} {...dotAttrs(dot)} />
            ) : (
              <circle key={`pf${i}`} {...dotAttrs(dot)} />
            ),
          )}
        </g>
      ) : null}

      {frame.notif ? (
        <circle cx={frame.notif.x} cy={frame.notif.y} r={frame.notif.r} fill={NOTIF_BLUE} />
      ) : null}

      {/* 轨道的前半段 */}
      <g fill="none" strokeLinecap="round">
        {frame.arcs.map((arc) => (
          <path
            key={`f${arc.id}`}
            d={arc.front}
            stroke={`url(#${uid}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>
    </svg>
  );
}

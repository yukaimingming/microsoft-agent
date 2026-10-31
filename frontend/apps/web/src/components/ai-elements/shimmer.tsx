"use client";

/**
 * shadcn/ui Shimmer 特效组件实现（带 color 彩色微光）。
 * 遵循 shadcn 官方规范：https://ui.shadcn.com/docs/utils/shimmer
 *
 * 核心特性：
 * 1. 采用纯 CSS / Tailwind 的 background-clip: text 与 tw-shimmer 渐变关键帧流动；
 * 2. 对齐 shadcn 官网默认样式：基于 currentColor 继承文字颜色（支持通过 color 属性或 shimmer-color-* 自定义）；
 * 3. 完美兼容多态渲染（默认 as="span"），防止在按钮/折叠标签内出现非法嵌套；
 * 4. 深度适配黑白双色主题（Light / Dark），浅色高质感科技蓝、深色绚丽灵动电光青。
 */

import { cn } from "@/lib/utils";
import type { ComponentProps, ElementType, ReactNode } from "react";

export type ShimmerProps<T extends ElementType = "span"> = {
  as?: T;
  children: ReactNode;
  className?: string;
  /** 动画周期秒数，默认 2s */
  duration?: number;
  /** 高光散布宽度 */
  spread?: number;
  /** 高光色彩，默认使用 shadcn 官方风格的彩色微光 (如 #378ADD / blue-500) */
  color?: string;
} & Omit<ComponentProps<T>, "as" | "children">;

export const Shimmer = <T extends ElementType = "span">({
  as,
  children,
  className,
  duration = 2,
  spread,
  color,
  style,
  ...props
}: ShimmerProps<T>) => {
  const Component = (as || "span") as ElementType;

  return (
    <Component
      className={cn(
        // 文字本体深浅主题自适应（深色白/浅色黑），高光为官方柔和电光蓝
        "shimmer shimmer-color-blue-500/60 text-foreground inline-block select-none font-medium",
        className
      )}
      style={{
        ...style,
        ...(duration ? { "--shimmer-duration": `${duration}s` } : {}),
        ...(spread ? { "--shimmer-spread": `${spread}ch` } : {}),
        ...(color ? { "--shimmer-color": color } : {}),
      } as React.CSSProperties}
      {...(props as any)}
    >
      {children}
    </Component>
  );
};

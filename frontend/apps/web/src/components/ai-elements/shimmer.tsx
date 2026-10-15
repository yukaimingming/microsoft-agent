"use client";

/**
 * 官方 AI SDK Elements Shimmer 组件实现。
 * 参考：https://elements.ai-sdk.dev/components/shimmer
 *
 * 核心特性：
 * 1. 使用 motion/react 的 motion.create 创建可多态渲染的微光组件；
 * 2. 默认使用 span，彻底解决嵌入在 button/CollapsibleTrigger 时的 HTML 嵌套冲突；
 * 3. 亮白高光从右向左匀速扫过暗灰文字表面，呈现流畅细腻的加载/思考动效。
 */

import { cn } from "@/lib/utils";
import { motion, type MotionStyle } from "motion/react";
import type { ComponentProps, ElementType, ReactNode } from "react";
import { useMemo } from "react";

export type ShimmerProps<T extends ElementType = "span"> = {
  as?: T;
  children: string;
  className?: string;
  duration?: number;
  spread?: number;
} & Omit<ComponentProps<T>, "as" | "children">;

export const Shimmer = <T extends ElementType = "span">({
  as,
  children,
  className,
  duration = 2,
  spread = 2,
  style,
  ...props
}: ShimmerProps<T>) => {
  const Component = (as || "span") as any;
  const MotionComponent = useMemo(() => motion.create(Component), [Component]);

  const dynamicSpread = useMemo(() => {
    return (children?.length ?? 0) * spread;
  }, [children, spread]);

  const combinedStyle: MotionStyle = {
    ...style,
    // @ts-expect-error motion supports custom CSS properties in style
    "--spread": `${dynamicSpread}px`,
    backgroundImage:
      "var(--bg), linear-gradient(var(--color-muted-foreground,#71717a), var(--color-muted-foreground,#71717a))",
  };

  return (
    <MotionComponent
      animate={{
        backgroundPosition: ["100% center", "0% center"],
      }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-foreground,#ffffff),#0000_calc(50%+var(--spread)))]",
        "[background-repeat:no-repeat,padding-box]",
        className
      )}
      initial={{
        backgroundPosition: "100% center",
      }}
      style={combinedStyle}
      transition={{
        duration,
        ease: "linear",
        repeat: Number.POSITIVE_INFINITY,
      }}
      {...(props as any)}
    >
      {children}
    </MotionComponent>
  );
};


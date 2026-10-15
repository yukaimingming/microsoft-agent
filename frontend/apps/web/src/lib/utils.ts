/** 类名合并工具：AI Elements 组件通过 `@/lib/utils` 引入。 */
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

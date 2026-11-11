"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, CSSProperties, HTMLAttributes } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  BundledLanguage,
  BundledTheme,
  HighlighterGeneric,
  ThemedToken,
} from "shiki";
import { bundledLanguages, createHighlighter } from "shiki";

// Shiki uses bitflags for font styles: 1=italic, 2=bold, 4=underline
// oxlint-disable-next-line eslint(no-bitwise)
const isItalic = (fontStyle: number | undefined) => fontStyle && fontStyle & 1;
// oxlint-disable-next-line eslint(no-bitwise)
const isBold = (fontStyle: number | undefined) => fontStyle && fontStyle & 2;
const isUnderline = (fontStyle: number | undefined) =>
  // oxlint-disable-next-line eslint(no-bitwise)
  fontStyle && fontStyle & 4;

// Transform tokens to include pre-computed keys to avoid noArrayIndexKey lint
interface KeyedToken {
  token: ThemedToken;
  key: string;
}
interface KeyedLine {
  tokens: KeyedToken[];
  key: string;
}

const addKeysToTokens = (lines: ThemedToken[][]): KeyedLine[] =>
  lines.map((line, lineIdx) => ({
    key: `line-${lineIdx}`,
    tokens: line.map((token, tokenIdx) => ({
      key: `line-${lineIdx}-${tokenIdx}`,
      token,
    })),
  }));

// Token rendering component
const TokenSpan = ({ token }: { token: ThemedToken }) => {
  const darkText = token.htmlStyle?.["--shiki-dark"];
  const darkBg = token.htmlStyle?.["--shiki-dark-bg"];
  return (
    <span
      className={cn(
        darkBg && "dark:!bg-[var(--shiki-dark-bg)]",
        darkText && "dark:!text-[var(--shiki-dark)]"
      )}
      style={
        {
          backgroundColor: token.bgColor,
          color: token.color,
          fontStyle: isItalic(token.fontStyle) ? "italic" : undefined,
          fontWeight: isBold(token.fontStyle) ? "bold" : undefined,
          textDecoration: isUnderline(token.fontStyle) ? "underline" : undefined,
          ...token.htmlStyle,
        } as CSSProperties
      }
    >
      {token.content}
    </span>
  );
};

// Line number styles using CSS counters
const LINE_NUMBER_CLASSES = cn(
  "block",
  "before:content-[counter(line)]",
  "before:inline-block",
  "before:[counter-increment:line]",
  "before:w-8",
  "before:mr-4",
  "before:text-right",
  "before:text-muted-foreground/50",
  "before:font-mono",
  "before:select-none"
);

// Line rendering component
const LineSpan = ({
  keyedLine,
  showLineNumbers,
}: {
  keyedLine: KeyedLine;
  showLineNumbers: boolean;
}) => (
  <span className={showLineNumbers ? LINE_NUMBER_CLASSES : "block"}>
    {keyedLine.tokens.length === 0
      ? "\n"
      : keyedLine.tokens.map(({ token, key }) => (
          <TokenSpan key={key} token={token} />
        ))}
  </span>
);

// Types
type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
};

interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

interface CodeBlockContextType {
  code: string;
}

// Context
const CodeBlockContext = createContext<CodeBlockContextType>({
  code: "",
});

const SHIKI_THEMES: [BundledTheme, BundledTheme] = ["github-light", "github-dark"];
const PRELOAD_LANGUAGES: BundledLanguage[] = [
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "bash",
  "json",
  "css",
  "html",
  "sql",
  "yaml",
  "markdown",
  "csharp",
];

// 全局单例 Shiki Highlighter，避免按语言重复初始化 WASM 实例
let sharedHighlighter: HighlighterGeneric<BundledLanguage, BundledTheme> | null = null;
let sharedHighlighterPromise: Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> | null = null;
const loadedLanguages = new Set<string>();
const pendingLanguageLoads = new Map<string, Promise<void>>();

// 有界 LRU Token 缓存，防止长时间对话内存膨胀
const MAX_TOKENS_CACHE = 1000;
const tokensCache = new Map<string, TokenizedCode>();

// 异步高亮回调订阅表（支持卸载取消订阅）
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  typescript: "typescript",
  mts: "typescript",
  cts: "typescript",
  jsx: "jsx",
  tsx: "tsx",
  py: "python",
  python: "python",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  shellscript: "bash",
  shellsession: "bash",
  console: "bash",
  zsh: "bash",
  html: "html",
  htm: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  rust: "rust",
  rs: "rust",
  go: "go",
  golang: "go",
  c: "c",
  h: "c",
  cpp: "cpp",
  "c++": "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  "c#": "csharp",
  fs: "fsharp",
  fsharp: "fsharp",
  "f#": "fsharp",
  java: "java",
  php: "php",
  ruby: "ruby",
  rb: "ruby",
  swift: "swift",
  kotlin: "kotlin",
  kt: "kotlin",
  kts: "kotlin",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  docker: "dockerfile",
  powershell: "powershell",
  pwsh: "powershell",
  ps: "powershell",
  ps1: "powershell",
  bat: "bat",
  batch: "bat",
  cmd: "bat",
  make: "makefile",
  makefile: "makefile",
  conf: "nginx",
  nginx: "nginx",
  env: "dotenv",
  dotenv: "dotenv",
  objc: "objc",
  "objective-c": "objc",
  tex: "latex",
  latex: "latex",
  proto: "proto",
  protobuf: "proto",
  tf: "terraform",
  terraform: "terraform",
  wasm: "wasm",
  toml: "toml",
  graphql: "graphql",
  gql: "graphql",
  "vue-html": "html",
  text: "text",
  txt: "text",
  plaintext: "text",
  plain: "text",
};

export const normalizeLanguage = (rawLang?: string): BundledLanguage => {
  if (!rawLang || typeof rawLang !== "string") return "text" as BundledLanguage;
  const clean = rawLang.trim().toLowerCase();
  if (!clean) return "text" as BundledLanguage;
  const mapped = LANGUAGE_ALIASES[clean] ?? clean;
  if (mapped === "text") return "text" as BundledLanguage;
  if (Object.prototype.hasOwnProperty.call(bundledLanguages, mapped)) {
    return mapped as BundledLanguage;
  }
  return "text" as BundledLanguage;
};

const hashCodeString = (input: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x01000193);
  }
  return `${(h1 >>> 0).toString(36)}-${(h2 >>> 0).toString(36)}`;
};

const getTokensCacheKey = (code: string, language: BundledLanguage) => {
  const safeLang = normalizeLanguage(language);
  return `${safeLang}:${code.length}:${hashCodeString(code)}`;
};

const getCachedTokens = (key: string): TokenizedCode | undefined => {
  const hit = tokensCache.get(key);
  if (!hit) return undefined;
  // LRU 刷新位置
  tokensCache.delete(key);
  tokensCache.set(key, hit);
  return hit;
};

const setCachedTokens = (key: string, value: TokenizedCode): void => {
  if (tokensCache.has(key)) {
    tokensCache.delete(key);
  } else if (tokensCache.size >= MAX_TOKENS_CACHE) {
    const oldestKey = tokensCache.keys().next().value;
    if (oldestKey !== undefined) {
      tokensCache.delete(oldestKey);
    }
  }
  tokensCache.set(key, value);
};

const ensureSharedHighlighter = (): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  if (sharedHighlighter) {
    return Promise.resolve(sharedHighlighter);
  }
  if (sharedHighlighterPromise) {
    return sharedHighlighterPromise;
  }

  sharedHighlighterPromise = createHighlighter({
    langs: PRELOAD_LANGUAGES,
    themes: SHIKI_THEMES,
  })
    .catch(() =>
      createHighlighter({
        langs: [],
        themes: SHIKI_THEMES,
      })
    )
    .then((highlighter) => {
      sharedHighlighter = highlighter;
      for (const lang of highlighter.getLoadedLanguages()) {
        loadedLanguages.add(lang);
      }
      return highlighter;
    })
    .catch((error) => {
      sharedHighlighterPromise = null;
      throw error;
    });

  return sharedHighlighterPromise;
};

const ensureLanguageLoaded = async (
  safeLang: BundledLanguage
): Promise<HighlighterGeneric<BundledLanguage, BundledTheme>> => {
  const highlighter = await ensureSharedHighlighter();
  if (safeLang === ("text" as BundledLanguage)) {
    return highlighter;
  }
  if (loadedLanguages.has(safeLang) || highlighter.getLoadedLanguages().includes(safeLang)) {
    loadedLanguages.add(safeLang);
    return highlighter;
  }

  let pending = pendingLanguageLoads.get(safeLang);
  if (!pending) {
    pending = highlighter
      .loadLanguage(safeLang)
      .then(() => {
        loadedLanguages.add(safeLang);
      })
      .catch(() => {
        // 个别语法加载失败时不阻塞后续渲染，回退为纯文本
      })
      .finally(() => {
        pendingLanguageLoads.delete(safeLang);
      });
    pendingLanguageLoads.set(safeLang, pending);
  }
  await pending;
  return highlighter;
};

// 在真实浏览器环境中后台预热常用语法，使首个代码块也有机会在首帧同步着色
if (
  typeof window !== "undefined" &&
  typeof document !== "undefined" &&
  typeof navigator !== "undefined" &&
  !navigator.userAgent.includes("jsdom")
) {
  queueMicrotask(() => {
    void ensureSharedHighlighter().catch(() => undefined);
  });
}

// Create raw tokens for immediate display while highlighting loads
const createRawTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ]
  ),
});

const tokenizeWithHighlighter = (
  highlighter: HighlighterGeneric<BundledLanguage, BundledTheme>,
  code: string,
  safeLang: BundledLanguage
): TokenizedCode => {
  const availableLangs = highlighter.getLoadedLanguages();
  const langToUse = availableLangs.includes(safeLang) ? safeLang : "text";
  const result = highlighter.codeToTokens(code, {
    lang: langToUse,
    themes: {
      dark: "github-dark",
      light: "github-light",
    },
  });

  return {
    bg: result.bg ?? "transparent",
    fg: result.fg ?? "inherit",
    tokens: result.tokens,
  };
};

/** 纯同步高亮：仅当缓存命中或单例 Highlighter 与目标语言均已加载完成时返回，无副作用。 */
export const highlightCodeSync = (
  code: string,
  language: BundledLanguage
): TokenizedCode | null => {
  const safeLang = normalizeLanguage(language);
  if (safeLang === ("text" as BundledLanguage)) {
    return null;
  }

  const tokensCacheKey = getTokensCacheKey(code, safeLang);
  const cached = getCachedTokens(tokensCacheKey);
  if (cached) {
    return cached;
  }

  if (
    sharedHighlighter &&
    (loadedLanguages.has(safeLang) || sharedHighlighter.getLoadedLanguages().includes(safeLang))
  ) {
    loadedLanguages.add(safeLang);
    const tokenized = tokenizeWithHighlighter(sharedHighlighter, code, safeLang);
    setCachedTokens(tokensCacheKey, tokenized);
    return tokenized;
  }

  return null;
};

const subscribeHighlight = (
  code: string,
  language: BundledLanguage,
  callback: (result: TokenizedCode) => void
): (() => void) => {
  const safeLang = normalizeLanguage(language);
  const tokensCacheKey = getTokensCacheKey(code, safeLang);

  const isFirstForKey = !subscribers.has(tokensCacheKey);
  let subs = subscribers.get(tokensCacheKey);
  if (!subs) {
    subs = new Set();
    subscribers.set(tokensCacheKey, subs);
  }
  subs.add(callback);

  if (isFirstForKey) {
    void ensureLanguageLoaded(safeLang)
      .then((highlighter) => {
        const currentSubs = subscribers.get(tokensCacheKey);
        if (!currentSubs || currentSubs.size === 0) {
          return;
        }

        const tokenized =
          getCachedTokens(tokensCacheKey) ?? tokenizeWithHighlighter(highlighter, code, safeLang);
        setCachedTokens(tokensCacheKey, tokenized);

        subscribers.delete(tokensCacheKey);
        for (const sub of currentSubs) {
          sub(tokenized);
        }
      })
      .catch((error) => {
        console.error("Failed to highlight code:", error);
        subscribers.delete(tokensCacheKey);
      });
  }

  return () => {
    const currentSubs = subscribers.get(tokensCacheKey);
    if (!currentSubs) return;
    currentSubs.delete(callback);
    if (currentSubs.size === 0) {
      subscribers.delete(tokensCacheKey);
    }
  };
};

// Synchronous highlight with callback for async results
export const highlightCode = (
  code: string,
  language: BundledLanguage,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void
): TokenizedCode | null => {
  const syncResult = highlightCodeSync(code, language);
  if (syncResult) {
    return syncResult;
  }

  if (callback) {
    subscribeHighlight(code, language, callback);
  } else {
    void ensureLanguageLoaded(normalizeLanguage(language)).catch(() => undefined);
  }

  return null;
};

const CodeBlockBody = memo(
  ({
    tokenized,
    showLineNumbers,
    className,
  }: {
    tokenized: TokenizedCode;
    showLineNumbers: boolean;
    className?: string;
  }) => {
    const keyedLines = useMemo(
      () => addKeysToTokens(tokenized.tokens),
      [tokenized.tokens]
    );

    return (
      <pre
        className={cn(
          "m-0 overflow-x-auto p-4 font-mono text-[13px] leading-relaxed bg-transparent text-zinc-800 dark:text-zinc-200",
          className
        )}
      >
        <code
          className={cn(
            "font-mono text-[13px]",
            showLineNumbers && "[counter-increment:line_0] [counter-reset:line]"
          )}
        >
          {keyedLines.map((keyedLine) => (
            <LineSpan
              key={keyedLine.key}
              keyedLine={keyedLine}
              showLineNumbers={showLineNumbers}
            />
          ))}
        </code>
      </pre>
    );
  },
  (prevProps, nextProps) =>
    prevProps.tokenized === nextProps.tokenized &&
    prevProps.showLineNumbers === nextProps.showLineNumbers &&
    prevProps.className === nextProps.className
);

CodeBlockBody.displayName = "CodeBlockBody";

export const CodeBlockContainer = ({
  className,
  language,
  style,
  ...props
}: HTMLAttributes<HTMLDivElement> & { language: string }) => (
  <div
    className={cn(
      "group relative w-full overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-900 shadow-xs dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 transition-colors",
      className
    )}
    data-language={language}
    style={{
      containIntrinsicSize: "auto 200px",
      contentVisibility: "auto",
      ...style,
    }}
    {...props}
  />
);

export const CodeBlockHeader = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex items-center justify-between border-b border-zinc-200/80 bg-zinc-100/70 px-3.5 py-1.5 text-zinc-600 dark:border-zinc-800/80 dark:bg-zinc-900/90 dark:text-zinc-400 text-xs select-none",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const CodeBlockTitle = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex items-center gap-2", className)} {...props}>
    {children}
  </div>
);

export const CodeBlockFilename = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) => (
  <span className={cn("font-mono", className)} {...props}>
    {children}
  </span>
);

export const CodeBlockActions = ({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("-my-1 -mr-1 flex items-center gap-2", className)}
    {...props}
  >
    {children}
  </div>
);

export const CodeBlockContent = ({
  code,
  language,
  showLineNumbers = false,
}: {
  code: string;
  language: BundledLanguage;
  showLineNumbers?: boolean;
}) => {
  const safeLang = normalizeLanguage(language);
  const rawTokens = useMemo(() => createRawTokens(code), [code]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (safeLang === ("text" as BundledLanguage)) {
        return () => {};
      }
      if (highlightCodeSync(code, safeLang)) {
        return () => {};
      }
      return subscribeHighlight(code, safeLang, () => {
        onStoreChange();
      });
    },
    [code, safeLang]
  );

  const getSnapshot = useCallback(
    () => highlightCodeSync(code, safeLang),
    [code, safeLang]
  );

  const highlightedTokens = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot
  );

  const tokenized = highlightedTokens ?? rawTokens;

  return (
    <div className="relative overflow-auto">
      <CodeBlockBody showLineNumbers={showLineNumbers} tokenized={tokenized} />
    </div>
  );
};

export const CodeBlock = ({
  code,
  language,
  showLineNumbers = false,
  className,
  children,
  ...props
}: CodeBlockProps) => {
  const contextValue = useMemo(() => ({ code }), [code]);

  return (
    <CodeBlockContext.Provider value={contextValue}>
      <CodeBlockContainer className={className} language={language} {...props}>
        {children}
        <CodeBlockContent
          code={code}
          language={language}
          showLineNumbers={showLineNumbers}
        />
      </CodeBlockContainer>
    </CodeBlockContext.Provider>
  );
};

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
  onCopy?: () => void;
  onError?: (error: Error) => void;
  timeout?: number;
};

export const CodeBlockCopyButton = ({
  onCopy,
  onError,
  timeout = 2000,
  children,
  className,
  ...props
}: CodeBlockCopyButtonProps) => {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number>(0);
  const { code } = useContext(CodeBlockContext);

  const copyToClipboard = useCallback(async () => {
    if (typeof window === "undefined" || !navigator?.clipboard?.writeText) {
      onError?.(new Error("Clipboard API not available"));
      return;
    }

    try {
      if (!isCopied) {
        await navigator.clipboard.writeText(code);
        setIsCopied(true);
        onCopy?.();
        timeoutRef.current = window.setTimeout(
          () => setIsCopied(false),
          timeout
        );
      }
    } catch (error) {
      onError?.(error as Error);
    }
  }, [code, onCopy, onError, timeout, isCopied]);

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    []
  );

  const Icon = isCopied ? CheckIcon : CopyIcon;

  return (
    <Button
      className={cn(
        "size-7 shrink-0 rounded-md text-zinc-500 hover:bg-zinc-200/80 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-white transition-colors cursor-pointer",
        className
      )}
      onClick={copyToClipboard}
      size="icon"
      variant="ghost"
      {...props}
    >
      {children ?? (
        <Icon
          size={14}
          className={isCopied ? "text-emerald-600 dark:text-emerald-400" : ""}
        />
      )}
    </Button>
  );
};

export type CodeBlockLanguageSelectorProps = ComponentProps<typeof Select>;

export const CodeBlockLanguageSelector = (
  props: CodeBlockLanguageSelectorProps
) => <Select {...props} />;

export type CodeBlockLanguageSelectorTriggerProps = ComponentProps<
  typeof SelectTrigger
>;

export const CodeBlockLanguageSelectorTrigger = ({
  className,
  ...props
}: CodeBlockLanguageSelectorTriggerProps) => (
  <SelectTrigger
    className={cn(
      "h-7 border-none bg-transparent px-2 text-xs shadow-none",
      className
    )}
    size="sm"
    {...props}
  />
);

export type CodeBlockLanguageSelectorValueProps = ComponentProps<
  typeof SelectValue
>;

export const CodeBlockLanguageSelectorValue = (
  props: CodeBlockLanguageSelectorValueProps
) => <SelectValue {...props} />;

export type CodeBlockLanguageSelectorContentProps = ComponentProps<
  typeof SelectContent
>;

export const CodeBlockLanguageSelectorContent = ({
  align = "end",
  ...props
}: CodeBlockLanguageSelectorContentProps) => (
  <SelectContent align={align} {...props} />
);

export type CodeBlockLanguageSelectorItemProps = ComponentProps<
  typeof SelectItem
>;

export const CodeBlockLanguageSelectorItem = (
  props: CodeBlockLanguageSelectorItemProps
) => <SelectItem {...props} />;

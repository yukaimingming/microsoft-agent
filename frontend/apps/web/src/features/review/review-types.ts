/**
 * Review 功能与 Git 相关类型定义。
 */

export interface GitFileItem {
  /** 文件相对于仓储根目录的路径 */
  path: string;
  /** 文件名 */
  name: string;
  /** 所在父目录 */
  dir: string;
  /** 状态标识: U(未追踪), M(已修改), D(已删除), A(新增已暂存), R(重命名) */
  status: string;
  /** 是否属于已暂存区 */
  staged: boolean;
  /** 是否为图片 */
  isImage: boolean;
  /** 本地文件是否存在 */
  exists: boolean;
  /** 文件大小字节数 */
  size?: number;
}

export interface GitCommitItem {
  /** 提交哈希简写 */
  hash: string;
  /** 提交说明 */
  subject: string;
  /** 相对时间 */
  time: string;
}

export interface GitStatusResponse {
  /** 是否为有效 Git 仓库 */
  isGitRepo: boolean;
  /** 当前分支名 */
  branch: string;
  /** 仓储根目录 */
  repoRoot: string;
  /** 未暂存变更列表 */
  changes: GitFileItem[];
  /** 已暂存变更列表 */
  staged: GitFileItem[];
  /** 最近的提交历史 */
  commits: GitCommitItem[];
}

export interface GitDiffResponse {
  /** 文件相对路径 */
  path: string;
  /** 是否为图片文件 */
  isImage: boolean;
  /** 文本 Diff 差异内容（统一 diff 格式） */
  diff?: string;
  /** 图片变更前 Base64 数据（若为新增则为 null） */
  beforeImage?: string | null;
  /** 图片变更后 Base64 数据 */
  afterImage?: string | null;
  /** 图片 MIME 类型（如 image/png） */
  mimeType?: string;
  /** 错误信息 */
  error?: string;
}

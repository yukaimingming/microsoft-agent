/**
 * 个人微信 ClawBot (iLink 协议) 扫码绑定与状态管理弹窗。
 *
 * 对接微信开放文档规范：
 * https://developers.weixin.qq.com/doc/aispeech/knowledge/openapi/Clawbotrelated.html
 * - POST /api/v1/wechat/qrcode
 * - POST /api/v1/wechat/qrcode/status
 * - POST /api/v1/wechat/channel_reset
 */

import { useState } from "react";
import { Modal } from "../../components/modal.js";
import type {
  WeChatConnectionStatus,
  WeChatQrCodePayload,
  WeChatQrScanStatus,
} from "./use-wechat-clawbot.js";
import {
  SmartphoneIcon,
  RefreshCwIcon,
  CheckCircle2Icon,
  QrCodeIcon,
  UnplugIcon,
  ShieldCheckIcon,
  AlertCircleIcon,
  SparklesIcon,
  RadioIcon,
} from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

interface WeChatClawbotModalProps {
  open: boolean;
  onClose: () => void;
  connection: WeChatConnectionStatus;
  qrData: WeChatQrCodePayload | null;
  scanStatus: WeChatQrScanStatus;
  errorMessage: string | null;
  resetting: boolean;
  onFetchQrCode: () => Promise<void>;
  onResetChannel: (autoFetchNewQr?: boolean) => Promise<void>;
}

export function WeChatClawbotModal({
  open,
  onClose,
  connection,
  qrData,
  scanStatus,
  errorMessage,
  resetting,
  onFetchQrCode,
  onResetChannel,
}: WeChatClawbotModalProps) {
  // 已连接状态下是否展开重新扫码面板
  const [showRescanQr, setShowRescanQr] = useState(false);

  const isConnected = connection.connected || scanStatus === "confirmed";
  const qrImageSrc = qrData?.qrcode_base64 || qrData?.qrcode_url || "";

  const handleSwitchToQr = async () => {
    setShowRescanQr(true);
    await onFetchQrCode();
  };

  return (
    <Modal open={open} onClose={onClose} title="个人微信 ClawBot 连接 (iLink 协议)" width="md">
      <div className="flex flex-col gap-4" data-testid="wechat-clawbot-modal">
        {/* 顶部连接状态横幅 */}
        <div
          data-testid="wechat-clawbot-status-banner"
          className={`flex items-center justify-between rounded-xl border px-4 py-3 transition-colors ${
            isConnected
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
              : scanStatus === "scaned"
                ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                : scanStatus === "error" || scanStatus === "expired"
                  ? "border-red-500/30 bg-red-500/10 text-red-300"
                  : "border-zinc-800 bg-zinc-900/70 text-zinc-200"
          }`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span
              className={`size-2.5 shrink-0 rounded-full ${
                isConnected
                  ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)] animate-pulse"
                  : scanStatus === "scaned"
                    ? "bg-amber-400 animate-ping"
                    : scanStatus === "wait" || scanStatus === "loading"
                      ? "bg-sky-400 animate-pulse"
                      : "bg-zinc-500"
              }`}
            />
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-2 text-[13px] font-semibold">
                <span>
                  个人助手 ClawBot：
                  {isConnected
                    ? "已连接 (在线)"
                    : scanStatus === "scaned"
                      ? "手机已扫码，待确认"
                      : scanStatus === "wait"
                        ? "未连接 · 等待微信扫码"
                        : scanStatus === "loading"
                          ? "正在生成 iLink 二维码..."
                          : scanStatus === "expired"
                            ? "二维码已过期"
                            : "未连接"}
                </span>
              </div>
              <span className="text-[11.5px] opacity-80 truncate">
                {isConnected
                  ? `iLink 长轮询通道运行中 · 已绑定 Bot: ${connection.ilink_bot_id || "ClawBot"}`
                  : scanStatus === "scaned"
                    ? "请在手机微信界面上点击「确认登录 / 授权」完成连接"
                    : "使用个人微信扫描下方二维码，即可在微信里直接与您的个人 Agent 对话"}
              </span>
            </div>
          </div>

          <span
            data-testid="wechat-clawbot-badge"
            className={`shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-medium border ${
              isConnected
                ? "border-emerald-400/40 bg-emerald-500/20 text-emerald-300"
                : "border-zinc-700 bg-zinc-800 text-zinc-300"
            }`}
          >
            {isConnected ? "iLink 已连接" : "iLink 未连接"}
          </span>
        </div>

        {/* 主体区域：二维码扫码面板 或 已连接详情面板 */}
        {isConnected && !showRescanQr ? (
          <div
            data-testid="wechat-connected-panel"
            className="flex flex-col gap-3.5 rounded-xl border border-zinc-800 bg-zinc-900/40 p-4"
          >
            <div className="flex items-center gap-3">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400">
                <CheckCircle2Icon className="size-6" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-[14px] font-semibold text-zinc-100">
                  微信个人助手 ClawBot 已成功连接个人 Agent
                </h3>
                <p className="text-[12px] text-zinc-400 mt-0.5">
                  现在您可以直接在手机微信中向 ClawBot 发送消息，个人 Agent 将实时为您处理任务并回复。
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 pt-1 text-[12px]">
              <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3 py-2">
                <div className="text-zinc-500 text-[11px]">iLink Bot ID</div>
                <div className="font-mono text-zinc-200 truncate mt-0.5" title={connection.ilink_bot_id || "-"}>
                  {connection.ilink_bot_id || "已授权"}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3 py-2">
                <div className="text-zinc-500 text-[11px]">绑定微信用户 ID</div>
                <div className="font-mono text-zinc-200 truncate mt-0.5" title={connection.ilink_user_id || "等待首条消息同步"}>
                  {connection.ilink_user_id || "已绑定个人微信"}
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3 py-2">
                <div className="text-zinc-500 text-[11px]">长轮询通道状态 (getupdates)</div>
                <div className="flex items-center gap-1.5 text-emerald-400 font-medium mt-0.5">
                  <RadioIcon className="size-3.5 animate-pulse" />
                  <span>{connection.longpoll_active ? "实时监听中" : "已就绪"}</span>
                </div>
              </div>
              <div className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 px-3 py-2">
                <div className="text-zinc-500 text-[11px]">已处理微信消息数</div>
                <div className="font-mono text-zinc-200 mt-0.5">{connection.message_count} 条</div>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-zinc-800/60">
              <button
                type="button"
                data-testid="wechat-show-qrcode-btn"
                onClick={() => void handleSwitchToQr()}
                className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/80 px-3 py-1.5 text-[12px] font-medium text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                <QrCodeIcon className="size-3.5" />
                <span>重新扫码 / 显示二维码</span>
              </button>
              <button
                type="button"
                data-testid="wechat-reset-channel-btn"
                disabled={resetting}
                onClick={() => void onResetChannel(true)}
                className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-300 hover:bg-red-500/20 transition-colors disabled:opacity-50"
              >
                <UnplugIcon className="size-3.5" />
                <span>{resetting ? "正在重置..." : "断开并重置通道"}</span>
              </button>
            </div>
          </div>
        ) : (
          <div
            data-testid="wechat-qrcode-panel"
            className="flex flex-col items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/40 px-6 py-5"
          >
            {/* 二维码白色卡片容器 */}
            <div className="relative flex size-[236px] items-center justify-center rounded-2xl bg-white p-3 shadow-xl ring-1 ring-emerald-500/20">
              {scanStatus === "loading" && !qrImageSrc ? (
                <div className="flex flex-col items-center gap-2.5 text-zinc-600">
                  <Spinner className="size-7 text-emerald-600" />
                  <span className="text-[12px] font-medium">正在请求微信 iLink 二维码...</span>
                </div>
              ) : qrImageSrc ? (
                <img
                  data-testid="wechat-qrcode-img"
                  src={qrImageSrc}
                  alt="微信 ClawBot 登录二维码"
                  className="size-[210px] object-contain select-none rounded-lg"
                />
              ) : (
                <div className="flex flex-col items-center gap-2 text-center px-3 text-zinc-600">
                  <AlertCircleIcon className="size-7 text-red-500" />
                  <span className="text-[12px] font-medium">{errorMessage || "二维码加载失败"}</span>
                </div>
              )}

              {/* 已扫描待确认遮罩 */}
              {scanStatus === "scaned" && (
                <div
                  data-testid="wechat-qrcode-scaned-overlay"
                  className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-black/80 backdrop-blur-xs p-4 text-center text-white"
                >
                  <CheckCircle2Icon className="size-10 text-emerald-400 mb-2 animate-bounce" />
                  <div className="text-[13.5px] font-semibold">扫码成功</div>
                  <div className="text-[11.5px] text-zinc-300 mt-1">
                    请在手机微信上点击「确认」以授权连接个人 Agent
                  </div>
                </div>
              )}

              {/* 已过期或异常遮罩 */}
              {(scanStatus === "expired" || scanStatus === "error") && (
                <div
                  data-testid="wechat-qrcode-expired-overlay"
                  className="absolute inset-0 flex flex-col items-center justify-center rounded-2xl bg-black/80 backdrop-blur-xs p-4 text-center text-white"
                >
                  <AlertCircleIcon className="size-9 text-amber-400 mb-2" />
                  <div className="text-[13px] font-semibold">
                    {scanStatus === "expired" ? "二维码已过期" : "获取二维码失败"}
                  </div>
                  {errorMessage && (
                    <div className="text-[11px] text-zinc-300 mt-1 line-clamp-2">{errorMessage}</div>
                  )}
                  <button
                    type="button"
                    onClick={() => void onFetchQrCode()}
                    className="mt-3 flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3.5 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-500 transition-colors"
                  >
                    <RefreshCwIcon className="size-3.5" />
                    <span>点击刷新二维码</span>
                  </button>
                </div>
              )}
            </div>

            {/* 扫码提示与刷新按钮 */}
            <div className="mt-4 flex flex-col items-center text-center">
              <div className="flex items-center gap-1.5 text-[13.5px] font-medium text-zinc-100">
                <SmartphoneIcon className="size-4 text-emerald-400" />
                <span>请使用微信「扫一扫」绑定个人助手 ClawBot</span>
              </div>
              <p className="mt-1 text-[12px] text-zinc-400 max-w-md">
                基于腾讯微信 <code className="text-emerald-400 font-mono">iLink Bot</code> 协议直连，无需公网 IP 或反向代理，扫码确认后即可通过个人微信远程对话操控此 Agent。
              </p>

              <div className="mt-3 flex items-center gap-2.5">
                <button
                  type="button"
                  data-testid="wechat-refresh-qrcode-btn"
                  disabled={scanStatus === "loading"}
                  onClick={() => void onFetchQrCode()}
                  className="flex items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-800/90 px-3 py-1.5 text-[12px] text-zinc-200 hover:bg-zinc-700 hover:text-white transition-colors disabled:opacity-50"
                >
                  <RefreshCwIcon className={`size-3.5 ${scanStatus === "loading" ? "animate-spin" : ""}`} />
                  <span>刷新二维码</span>
                </button>

                {isConnected && showRescanQr && (
                  <button
                    type="button"
                    onClick={() => setShowRescanQr(false)}
                    className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-[12px] text-zinc-400 hover:text-zinc-200"
                  >
                    返回已连接状态
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 底部协议信息与操作流程说明 */}
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 px-4 py-3 text-[11.5px] text-zinc-400 space-y-1.5">
          <div className="flex items-center justify-between text-zinc-300 font-medium">
            <span className="flex items-center gap-1.5">
              <ShieldCheckIcon className="size-3.5 text-emerald-400" />
              <span>iLink 协议接口规范</span>
            </span>
            <span className="font-mono text-[11px] text-zinc-500">
              {connection.baseurl || "https://ilinkai.weixin.qq.com"}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] text-zinc-400">
            <div className="rounded-lg bg-zinc-900/70 px-2.5 py-1.5 border border-zinc-800/60">
              <span className="text-emerald-400 font-semibold">1. 获取二维码</span>
              <div className="text-zinc-500 truncate mt-0.5 font-mono text-[10px]">/api/v1/wechat/qrcode</div>
            </div>
            <div className="rounded-lg bg-zinc-900/70 px-2.5 py-1.5 border border-zinc-800/60">
              <span className="text-emerald-400 font-semibold">2. 状态长轮询</span>
              <div className="text-zinc-500 truncate mt-0.5 font-mono text-[10px]">/api/v1/wechat/qrcode/status</div>
            </div>
            <div className="rounded-lg bg-zinc-900/70 px-2.5 py-1.5 border border-zinc-800/60">
              <span className="text-emerald-400 font-semibold">3. 消息收发同步</span>
              <div className="text-zinc-500 truncate mt-0.5 font-mono text-[10px]">getupdates / sendmessage</div>
            </div>
          </div>
          {qrData?.qrcode && (
            <div className="pt-1 flex items-center justify-between text-[11px] text-zinc-500 border-t border-zinc-800/50">
              <span className="flex items-center gap-1">
                <SparklesIcon className="size-3 text-emerald-500" />
                <span>当前会话 Token:</span>
              </span>
              <code className="font-mono text-zinc-400">{qrData.qrcode}</code>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

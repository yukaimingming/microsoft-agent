import { useCallback, useEffect, useRef, useState } from "react";

export type WeChatQrScanStatus = "disconnected" | "loading" | "wait" | "scaned" | "confirmed" | "expired" | "error";

export interface WeChatCredentials {
  bot_token: string;
  ilink_bot_id: string;
  ilink_user_id: string;
}

export interface WeChatConnectionStatus {
  connected: boolean;
  status: string;
  ilink_bot_id?: string | null;
  ilink_user_id?: string | null;
  baseurl: string;
  connected_at?: string | null;
  last_message_at?: string | null;
  message_count: number;
  longpoll_active: boolean;
  last_error?: string | null;
}

export interface WeChatQrCodePayload {
  qrcode: string;
  qrcode_url: string;
  qrcode_img_content?: string | null;
  qrcode_base64?: string | null;
}

export function useWeChatClawbot(modalOpen: boolean) {
  const [connection, setConnection] = useState<WeChatConnectionStatus>({
    connected: false,
    status: "disconnected",
    baseurl: "https://ilinkai.weixin.qq.com",
    message_count: 0,
    longpoll_active: false,
  });

  const [qrData, setQrData] = useState<WeChatQrCodePayload | null>(null);
  const [scanStatus, setScanStatus] = useState<WeChatQrScanStatus>("disconnected");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const pollAbortRef = useRef<AbortController | null>(null);
  const activeQrTokenRef = useRef<string | null>(null);

  /** 拉取后端 ClawBot 实时连接状态 */
  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/wechat/status", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { success?: boolean; data?: WeChatConnectionStatus };
      if (json.success && json.data) {
        setConnection(json.data);
        if (json.data.connected) {
          setScanStatus("confirmed");
        }
      }
    } catch {
      // 忽略网络瞬时抖动
    }
  }, []);

  // 后台定时同步个人助手 ClawBot 连接状态
  useEffect(() => {
    void refreshStatus();
    const timer = setInterval(() => {
      void refreshStatus();
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshStatus]);

  /** 停止当前二维码状态长轮询 */
  const stopPolling = useCallback(() => {
    if (pollAbortRef.current) {
      pollAbortRef.current.abort();
      pollAbortRef.current = null;
    }
  }, []);

  /** 启动针对指定 qrcode token 的长轮询循环 */
  const startPollingQrStatus = useCallback(
    (qrcodeToken: string) => {
      stopPolling();
      const abortController = new AbortController();
      pollAbortRef.current = abortController;
      activeQrTokenRef.current = qrcodeToken;

      void (async () => {
        while (!abortController.signal.aborted && activeQrTokenRef.current === qrcodeToken) {
          try {
            const res = await fetch("/api/v1/wechat/qrcode/status", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ qrcode: qrcodeToken }),
              signal: abortController.signal,
            });

            if (!res.ok) {
              await new Promise((r) => setTimeout(r, 2000));
              continue;
            }

            const payload = (await res.json()) as {
              success?: boolean;
              data?: {
                status: "wait" | "scaned" | "confirmed" | "expired";
                credentials?: WeChatCredentials | null;
                baseurl?: string;
              };
            };

            if (abortController.signal.aborted || activeQrTokenRef.current !== qrcodeToken) {
              break;
            }

            const st = payload.data?.status ?? "wait";
            if (st === "confirmed") {
              setScanStatus("confirmed");
              await refreshStatus();
              break;
            } else if (st === "expired") {
              setScanStatus("expired");
              break;
            } else if (st === "scaned") {
              setScanStatus("scaned");
            } else {
              setScanStatus("wait");
            }

            // 稍微间隔后继续下一轮长轮询
            await new Promise((r) => setTimeout(r, 800));
          } catch (err) {
            if (abortController.signal.aborted) break;
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      })();
    },
    [refreshStatus, stopPolling],
  );

  /** 请求新的微信 ClawBot 登录二维码 */
  const fetchQrCode = useCallback(async () => {
    stopPolling();
    setScanStatus("loading");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/v1/wechat/qrcode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      const payload = (await res.json()) as {
        success?: boolean;
        data?: WeChatQrCodePayload;
        error?: string;
      };

      if (!res.ok || !payload.success || !payload.data?.qrcode) {
        throw new Error(payload.error || `获取二维码失败 (HTTP ${res.status})`);
      }

      setQrData(payload.data);
      setScanStatus("wait");
      startPollingQrStatus(payload.data.qrcode);
    } catch (err) {
      setScanStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "获取微信二维码失败，请检查网络连接");
    }
  }, [startPollingQrStatus, stopPolling]);

  /** 重置/断开微信 IM 通道 */
  const resetChannel = useCallback(
    async (autoFetchNewQr = true) => {
      setResetting(true);
      stopPolling();
      try {
        await fetch("/api/v1/wechat/channel_reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel_id: connection.ilink_bot_id || qrData?.qrcode || "default_channel",
          }),
        });
        setConnection((prev) => ({
          ...prev,
          connected: false,
          status: "disconnected",
          ilink_bot_id: null,
          ilink_user_id: null,
          longpoll_active: false,
        }));
        setQrData(null);
        setScanStatus("disconnected");
        if (autoFetchNewQr) {
          await fetchQrCode();
        }
      } finally {
        setResetting(false);
      }
    },
    [connection.ilink_bot_id, fetchQrCode, qrData?.qrcode, stopPolling],
  );

  // 当弹窗打开时，如果尚未连接或还没有获取二维码，则自动获取二维码；关闭弹窗时停止二维码轮询
  useEffect(() => {
    if (modalOpen) {
      void refreshStatus();
      if (!connection.connected && (!qrData || scanStatus === "expired" || scanStatus === "disconnected" || scanStatus === "error")) {
        void fetchQrCode();
      } else if (!connection.connected && qrData?.qrcode && (scanStatus === "wait" || scanStatus === "scaned")) {
        startPollingQrStatus(qrData.qrcode);
      }
    } else {
      stopPolling();
    }
    return () => {
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen]);

  return {
    connection,
    qrData,
    scanStatus,
    errorMessage,
    resetting,
    fetchQrCode,
    resetChannel,
    refreshStatus,
  };
}

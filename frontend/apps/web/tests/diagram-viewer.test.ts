/**
 * @vitest-environment jsdom
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiagramViewer } from "../src/features/chat/diagram-viewer.js";
import { MarkdownCodeBlock } from "../src/components/ai-elements/markdown-code-block.js";

describe("DiagramViewer 图表生成与展示测试", () => {
  it("案例 1：流程图 (Flowchart) 渲染测试", () => {
    const flowchartCode = `flowchart TD
    A["样本采集 (Collection)"] --> B["样本前处理 & 贴码条"]
    B --> C["物流运输至实验室"]
    C --> D["LIS 样本扫码签收"]
    D --> E{"样本状态初验"}
    E -- 合格 --> F["分析仪上机检测"]
    E -- 不合格/溶血 --> G["标记异常并通知重采"]
    F --> H["质控质检比对"]
    H --> I["LIS 自动初审"]
    I --> J["检验主管终审签字"]
    J --> K["发布检验报告 & 推送通知"]`;

    const html = renderToStaticMarkup(
      createElement(DiagramViewer, { code: flowchartCode })
    );

    // 验证图表卡片基础信息
    expect(html).toContain("流程图 (Flowchart)");
    expect(html).toContain("源码/编辑");
    expect(html).toContain("复制代码");
    expect(html).toContain("SVG");
    expect(html).toContain("PNG");
    expect(html).toContain("100%");
  });

  it("案例 2：时序图 (Sequence Diagram) 渲染测试", () => {
    const sequenceCode = `sequenceDiagram
    autonumber
    participant MT as MT8000 流水线分析仪
    participant LIS as 医院 LIS 系统
    participant DB as 检验数据库
    MT->>LIS: 1. 建立 TCP/HL7 通信握手
    LIS-->>MT: 2. 握手确认 (ACK)
    MT->>LIS: 3. 扫描试管条码查询测试项目 (QRY^Q02)
    LIS->>DB: 4. 检索样本检验申请单
    DB-->>LIS: 5. 返回项目明细
    LIS-->>MT: 6. 下发检测医嘱与通道参数
    MT->>LIS: 7. 上传检验结果数据
    LIS->>DB: 8. 写入检测结果并标记待审
    LIS-->>MT: 9. 确认接收数据完成`;

    const html = renderToStaticMarkup(
      createElement(DiagramViewer, { code: sequenceCode })
    );

    expect(html).toContain("时序图 (Sequence)");
    expect(html).toContain("SVG");
    expect(html).toContain("PNG");
  });

  it("案例 3：状态机图 (State Diagram) 渲染测试", () => {
    const stateCode = `stateDiagram-v2
    [*] --> 待支付: 创建订单
    待支付 --> 已支付: 支付成功
    待支付 --> 已取消: 超时未付/用户取消
    已支付 --> 处理中: 仓储配货/开始执行
    已支付 --> 已退款: 发起全额退款
    处理中 --> 已完成: 发货并确认收货
    处理中 --> 已取消: 异常阻断中断
    已完成 --> [*]
    已取消 --> [*]
    已退款 --> [*]`;

    const html = renderToStaticMarkup(
      createElement(DiagramViewer, { code: stateCode })
    );

    expect(html).toContain("状态机图 (State)");
    expect(html).toContain("源码/编辑");
  });

  it("MarkdownCodeBlock 自动拦截 mermaid 代码块并渲染为 DiagramViewer 卡片", () => {
    const mermaidMarkdownBlock = `flowchart LR
    A["客户端"] --> B["服务端"]`;

    const html = renderToStaticMarkup(
      createElement(MarkdownCodeBlock, {
        className: "language-mermaid",
        children: mermaidMarkdownBlock,
      })
    );

    // 应该渲染 DiagramViewer 的卡片结构，而非纯代码文本框
    expect(html).toContain("流程图 (Flowchart)");
    expect(html).toContain("源码/编辑");
    expect(html).toContain("SVG");
    expect(html).toContain("PNG");
  });
});

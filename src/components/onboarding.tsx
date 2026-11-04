// 首次启动新手引导：driver.js 聚光灯 tour。
// 仅在「从未看过 + 没有任何项目/会话」时自动弹（老用户升级不打扰）；
// 版本页有「重看引导」入口（pi:tour 事件，先关设置再开 tour）。

import { type Driver, driver } from "driver.js";
import { useEffect, useRef } from "react";
import "driver.js/dist/driver.css";
import type { State } from "@/hooks/usePi";

const KEY = "pi-desktop.onboarded.v1";

const STEPS: { element?: string; title: string; text: string }[] = [
  {
    title: "👋 欢迎使用 Pi",
    text: "一个围绕 pi coding agent 的桌面客户端。花 30 秒认识几个关键位置，之后随时能在「设置 → 版本」里重看。",
  },
  {
    element: "aside",
    title: "项目树",
    text: "点右上「新建」把文件夹加进来。每个项目悬停会出现 ＋ 新建会话 和 × 移除；同一项目的多个会话并行运行、互不打断。",
  },
  {
    element: 'textarea[data-editor="main"]',
    title: "输入框",
    text: "Enter 发送。可以粘贴或拖入附件（图片 / PDF / Word / Excel / zip 自动解析），输入 / 唤起斜杠命令，⌘N（Ctrl+N）新建会话。",
  },
  {
    element: 'button[title="选择模型"]',
    title: "模型切换",
    text: "随时切换供应商和模型；选 pi-desktop/auto 可按任务难度自动路由到便宜或最强的模型。",
  },
  {
    element: 'button[title="并行任务"]',
    title: "并行任务板",
    text: "把活儿丢给后台 agent 同时跑，随时回来追问、改需求或中止，不占用当前会话。",
  },
  {
    element: "aside div.border-t > button",
    title: "设置",
    text: "第一次使用先到「模型设置」配供应商密钥（有连接测试）。插件、技能、快捷键、用量统计也都在这里。",
  },
];

let active: Driver | null = null;

export function startTour() {
  active?.destroy();
  active = driver({
    showProgress: true,
    nextBtnText: "下一步",
    prevBtnText: "上一步",
    doneBtnText: "完成",
    progressText: "{{current}} / {{total}}",
    popoverClass: "pi-tour-popover",
    steps: STEPS.map(({ element, title, text }) => ({
      element,
      popover: { title, description: text },
    })),
    onDestroyed: () => {
      localStorage.setItem(KEY, "1");
      active = null;
    },
  });
  active.drive();
}

/** 首启自动引导；StrictMode 双挂载用 ref 护栏（与 boot 同款历史坑）。 */
export function OnboardingTour({ state }: { state: State }) {
  const fired = useRef(false);
  useEffect(() => {
    if (fired.current) return;
    // E2E 测试实例不弹；已有项目/会话的是老用户，也不弹
    if (window.pi.e2e) return;
    if (state.status !== "ready") return;
    if (localStorage.getItem(KEY)) return;
    if (state.projects.length > 0 || state.sessions.length > 0) return;
    fired.current = true;
    const id = setTimeout(() => startTour(), 600);
    return () => clearTimeout(id);
  }, [state.status, state.projects.length, state.sessions.length]);
  return null;
}

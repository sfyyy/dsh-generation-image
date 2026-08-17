/**
 * @dsh-extension/dsh-generation-image browser client.
 *
 * Registers a "Generation Image" section in the DSH Settings page (the
 * `settings.section` slot) with a small form for baseUrl / apiKey / model /
 * size / quality. The form reads and writes the plugin's config through the
 * same-origin backend route `/_dsh/generation-image/settings` (registered by
 * the host half).
 *
 * Hand-written in the DSH client ModuleLoader format — no build step needed.
 */
window.__ModuleLoader__.load({ id: "@dsh-extension/dsh-generation-image", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  "use strict";
  Object.defineProperty(exports, "__esModule", { value: true });

  const React = require("react");
  const { useEffect, useState } = React;
  const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
  const { Button, Input } = primitives;

  const ROUTE = "/_dsh/generation-image/settings";

  function el(type, props, ...children) {
    return React.createElement(type, props, ...children);
  }

  const card = {
    display: "grid", gap: "12px", maxWidth: "680px", padding: "8px 2px 24px",
    color: "var(--dsw-alias-label-primary,currentColor)",
  };
  const row = { display: "flex", gap: "10px", alignItems: "center" };
  const field = { display: "grid", gap: "6px", alignContent: "start" };
  const label = { fontSize: "12px", fontWeight: 600 };
  const muted = { margin: "0 0 4px", fontSize: "12px", color: "var(--dsw-alias-label-secondary,currentColor)", lineHeight: 1.5 };
  const alert = { padding: "10px 12px", borderRadius: "10px", fontSize: "12px", lineHeight: 1.5, background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)", color: "var(--dsw-alias-state-error-primary,currentColor)" };
  const ok = { padding: "10px 12px", borderRadius: "10px", fontSize: "12px", background: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)", color: "var(--dsw-alias-state-success-primary,currentColor)" };
  const hint = { fontSize: "11px", color: "var(--dsw-alias-label-secondary,currentColor)" };

  /**
   * Add a "download" control to the built-in image lightbox.
   *
   * DSH's built-in `ImageLightbox` (from @deepseek-ai/dsh-client-ui-attachment)
   * shows the enlarged image and a close control but has no download button.
   * When any image lightbox opens we inject a small "下载原图" button beside the
   * close control that downloads the enlarged image (the lightbox <img> src is
   * a same-origin blob:/data: URL, so an <a download> click just works).
   *
   * This is a page-level enhancement: it applies to every image lightbox in the
   * session (generated images, uploads, screenshots), which is the intended UX.
   */
  function installLightboxDownload() {
    const KEY = "generation-image-downloaded";
    const DEFAULT_NAME = "generated-image.png";

    function fileNameOf(img) {
      const alt = img && img.alt;
      return alt && /\.(png|jpe?g|webp|gif)$/i.test(alt) ? alt : DEFAULT_NAME;
    }

    function inject(dialog) {
      if (!(dialog instanceof HTMLElement) || dialog.dataset[KEY]) return;
      const img = dialog.querySelector("img");
      const close = dialog.querySelector("button");
      if (!img || !close) return;

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "下载原图";
      button.setAttribute("aria-label", "下载原图");
      Object.assign(button.style, {
        position: "fixed",
        top: "16px",
        right: "72px",
        zIndex: "1001",
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        padding: "8px 14px",
        borderRadius: "999px",
        border: "1px solid rgba(255,255,255,.25)",
        background: "rgba(0,0,0,.55)",
        color: "#fff",
        fontSize: "13px",
        lineHeight: "20px",
        cursor: "pointer",
        fontFamily: "inherit",
        backdropFilter: "blur(4px)",
      });
      button.addEventListener("click", function () {
        const src = img.currentSrc || img.src;
        if (!src) return;
        const a = document.createElement("a");
        a.href = src;
        a.download = fileNameOf(img);
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      });

      close.parentNode && close.parentNode.insertBefore(button, close);
      dialog.dataset[KEY] = "1";
    }

    function scan() {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      for (let i = 0; i < dialogs.length; i++) inject(dialogs[i]);
    }

    const observer = new MutationObserver(scan);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
    return () => observer.disconnect();
  }

  function GenerationImageSettings() {
    const [status, setStatus] = useState("loading");
    const [draft, setDraft] = useState(null);
    const [message, setMessage] = useState(null);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);

    async function load() {
      setStatus("loading"); setError(null);
      try {
        const res = await fetch(ROUTE, { credentials: "same-origin" });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error((body && body.error && body.error.message) || "加载设置失败");
        const eff = (body.value && body.value.effective) || {};
        setDraft({
          enabled: eff.enabled !== false,
          baseUrl: eff.baseUrl || "",
          apiKey: eff.apiKey || "",
          model: eff.model || "",
          size: eff.size || "",
          quality: eff.quality || "",
        });
        setStatus("ready");
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
        setStatus("error");
      }
    }

    useEffect(() => { void load(); }, []);

    function update(key, value) {
      setDraft((d) => (d ? { ...d, [key]: value } : d));
    }

    async function save() {
      if (!draft) return;
      setSaving(true); setError(null); setMessage(null);
      try {
        const res = await fetch(ROUTE, {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ value: draft }),
        });
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error((body && body.error && body.error.message) || "保存失败");
        setMessage("已保存，实时生效。会话中可通过 generate_image 工具按需生成图片。");
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    }

    if (status === "loading") {
      return el("div", { style: card }, el("div", { style: muted }, "加载中…"));
    }
    if (status === "error") {
      return el("div", { style: card },
        el("div", { style: alert }, error),
        el("div", { style: row }, el(Button, { variant: "outline", onClick: () => void load() }, "重试")),
      );
    }
    if (!draft) return null;

    return el("div", { style: card },
      el("h3", { style: { margin: "2px 0" } }, "Generation Image — 图像生成"),
      el("p", { style: muted },
        "配置你自己的 OpenAI 兼容图像生成端点（baseUrl + API Key）。会话中调用 generate_image 工具即可生成图片，图片会保存到会话并展示在界面上。"),

      el("label", { style: row },
        el("input", { type: "checkbox", checked: draft.enabled, onChange: (e) => update("enabled", e.target.checked) }),
        el("span", { style: label }, "启用")),

      el("label", { style: field },
        el("span", { style: label }, "Base URL"),
        el(Input, { value: draft.baseUrl, placeholder: "https://api.xiaoyaoapi.cc/v1", onChange: (e) => update("baseUrl", e.target.value) }),
        el("small", { style: hint }, "OpenAI 兼容图像端点基址（自动补 /images/generations）")),

      el("label", { style: field },
        el("span", { style: label }, "API Key"),
        el(Input, { value: draft.apiKey, placeholder: "sk-…", onChange: (e) => update("apiKey", e.target.value) })),

      el("label", { style: field },
        el("span", { style: label }, "模型"),
        el(Input, { value: draft.model, placeholder: "gpt-image-2", onChange: (e) => update("model", e.target.value) })),

      el("label", { style: field },
        el("span", { style: label }, "默认尺寸"),
        el(Input, { value: draft.size, placeholder: "1024x1024", onChange: (e) => update("size", e.target.value) })),

      el("label", { style: field },
        el("span", { style: label }, "默认质量"),
        el(Input, { value: draft.quality, placeholder: "auto", onChange: (e) => update("quality", e.target.value) }),
        el("small", { style: hint }, "auto / low / medium / high")),

      el("div", { style: row },
        el(Button, { variant: "primary", onClick: () => void save(), disabled: saving }, saving ? "保存中…" : "保存并应用"),
        el(Button, { variant: "outline", onClick: () => void load() }, "重新加载")),

      message ? el("div", { style: ok }, message) : null,
      error ? el("div", { style: alert }, error) : null,
    );
  }

  exports.inject = ["slots"];

  exports.apply = function apply(ctx) {
    ctx.effect(() => installLightboxDownload());

    ctx.slots.inject("settings.section", function* () {
      yield ctx.slots.register({
        name: "settings.section",
        id: "generation-image",
        order: 36,
        label: () => "Generation Image",
        inject: () => ({}),
      }, GenerationImageSettings);
    });
  };
  return module.exports;
}});

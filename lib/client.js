/**
 * @dsh-extension/dsh-generation-image browser client.
 *
 * Registers a "Generation Image" section in the DSH Settings page (the
 * `settings.section` slot) with a small form for baseUrl / apiKey / model.
 * (size / quality are deliberately NOT shown — the model passes them per
 * generate_image call, or the API decides.) The form reads and writes the
 * plugin's config through the same-origin backend route
 * `/_dsh/generation-image/settings` (registered by the host half).
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

  /**
   * Parse the settings-route response as JSON, turning a non-JSON body (e.g.
   * the SPA index.html that the server returns when the plugin's host half is
   * not registered) into a human-readable error instead of V8's cryptic
   * `Unexpected token '<', "<!doctype "... is not valid JSON`.
   */
  async function readJsonBody(res) {
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (err) {
      const ct = (res.headers && res.headers.get && res.headers.get("content-type")) || "";
      if (ct.indexOf("text/html") >= 0) {
        throw new Error("设置接口不可用：服务端返回了 HTML 页面而非 JSON（插件后端可能未加载/注册失败），请先修复插件注册。");
      }
      throw new Error("设置接口返回了无法解析的内容：" + String((err && err.message) || err));
    }
  }

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
    const DEFAULT_NAME = "generated-image.png";
    const BUTTON_ID = "generation-image-download-btn";

    let button = null;

    function fileNameOf(img) {
      const alt = img && img.alt;
      return alt && /\.(png|jpe?g|webp|gif)$/i.test(alt) ? alt : DEFAULT_NAME;
    }

    function removeButton() {
      if (button && button.isConnected && button.parentNode) button.parentNode.removeChild(button);
      button = null;
    }

    function ensureButton(img) {
      if (button && button.isConnected) return;
      const b = document.createElement("button");
      b.id = BUTTON_ID;
      b.type = "button";
      b.textContent = "下载原图";
      b.setAttribute("aria-label", "下载原图");
      Object.assign(b.style, {
        position: "fixed",
        top: "16px",
        right: "72px",
        zIndex: "2147483000",
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
      b.addEventListener("click", function () {
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
      // Append the button as a SIBLING of the lightbox — a direct child of
      // document.body, outside the app's React root (#root). Never insert it
      // INTO the lightbox dialog: the dialog is a React-managed subtree
      // (createPortal -> body), and mutating it with raw DOM breaks React's
      // reconciliation and freezes the page on the next re-render.
      document.body.appendChild(b);
      button = b;
    }

    function sync() {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      let img = null;
      for (let i = 0; i < dialogs.length && img === null; i++) {
        const candidate = dialogs[i].querySelector("img");
        if (candidate !== null) img = candidate;
      }
      if (img !== null) ensureButton(img);
      else removeButton();
    }

    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    sync();
    return () => {
      observer.disconnect();
      removeButton();
    };
  }

  const stackedGalleryStyle = {
    display: "grid",
    gap: "12px",
    maxWidth: "100%",
  };
  const stackedFrameStyle = {
    position: "relative",
    borderRadius: "12px",
    overflow: "hidden",
    border: "1px solid var(--dsw-alias-border-l2-darkmode-thin, rgba(255,255,255,.12))",
    background: "var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))",
  };
  const stackedImageStyle = {
    display: "block",
    width: "100%",
    maxHeight: "480px",
    objectFit: "contain",
    cursor: "zoom-in",
    background: "#000",
  };
  const stackedLoadingStyle = {
    padding: "40px",
    textAlign: "center",
    color: "var(--dsw-alias-label-tertiary, #888)",
    fontSize: "12px",
  };
  const stackedPreviewOverlayStyle = {
    position: "fixed",
    inset: 0,
    zIndex: 2147483000,
    display: "grid",
    placeItems: "center",
    padding: "40px",
    background: "rgba(0,0,0,.78)",
    cursor: "zoom-out",
  };
  const stackedPreviewImageStyle = {
    maxWidth: "calc(100vw - 80px)",
    maxHeight: "calc(100vh - 80px)",
    width: "auto",
    height: "auto",
    objectFit: "contain",
    borderRadius: "12px",
    boxShadow: "0 8px 40px rgba(0,0,0,.5)",
  };
  const stackedPreviewControlBase = {
    position: "fixed",
    zIndex: 2147483001,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "1px solid rgba(255,255,255,.25)",
    background: "rgba(0,0,0,.55)",
    color: "#fff",
    cursor: "pointer",
    fontFamily: "inherit",
    backdropFilter: "blur(4px)",
  };
  const stackedPreviewCloseStyle = {
    ...stackedPreviewControlBase,
    top: "20px",
    right: "24px",
    width: "40px",
    height: "40px",
    borderRadius: "50%",
    fontSize: "20px",
    lineHeight: "1",
  };
  const stackedPreviewDownloadStyle = {
    ...stackedPreviewControlBase,
    top: "20px",
    right: "76px",
    height: "40px",
    padding: "0 16px",
    borderRadius: "999px",
    fontSize: "13px",
    gap: "6px",
  };
  const stackedPreviewNavStyle = {
    ...stackedPreviewControlBase,
    top: "50%",
    transform: "translateY(-50%)",
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    fontSize: "28px",
    lineHeight: "1",
  };
  const stackedPreviewCounterStyle = {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 2147483001,
    padding: "6px 14px",
    borderRadius: "999px",
    background: "rgba(0,0,0,.55)",
    border: "1px solid rgba(255,255,255,.2)",
    color: "#fff",
    fontSize: "13px",
    fontFamily: "inherit",
    backdropFilter: "blur(4px)",
  };
  const stackedPreviewErrorStyle = {
    position: "fixed",
    bottom: "80px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 2147483001,
    padding: "8px 14px",
    borderRadius: "10px",
    background: "rgba(180,40,40,.8)",
    color: "#fff",
    fontSize: "13px",
    fontFamily: "inherit",
  };

  function StackedImageItem({ attachment, loadImage, onOpen, index }) {
    const [src, setSrc] = React.useState(null);
    const [error, setError] = React.useState(false);
    const [attempt, setAttempt] = React.useState(0);
    React.useEffect(() => {
      let live = true;
      setError(false);
      setSrc(null);
      loadImage(attachment).then((url) => {
        if (live) setSrc(url);
      }).catch(() => {
        if (live) setError(true);
      });
      return () => { live = false; };
    }, [attachment, loadImage, attempt]);
    const label = attachment && attachment.name ? attachment.name : "图片";
    if (error) {
      return React.createElement("button", {
        type: "button",
        onClick: () => setAttempt((a) => a + 1),
        style: { ...stackedFrameStyle, padding: "12px", cursor: "pointer", color: "var(--dsw-alias-label-tertiary, #888)" },
      }, "图片加载失败，点击重试");
    }
    return React.createElement("div", { style: stackedFrameStyle },
      src === null
        ? React.createElement("div", { style: stackedLoadingStyle }, "加载中…")
        : React.createElement("img", {
            src,
            alt: label,
            style: stackedImageStyle,
            title: "点击查看原图",
            onClick: () => onOpen(index),
          })
    );
  }

  function StackedMessageImages({ images, loadImage, align }) {
    const [previewIndex, setPreviewIndex] = React.useState(null);
    const [previewSrc, setPreviewSrc] = React.useState(null);
    const [previewError, setPreviewError] = React.useState(false);

    const previewAttachment = previewIndex === null || !images || !images[previewIndex]
      ? null
      : images[previewIndex].attachment;
    React.useEffect(() => {
      if (!previewAttachment) return;
      let live = true;
      setPreviewSrc(null);
      setPreviewError(false);
      loadImage(previewAttachment).then((url) => {
        if (live) setPreviewSrc(url);
      }).catch(() => {
        if (live) setPreviewError(true);
      });
      return () => { live = false; };
    }, [previewIndex, previewAttachment, loadImage]);

    if (!images || images.length === 0) return null;

    const open = (index) => setPreviewIndex(index);
    const close = () => {
      setPreviewIndex(null);
      setPreviewSrc(null);
      setPreviewError(false);
    };
    const prev = () => setPreviewIndex((i) => (i === null ? 0 : (i + images.length - 1) % images.length));
    const next = () => setPreviewIndex((i) => (i === null ? 0 : (i + 1) % images.length));
    const current = previewIndex === null ? null : images[previewIndex];
    const currentName = current && current.attachment && current.attachment.name
      ? current.attachment.name
      : "图片";
    const download = () => {
      if (!previewSrc) return;
      const a = document.createElement("a");
      a.href = previewSrc;
      a.download = currentName;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    };

    return React.createElement(React.Fragment, null,
      React.createElement("div", {
        style: { ...stackedGalleryStyle, justifyItems: align === "end" ? "end" : "start" },
      },
        images.map((image, index) => React.createElement(StackedImageItem, {
          key: `${image.attachment.attachmentId}:${index}`,
          attachment: image.attachment,
          loadImage,
          onOpen: open,
          index,
        }))
      ),
      previewIndex === null ? null : React.createElement("div", {
        style: stackedPreviewOverlayStyle,
        onClick: close,
      },
        previewError
          ? React.createElement("div", { style: stackedPreviewErrorStyle }, "图片加载失败")
          : previewSrc === null
            ? React.createElement("div", { style: stackedLoadingStyle }, "加载中…")
            : React.createElement("img", {
                src: previewSrc,
                alt: currentName,
                style: stackedPreviewImageStyle,
                onClick: (e) => e.stopPropagation(),
              }),
        React.createElement("button", {
          type: "button",
          "aria-label": "关闭",
          title: "关闭",
          style: stackedPreviewCloseStyle,
          onClick: (e) => { e.stopPropagation(); close(); },
        }, "✕"),
        React.createElement("button", {
          type: "button",
          "aria-label": "下载原图",
          title: "下载原图",
          style: stackedPreviewDownloadStyle,
          onClick: (e) => { e.stopPropagation(); download(); },
        }, "下载原图"),
        images.length > 1 ? React.createElement(React.Fragment, null,
          React.createElement("button", {
            type: "button",
            "aria-label": "上一张",
            title: "上一张",
            style: { ...stackedPreviewNavStyle, left: "20px" },
            onClick: (e) => { e.stopPropagation(); prev(); },
          }, "‹"),
          React.createElement("button", {
            type: "button",
            "aria-label": "下一张",
            title: "下一张",
            style: { ...stackedPreviewNavStyle, right: "20px" },
            onClick: (e) => { e.stopPropagation(); next(); },
          }, "›"),
          React.createElement("div", { style: stackedPreviewCounterStyle },
            `${previewIndex + 1} / ${images.length}`)
        ) : null
      )
    );
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
        const body = await readJsonBody(res);
        if (!res.ok || !body.ok) throw new Error((body && body.error && body.error.message) || "加载设置失败");
        const eff = (body.value && body.value.effective) || {};
        setDraft({
          enabled: eff.enabled !== false,
          baseUrl: eff.baseUrl || "",
          apiKey: eff.apiKey || "",
          model: eff.model || "",
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
        const body = await readJsonBody(res);
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

    // Replace the default small-tile gallery with a stacked image list so every
    // image block in one assistant message is visible (and clickable).
    ctx.slots.inject("conversation.message.images", () => ctx.slots.register({
      name: "conversation.message.images",
      priority: -1,
      locale: "conversation"
    }, StackedMessageImages));

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

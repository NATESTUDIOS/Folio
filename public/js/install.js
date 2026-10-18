// public/js/install.js
// ═══════════════════════════════════════════════════════════════════════
//  FOLIO — PWA Install
// ═══════════════════════════════════════════════════════════════════════

import { toast } from "./shared.js";

export const install = {
  deferredPrompt: null,
  registration: null,

  init () {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
    });

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", { scope: "/" })
        .then(reg => {
          this.registration = reg;
          reg.addEventListener("updatefound", () => {
            const newSW = reg.installing;
            if (!newSW) return;
            newSW.addEventListener("statechange", () => {
              if (newSW.state === "installed" && navigator.serviceWorker.controller) {
                this.showUpdateToast(newSW);
              }
            });
          });
        })
        .catch(err => {
          console.warn("[SW] register failed:", err?.message);
        });

      navigator.serviceWorker.addEventListener("message", (event) => {
        const data = event.data || {};
        if (data.type === "NOTIFICATION_CLICK") {
          window.dispatchEvent(new CustomEvent("folio:notification-click", { detail: data.payload }));
        }
      });
    }
  },

  showUpdateToast (newSW) {
    toast("New version available", {
      type: "info",
      duration: 8000,
      action: {
        label: "Reload",
        onClick: () => {
          newSW.postMessage({ type: "SKIP_WAITING" });
          navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
        },
      },
    });
  },

  async promptInstall () {
    if (this.deferredPrompt) {
      this.deferredPrompt.prompt();
      const result = await this.deferredPrompt.userChoice;
      this.deferredPrompt = null;
      if (result.outcome === "accepted") {
        toast("Installing Folio…", { type: "success" });
      }
      return;
    }
    if (window.matchMedia("(display-mode: standalone)").matches) {
      toast("Folio is already installed", { type: "info" });
      return;
    }
    toast("Tap your browser menu → Add to Home Screen", { type: "info", duration: 6000 });
  },

  async checkForUpdate () {
    if (!this.registration) {
      toast("Update check unavailable", { type: "warning" });
      return;
    }
    try {
      await this.registration.update();
      toast("Checked for updates", { type: "info" });
    } catch {
      toast("Couldn't check for updates", { type: "error" });
    }
  },

  isInstalled () {
    return window.matchMedia("(display-mode: standalone)").matches;
  },
};
"use client";

import { useEffect } from "react";
import { serviceWorkerToRegister } from "@/lib/sw-register";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    const plan = serviceWorkerToRegister(navigator, window.isSecureContext);
    if (plan) navigator.serviceWorker.register(plan.url, plan.options).catch(() => {});
  }, []);
  return null;
}

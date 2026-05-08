/**
 * ConnectionDoctorPanel.ts — Premium diagnostic dashboard.
 * PlayStation/Switch-quality with animated check results,
 * staggered reveal animations, and clear fix suggestions.
 */

import { createElement as make } from "../../ui/dom.js";
import { getLanemuService } from "../lanemu/LanemuSingleton.js";
import { LanemuConnectionDoctor } from "../lanemu/LanemuConnectionDoctor.js";

export function buildConnectionDoctorPanel(container: HTMLElement, opts: { roomId: string; onBack: () => void }): void {
  const service = getLanemuService();
  const doctor = new LanemuConnectionDoctor(service);

  const render = async () => {
    container.innerHTML = "";

    const panel = make("div", { class: "doctor-panel" });
    
    // ── Header ──
    const header = make("div", { class: "modal-header" });
    const btnBack = make("button", { class: "btn btn--ghost", style: "margin-right: 10px", "aria-label": "Go back" }, "←");
    btnBack.addEventListener("click", opts.onBack);
    header.append(btnBack, make("h3", { class: "modal-title" }, "Connection Doctor"));
    panel.appendChild(header);

    // ── Intro message ──
    const intro = make("p", { class: "doctor-intro" }, "Scanning your connection for issues…");
    panel.appendChild(intro);

    // ── Loading state ──
    const loadingWrap = make("div", { class: "doctor-loading" });
    loadingWrap.innerHTML = `<div class="spinner"></div><p style="color: var(--c-text-dim);">Running diagnostics…</p>`;
    panel.appendChild(loadingWrap);
    container.appendChild(panel);

    // ── Run checks ──
    const results = await doctor.runChecks({ roomId: opts.roomId });
    
    loadingWrap.remove();

    // Update intro based on results
    const failCount = results.filter(r => r.status === "fail").length;
    const warnCount = results.filter(r => r.status === "warn").length;

    if (failCount === 0 && warnCount === 0) {
      intro.textContent = "All checks passed! Your connection looks healthy.";
      intro.className = "doctor__intro--pass";
    } else if (failCount > 0) {
      intro.textContent = `${failCount} issue${failCount > 1 ? "s" : ""} found. Follow the fixes below to get connected.`;
      intro.className = "doctor__intro--fail";
    } else {
      intro.textContent = `${warnCount} warning${warnCount > 1 ? "s" : ""} detected. Your connection should work, but these may affect performance.`;
      intro.className = "doctor__intro--warn";
    }

    // ── Results list ──
    const resultsList = make("div", { class: "doctor-results", role: "list" });
    panel.appendChild(resultsList);

    for (const res of results) {
      const item = make("div", { class: `doctor-item doctor-item--${res.status}`, role: "listitem" });
      
      const statusIcon = res.status === "pass" ? "✓" : res.status === "warn" ? "!" : "✕";
      
      item.innerHTML = `
        <div class="doctor-item__header">
          <span class="doctor-item__status" aria-hidden="true">${statusIcon}</span>
          <strong class="doctor-item__label">${res.label}</strong>
        </div>
        <div class="doctor-item__message">${res.message}</div>
        ${res.fix ? `<div class="doctor-item__fix"><strong>Fix:</strong> ${res.fix}</div>` : ""}
      `;
      resultsList.appendChild(item);
    }

    // ── Retry button ──
    const actions = make("div", { class: "doctor-actions" });
    const btnRetry = make("button", { class: "btn btn--primary" }, "Run Checks Again");
    btnRetry.addEventListener("click", () => void render());
    actions.appendChild(btnRetry);
    panel.appendChild(actions);
  };

  void render();
}

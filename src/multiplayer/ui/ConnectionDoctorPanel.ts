import { createElement as make } from "../../ui/dom.js";
import { getLanemuService } from "../lanemu/LanemuSingleton.js";
import { LanemuConnectionDoctor } from "../lanemu/LanemuConnectionDoctor.js";

export function buildConnectionDoctorPanel(container: HTMLElement, opts: { roomId: string; onBack: () => void }): void {
  const service = getLanemuService();
  const doctor = new LanemuConnectionDoctor(service);

  const render = async () => {
    container.innerHTML = "";

    const panel = make("div", { class: "doctor-panel" });
    
    const header = make("div", { class: "modal-header" });
    const btnBack = make("button", { class: "btn btn--ghost", style: "margin-right: 10px", "aria-label": "Go back" }, "⬅");
    btnBack.addEventListener("click", opts.onBack);
    header.append(btnBack, make("h3", { class: "modal-title" }, "Connection Doctor"));
    panel.appendChild(header);

    const intro = make("p", { class: "doctor-intro" }, "Scanning your connection for issues...");
    panel.appendChild(intro);

    const loadingWrap = make("div", { class: "doctor-loading", style: "padding: 40px; text-align: center;" });
    loadingWrap.innerHTML = `<span class="spinner"></span><p style="margin-top: 10px; color: var(--c-text-dim);">Running diagnostics...</p>`;
    panel.appendChild(loadingWrap);
    container.appendChild(panel);

    const results = await doctor.runChecks({ roomId: opts.roomId });
    
    loadingWrap.remove();
    intro.textContent = results.every(r => r.status === "pass") 
      ? "All checks passed! Your connection looks healthy." 
      : "Some issues were detected. Check the fixes below.";

    const resultsList = make("div", { class: "doctor-results", role: "list" });
    panel.appendChild(resultsList);

    for (const res of results) {
      const item = make("div", { class: `doctor-item doctor-item--${res.status}`, role: "listitem" });
      item.innerHTML = `
        <div class="doctor-item__header">
          <span class="doctor-item__status" aria-hidden="true">${res.status === "pass" ? "✅" : res.status === "warn" ? "⚠️" : "❌"}</span>
          <strong class="doctor-item__label">${res.label}</strong>
        </div>
        <div class="doctor-item__message">${res.message}</div>
        ${res.fix ? `<div class="doctor-item__fix"><strong>Fix:</strong> ${res.fix}</div>` : ""}
      `;
      resultsList.appendChild(item);
    }

    const actions = make("div", { class: "doctor-actions", style: "margin-top: 20px" });
    const btnRetry = make("button", { class: "btn btn--primary" }, "Run Checks Again");
    btnRetry.addEventListener("click", () => void render());
    actions.appendChild(btnRetry);
    panel.appendChild(actions);
  };

  void render();
}

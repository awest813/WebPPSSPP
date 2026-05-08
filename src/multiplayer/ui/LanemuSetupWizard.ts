/**
 * LanemuSetupWizard.ts — Premium 2-step setup wizard.
 * PlayStation/Switch-quality with progress bar, animated step transitions,
 * and clear visual feedback.
 */

import { createElement as make } from "../../ui/dom.js";
import { getLanemuService } from "../lanemu/LanemuSingleton.js";
import type { LanemuStatus } from "../lanemu/LanemuStatus.js";

export function buildLanemuSetupWizard(container: HTMLElement, opts: { onBack: () => void }): void {
  const service = getLanemuService();
  container.innerHTML = "";

  const wizard = make("div", { class: "lanemu-wizard" });
  
  // ── Header ──
  const header = make("div", { class: "modal-header" });
  const btnBack = make("button", { class: "btn btn--ghost", style: "margin-right: 10px", "aria-label": "Go back" }, "←");
  btnBack.addEventListener("click", opts.onBack);
  header.append(btnBack, make("h3", { class: "modal-title" }, "RetroOasis LAN Setup"));
  wizard.appendChild(header);

  wizard.appendChild(make("p", { class: "wizard-intro" }, "We need a few tools to get your virtual network running. Follow the steps below to prepare your environment."));

  // ── Progress bar ──
  const progressBar = make("div", { class: "wizard-progress", "aria-label": "Setup progress" });
  const progressStep1 = make("div", { class: "wizard-progress__step wizard-progress__step--active" });
  const progressStep2 = make("div", { class: "wizard-progress__step" });
  progressBar.append(progressStep1, progressStep2);
  wizard.appendChild(progressBar);

  // ── Steps container ──
  const steps = make("div", { class: "wizard-steps" });

  // Step 1: Java Detection
  const step1 = make("div", { class: "wizard-step", "data-step": "1" });
  const s1Icon = make("div", { class: "step-status status--pending" }, "?");
  const s1Info = make("div", { class: "step-info" });
  s1Info.append(make("h4", {}, "Step 1: Check Java / OpenJDK"), make("p", { class: "step-text" }, "RetroOasis needs Java 17+ to run the LAN backend."));
  const btnDetectJava = make("button", { class: "btn btn--ghost btn--sm" }, "Detect Java");
  step1.append(s1Icon, s1Info, btnDetectJava);
  
  // Step 2: LANemu.jar
  const step2 = make("div", { class: "wizard-step", "data-step": "2" });
  const s2Icon = make("div", { class: "step-status status--pending" }, "?");
  const s2Info = make("div", { class: "step-info" });
  s2Info.append(make("h4", {}, "Step 2: Locate Lanemu.jar"), make("p", { class: "step-text" }, "Select your LANemu executable file."));
  const btnChooseJar = make("button", { class: "btn btn--ghost btn--sm" }, "Choose File");
  const fileInput = make("input", { type: "file", accept: ".jar", style: "display:none" }) as HTMLInputElement;
  step2.append(s2Icon, s2Info, btnChooseJar, fileInput);

  steps.append(step1, step2);
  wizard.appendChild(steps);

  // ── Footer with finish button ──
  const footer = make("div", { class: "wizard-footer" });
  const btnFinish = make("button", { class: "btn btn--primary", disabled: "true" }, "Finish Setup") as HTMLButtonElement;
  footer.appendChild(btnFinish);
  wizard.appendChild(footer);

  container.appendChild(wizard);

  // ── UI update handler ──
  const updateUI = (status: LanemuStatus) => {
    const s1Text = step1.querySelector(".step-text") as HTMLElement;
    const s2Text = step2.querySelector(".step-text") as HTMLElement;

    // Step 1: Java
    if (status.javaDetected) {
      s1Icon.textContent = "✓";
      s1Icon.className = "step-status status--success";
      s1Text.textContent = "Java 17+ detected and ready.";
      btnDetectJava.textContent = "Re-detect";
      step1.classList.add("wizard-step--success");
      step1.classList.remove("wizard-step--fail");
      progressStep1.classList.add("wizard-progress__step--complete");
      progressStep1.classList.remove("wizard-progress__step--active");
      progressStep2.classList.add("wizard-progress__step--active");
    } else {
      s1Icon.textContent = "!";
      s1Icon.className = "step-status status--fail";
      s1Text.textContent = "Java not found. Please install OpenJDK 17 or newer.";
      btnDetectJava.textContent = "Detect Java";
      step1.classList.add("wizard-step--fail");
      step1.classList.remove("wizard-step--success");
      progressStep1.classList.add("wizard-progress__step--active");
      progressStep1.classList.remove("wizard-progress__step--complete");
    }

    // Step 2: LANemu.jar
    if (status.lanemuJarDetected) {
      s2Icon.textContent = "✓";
      s2Icon.className = "step-status status--success";
      s2Text.textContent = "Lanemu.jar verified and linked.";
      btnChooseJar.textContent = "Change File";
      step2.classList.add("wizard-step--success");
      step2.classList.remove("wizard-step--fail");
      progressStep2.classList.add("wizard-progress__step--complete");
    } else {
      s2Icon.textContent = "!";
      s2Icon.className = "step-status status--fail";
      s2Text.textContent = "Lanemu.jar not found. Please select the executable.";
      btnChooseJar.textContent = "Choose File";
      step2.classList.add("wizard-step--fail");
      step2.classList.remove("wizard-step--success");
      progressStep2.classList.remove("wizard-progress__step--complete");
    }

    // Enable finish only when both steps pass
    btnFinish.disabled = !(status.javaDetected && status.lanemuJarDetected);
  };

  // ── Java detection handler ──
  btnDetectJava.addEventListener("click", async () => {
    btnDetectJava.disabled = true;
    btnDetectJava.textContent = "Checking…";
    try {
      const status = await service.validateSetup();
      updateUI(status);
    } finally {
      btnDetectJava.disabled = false;
    }
  });

  // ── JAR file selection handler ──
  btnChooseJar.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    if (!fileInput.files?.length) return;
    const status = await service.validateSetup();
    updateUI(status);
  });

  // ── Finish handler ──
  btnFinish.addEventListener("click", opts.onBack);

  // ── Initial check ──
  void service.getStatus().then(updateUI);
}

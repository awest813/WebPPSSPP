import { createElement as make } from "../../ui/dom.js";
import { getLanemuService } from "../lanemu/LanemuSingleton.js";
import type { LanemuStatus } from "../lanemu/LanemuStatus.js";

export function buildLanemuSetupWizard(container: HTMLElement, opts: { onBack: () => void }): void {
  const service = getLanemuService();
  container.innerHTML = "";

  const wizard = make("div", { class: "lanemu-wizard" });
  
  const header = make("div", { class: "modal-header" });
  const btnBack = make("button", { class: "btn btn--ghost", style: "margin-right: 10px", "aria-label": "Go back" }, "⬅");
  btnBack.addEventListener("click", opts.onBack);
  header.append(btnBack, make("h3", { class: "modal-title" }, "RetroOasis LAN Setup"));
  wizard.appendChild(header);

  wizard.appendChild(make("p", { class: "wizard-intro" }, "We need a few tools to get your virtual network running. Follow the steps below to prepare your environment."));

  const steps = make("div", { class: "wizard-steps" });

  // Step 1: Java Detection
  const step1 = make("div", { class: "wizard-step", "data-step": "1" });
  const s1Icon = make("div", { class: "step-status status--pending" }, "❓");
  const s1Info = make("div", { class: "step-info" });
  s1Info.append(make("h4", {}, "Step 1: Check Java / OpenJDK"), make("p", { class: "step-text" }, "RetroOasis needs Java 17+ to run the LAN backend."));
  const btnDetectJava = make("button", { class: "btn btn--secondary" }, "Detect Java");
  step1.append(s1Icon, s1Info, btnDetectJava);
  
  // Step 2: LANemu.jar
  const step2 = make("div", { class: "wizard-step", "data-step": "2" });
  const s2Icon = make("div", { class: "step-status status--pending" }, "❓");
  const s2Info = make("div", { class: "step-info" });
  s2Info.append(make("h4", {}, "Step 2: Locate Lanemu.jar"), make("p", { class: "step-text" }, "Select your LANemu executable file."));
  const btnChooseJar = make("button", { class: "btn btn--secondary" }, "Choose File");
  const fileInput = make("input", { type: "file", accept: ".jar", style: "display:none" }) as HTMLInputElement;
  step2.append(s2Icon, s2Info, btnChooseJar, fileInput);

  steps.append(step1, step2);
  wizard.appendChild(steps);

  const footer = make("div", { class: "wizard-footer" });
  const btnFinish = make("button", { class: "btn btn--primary", disabled: "true" }, "Finish Setup") as HTMLButtonElement;
  footer.appendChild(btnFinish);
  wizard.appendChild(footer);

  container.appendChild(wizard);

  const updateUI = (status: LanemuStatus) => {
    const s1Text = step1.querySelector(".step-text") as HTMLElement;
    const s2Text = step2.querySelector(".step-text") as HTMLElement;

    if (status.javaDetected) {
      s1Icon.textContent = "✅";
      s1Icon.className = "step-status status--success";
      s1Text.textContent = "Java 17+ detected and ready.";
      btnDetectJava.textContent = "Re-detect";
    } else {
      s1Icon.textContent = "❌";
      s1Icon.className = "step-status status--fail";
      s1Text.textContent = "Java not found. Please install OpenJDK 17 or newer.";
    }

    if (status.lanemuJarDetected) {
      s2Icon.textContent = "✅";
      s2Icon.className = "step-status status--success";
      s2Text.textContent = "Lanemu.jar verified and linked.";
      btnChooseJar.textContent = "Change File";
    } else {
      s2Icon.textContent = "❌";
      s2Icon.className = "step-status status--fail";
      s2Text.textContent = "Lanemu.jar not found. Please select the executable.";
    }

    btnFinish.disabled = !(status.javaDetected && status.lanemuJarDetected);
  };

  btnDetectJava.addEventListener("click", async () => {
    btnDetectJava.disabled = true;
    btnDetectJava.textContent = "Checking...";
    try {
      const status = await service.validateSetup();
      updateUI(status);
    } finally {
      btnDetectJava.disabled = false;
    }
  });

  btnChooseJar.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    if (!fileInput.files?.length) return;
    // In a real implementation, we might copy the file to a known location
    // or store the path. For now, we simulate detection update.
    const status = await service.validateSetup();
    updateUI(status);
  });

  btnFinish.addEventListener("click", opts.onBack);

  // Initial check
  void service.getStatus().then(updateUI);
}


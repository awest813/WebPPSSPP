import { createElement as make } from "../../ui/dom.js";
import { getLanemuService } from "../lanemu/LanemuSingleton.js";
import { store } from "../../store/index.js";

export function buildMultiplayerLaunchPanel(container: HTMLElement, opts: { mode: "host" | "join", onBack: () => void }): void {
  const service = getLanemuService();
  const session = store.get("session");
  const gameName = session.gameName || "Unknown Game";
  
  container.innerHTML = "";

  const panel = make("div", { class: "launch-panel" });
  
  const header = make("div", { class: "modal-header" });
  const btnBack = make("button", { class: "btn btn--ghost", style: "margin-right: 10px", "aria-label": "Go back" }, "⬅");
  btnBack.addEventListener("click", opts.onBack);
  header.append(btnBack, make("h3", { class: "modal-title" }, opts.mode === "host" ? "Host a Room" : "Join a Room"));
  panel.appendChild(header);

  const infoGrid = make("div", { class: "launch-info-grid" });
  const ipValue = make("span", { class: "launch-info__value" }, "Detecting…");
  
  infoGrid.appendChild(make("div", { class: "launch-info" }, 
    make("span", { class: "launch-info__label" }, "Game"),
    make("span", { class: "launch-info__value" }, gameName)
  ));
  
  const ipInfo = make("div", { class: "launch-info" });
  ipInfo.append(
    make("span", { class: "launch-info__label" }, "Virtual IP"),
    ipValue
  );
  infoGrid.appendChild(ipInfo);
  panel.appendChild(infoGrid);

  const instructions = make("div", { class: "launch-instructions" });
  const updateInstructions = (ip: string) => {
    if (opts.mode === "host") {
      instructions.innerHTML = `
        <h4>Host Instructions:</h4>
        <ul>
          <li>Enable WLAN/Ad Hoc in your emulator settings.</li>
          <li>Start the in-game lobby.</li>
          <li>Tell your friend your IP: <strong>${ip}</strong></li>
        </ul>
      `;
    } else {
      instructions.innerHTML = `
        <h4>Join Instructions:</h4>
        <ul>
          <li>Enter your friend's IP in the emulator's Pro Ad Hoc Server setting.</li>
          <li>Enable WLAN/Ad Hoc and join the in-game lobby.</li>
          <li>Your Virtual IP is: <strong>${ip}</strong></li>
        </ul>
      `;
    }
  };
  updateInstructions("—");
  panel.appendChild(instructions);

  const actions = make("div", { class: "launch-actions" });
  const btnTest = make("button", { class: "btn btn--secondary" }, "Test Connection");
  const btnStart = make("button", { class: "btn btn--primary" }, opts.mode === "host" ? "Start LANemu" : "Join Room");
  actions.append(btnTest, btnStart);
  panel.appendChild(actions);

  // Access File for Join mode
  let accessFilePath: string | undefined;
  if (opts.mode === "join") {
    const accessWrap = make("div", { class: "access-file-wrap", style: "margin-top: 20px;" });
    const accessLabel = make("p", { class: "settings-help" }, "Joining a room requires an access file (.dat) from the host.");
    const accessInput = make("input", { type: "file", accept: ".dat", style: "display:none" }) as HTMLInputElement;
    const accessBtn = make("button", { class: "btn btn--outline" }, "📂 Select Access File");
    const accessStatus = make("span", { style: "margin-left: 10px; font-size: 0.9rem; color: var(--c-text-dim);" }, "No file selected");
    
    accessBtn.addEventListener("click", () => accessInput.click());
    accessInput.addEventListener("change", () => {
      const file = accessInput.files?.[0];
      if (file) {
        accessFilePath = file.name; // In a real app, we'd need the full path or to copy it to a known location
        accessStatus.textContent = file.name;
        accessStatus.style.color = "var(--c-accent)";
      }
    });

    accessWrap.append(accessLabel, accessBtn, accessInput, accessStatus);
    panel.insertBefore(accessWrap, instructions);
  }

  container.appendChild(panel);

  // Status handling
  void service.getStatus().then(status => {
    if (status.virtualIp) {
      ipValue.textContent = status.virtualIp;
      updateInstructions(status.virtualIp);
    } else {
      ipValue.textContent = "Offline";
    }

    if (status.running) {
      btnStart.textContent = opts.mode === "host" ? "Stop LANemu" : "Leave Room";
      btnStart.classList.replace("btn--primary", "btn--danger");
    }
  });

  btnStart.addEventListener("click", async () => {
    const status = await service.getStatus();
    if (status.running) {
      await service.stop();
      btnStart.textContent = opts.mode === "host" ? "Start LANemu" : "Join Room";
      btnStart.classList.replace("btn--danger", "btn--primary");
    } else {
      if (opts.mode === "join" && !accessFilePath) {
        alert("Please select an access file (.dat) to join a room.");
        return;
      }
      try {
        await service.start({ 
          playerName: store.get("settings").netplayUsername || "RetroOasisPlayer",
          accessFilePath: accessFilePath 
        });
        const newStatus = await service.getStatus();
        if (newStatus.virtualIp) {
          ipValue.textContent = newStatus.virtualIp;
          updateInstructions(newStatus.virtualIp);
        }
        btnStart.textContent = opts.mode === "host" ? "Stop LANemu" : "Leave Room";
        btnStart.classList.replace("btn--primary", "btn--danger");
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err));
      }
    }
  });

  btnTest.addEventListener("click", () => {
    void import("./ConnectionDoctorPanel.js").then(({ buildConnectionDoctorPanel }) => {
      buildConnectionDoctorPanel(container, { roomId: "current-room", onBack: () => buildMultiplayerLaunchPanel(container, opts) });
    });
  });
}


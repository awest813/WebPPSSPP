import type { PSPEmulator } from "../emulator.js";

export function createDebugConsoleController(opts: { onToggleDevOverlay: () => void }) {
  let wired = false;
  let visible = false;
  let position: { x: number; y: number } = (() => {
    try {
      const saved = localStorage.getItem("rv_debug_console_pos");
      return saved ? (JSON.parse(saved) as { x: number; y: number }) : { x: 20, y: 80 };
    } catch {
      return { x: 20, y: 80 };
    }
  })();
  let lastLoggedEventCount = 0;

  function toggle(emulator?: PSPEmulator): void {
    const consoleEl = document.getElementById("debug-console");
    if (!consoleEl) return;

    visible = !visible;
    consoleEl.hidden = !visible;

    if (visible) {
      consoleEl.style.left = `${position.x}px`;
      consoleEl.style.top = `${position.y}px`;

      if (!wired && emulator) {
        wire(emulator);
      }
      document.getElementById("debug-console-input")?.focus();
      if (emulator) update(emulator);
    }
  }

  function wire(emulator: PSPEmulator): void {
    if (wired) return;
    wired = true;

    const handle = document.getElementById("debug-console-handle");
    const consoleEl = document.getElementById("debug-console");
    const closeBtn = document.getElementById("debug-console-close");
    const clearBtn = document.getElementById("debug-console-clear");
    const input = document.getElementById("debug-console-input") as HTMLInputElement | null;

    if (handle && consoleEl) {
      let isDragging = false;
      let startX = 0;
      let startY = 0;

      handle.addEventListener("mousedown", (e) => {
        isDragging = true;
        startX = e.clientX - consoleEl.offsetLeft;
        startY = e.clientY - consoleEl.offsetTop;
        handle.style.cursor = "grabbing";
      });

      window.addEventListener("mousemove", (e) => {
        if (!isDragging) return;
        const x = e.clientX - startX;
        const y = e.clientY - startY;
        consoleEl.style.left = `${x}px`;
        consoleEl.style.top = `${y}px`;
        position = { x, y };
        localStorage.setItem("rv_debug_console_pos", JSON.stringify(position));
      });

      window.addEventListener("mouseup", () => {
        isDragging = false;
        handle.style.cursor = "grab";
      });
    }

    closeBtn?.addEventListener("click", () => toggle());
    clearBtn?.addEventListener("click", () => {
      emulator.clearDiagnosticLog();
      const logEl = document.getElementById("debug-console-log");
      if (logEl) logEl.innerHTML = "";
      lastLoggedEventCount = 0;
    });

    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const cmd = input.value.trim();
        if (cmd) {
          runCommand(cmd, emulator);
          input.value = "";
        }
      }
      e.stopPropagation();
    });
  }

  function runCommand(cmd: string, emulator: PSPEmulator): void {
    const parts = cmd.toLowerCase().split(" ");
    const action = parts[0];

    emulator.logDiagnostic("system", `> ${cmd}`);

    switch (action) {
      case "help":
        emulator.logDiagnostic("system", "Available commands: help, reset, pause, resume, step, stats, log [on|off], clear, close");
        break;
      case "reset":
        emulator.reset();
        break;
      case "pause":
        emulator.pause();
        break;
      case "resume":
        emulator.resume();
        break;
      case "step":
        emulator.pause();
        setTimeout(() => emulator.resume(), 16);
        setTimeout(() => emulator.pause(), 32);
        break;
      case "stats":
        opts.onToggleDevOverlay();
        break;
      case "log":
        if (parts[1] === "on" || parts[1] === "verbose") {
          emulator.verboseLogging = true;
          emulator.logDiagnostic("system", "Verbose logging enabled.");
        } else {
          emulator.verboseLogging = false;
          emulator.logDiagnostic("system", "Verbose logging disabled.");
        }
        break;
      case "clear": {
        emulator.clearDiagnosticLog();
        const logEl = document.getElementById("debug-console-log");
        if (logEl) logEl.innerHTML = "";
        lastLoggedEventCount = 0;
        break;
      }
      case "close":
        toggle();
        break;
      default:
        emulator.logDiagnostic("error", `Unknown command: ${cmd}`);
        break;
    }

    update(emulator);
  }

  function update(emulator: PSPEmulator): void {
    const logEl = document.getElementById("debug-console-log");
    if (!logEl) return;

    const logs = emulator.diagnosticLog;
    if (logs.length === lastLoggedEventCount) return;

    const fragment = document.createDocumentFragment();
    for (const event of logs.slice(lastLoggedEventCount)) {
      const row = document.createElement("div");
      row.className = `debug-console-entry debug-console-entry--${event.category}`;
      const ts = new Date(event.timestamp).toLocaleTimeString();
      row.textContent = `[${ts}] ${event.message}`;
      fragment.appendChild(row);
    }
    logEl.appendChild(fragment);
    logEl.scrollTop = logEl.scrollHeight;
    lastLoggedEventCount = logs.length;
  }

  return { toggle, update };
}

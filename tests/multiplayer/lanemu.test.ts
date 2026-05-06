import { describe, it, expect, vi, beforeEach } from "vitest";
import { LanemuService } from "../../src/multiplayer/lanemu/LanemuService";
import { DEFAULT_LANEMU_SETTINGS } from "../../src/multiplayer/lanemu/LanemuSettings";

describe("LanemuService", () => {
  let mockLauncher: any;
  let mockNetwork: any;

  beforeEach(() => {
    mockLauncher = {
      spawn: vi.fn().mockResolvedValue(1234),
      kill: vi.fn().mockResolvedValue(undefined),
      isProcessRunning: vi.fn().mockResolvedValue(true),
      exists: vi.fn().mockResolvedValue(true),
      validateJava: vi.fn().mockResolvedValue(true),
    };

    mockNetwork = {
      getInterfaces: vi.fn().mockResolvedValue([
        { address: "10.6.10.10", family: "IPv4", internal: false, name: "lanemu0", netmask: "255.255.0.0" }
      ]),
      ping: vi.fn().mockResolvedValue(true),
      checkTcpPort: vi.fn().mockResolvedValue(true),
    };
  });

  it("should detect virtual IP when running", async () => {
    const service = new LanemuService(DEFAULT_LANEMU_SETTINGS, mockLauncher, mockNetwork);
    
    // Start the service
    await service.start({ playerName: "Tester" });
    
    // Check status
    const status = await service.getStatus();
    
    expect(mockLauncher.spawn).toHaveBeenCalled();
    expect(status.running).toBe(true);
    expect(status.virtualIp).toBe("10.6.10.10");
  });

  it("should format start arguments correctly", async () => {
    const service = new LanemuService(DEFAULT_LANEMU_SETTINGS, mockLauncher, mockNetwork);
    await service.start({ playerName: "Alice", port: 3000 });

    expect(mockLauncher.spawn).toHaveBeenCalledWith(
      "java",
      ["-jar", "./tools/lanemu/Lanemu.jar", "--headless", "--name=Alice", "--port=3000"],
      expect.anything()
    );
  });
});

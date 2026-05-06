/**
 * LanemuConnectionDoctor.ts — Diagnostic tool for troubleshooting LANemu connections.
 */

import { LanemuService } from "./LanemuService.js";

export interface LanemuConnectionDoctorInput {
  roomId:      string;
  hostIp?:     string;
  friendIp?:    string;
  gamePort?:   number;
  emulatorId?: string;
}

export interface ConnectionCheckResult {
  id:      string;
  label:   string;
  status:  "pass" | "warn" | "fail";
  message: string;
  fix?:    string;
}

export class LanemuConnectionDoctor {
  private _service: LanemuService;

  constructor(service: LanemuService) {
    this._service = service;
  }

  async runChecks(input: LanemuConnectionDoctorInput): Promise<ConnectionCheckResult[]> {
    const results: ConnectionCheckResult[] = [];
    const status = await this._service.getStatus();

    // 1. Java check
    results.push({
      id: "java",
      label: "Java / OpenJDK",
      status: status.javaDetected ? "pass" : "fail",
      message: status.javaDetected ? "Java detected." : "Java not found.",
      fix: "Install OpenJDK 17 or newer.",
    });

    // 2. LANemu Jar check
    results.push({
      id: "jar",
      label: "LANemu Executable",
      status: status.lanemuJarDetected ? "pass" : "fail",
      message: status.lanemuJarDetected ? "Lanemu.jar detected." : "Lanemu.jar not found.",
      fix: "Ensure Lanemu.jar is in your tools folder.",
    });

    // 3. Process check
    results.push({
      id: "running",
      label: "LANemu Process",
      status: status.running ? "pass" : "fail",
      message: status.running ? "LANemu is running." : "LANemu is stopped.",
      fix: "Click 'Start LANemu' to activate the virtual network.",
    });

    // 4. Virtual IP check
    results.push({
      id: "vip",
      label: "Virtual IP Address",
      status: status.virtualIp ? "pass" : "fail",
      message: status.virtualIp ? `Your virtual IP: ${status.virtualIp}` : "No virtual IP detected.",
      fix: "Allow LANemu through your system firewall.",
    });

    // 5. Friend reachability (if IP provided)
    if (input.friendIp) {
      const alive = await this._service.ping(input.friendIp);
      results.push({
        id: "friend",
        label: "Friend Connectivity",
        status: alive ? "pass" : "fail",
        message: alive ? `Reached friend at ${input.friendIp}.` : `Could not reach friend at ${input.friendIp}.`,
        fix: alive ? undefined : "Ensure your friend has joined the same room and their firewall is not blocking LANemu.",
      });
    }

    return results;
  }
}
